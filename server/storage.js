import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'

import { compileLibrary } from './compiler.js'
import { SCHEMA_VERSION, assertValidState, refreshMachineReviews } from './schemas.js'

const SOURCE_FILES = Object.freeze({
  captures: 'captures.jsonl',
  terms: 'terms.json',
  recipes: 'recipes.json',
  prompts: 'prompts.json',
  runtime: 'runtime/library.json'
})

const LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 20
const NO_COMMIT = Symbol('no_commit')

export function noCommit(value) {
  return { [NO_COMMIT]: true, value }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function createInitialState() {
  return { captures: [], terms: [], recipes: [], prompts: [] }
}

export function serializeCaptures(captures, revision) {
  const records = [
    { recordType: 'meta', schemaVersion: SCHEMA_VERSION, revision },
    ...captures
  ]
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

export function parseCaptures(content) {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('captures.jsonl is empty')
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid captures.jsonl line ${index + 1}: ${error.message}`)
    }
  })
  const [meta, ...captures] = records
  if (meta.recordType !== 'meta' || meta.schemaVersion !== SCHEMA_VERSION || !Number.isInteger(meta.revision)) {
    throw new Error('Invalid captures.jsonl metadata')
  }
  if (captures.some((capture) => capture.recordType !== 'capture')) throw new Error('Invalid captures.jsonl record type')
  return { revision: meta.revision, captures }
}

async function writeDurable(filePath, content, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const handle = await open(filePath, 'w', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAtomic(filePath, content, mode = 0o600) {
  const temporary = `${filePath}.next-${randomUUID()}`
  await writeDurable(temporary, content, mode)
  await rename(temporary, filePath)
}

async function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export class StorageRepository {
  constructor({ dataDir, failAfterReplace = null, now = () => new Date() }) {
    this.dataDir = dataDir
    this.failAfterReplace = failAfterReplace
    this.now = now
    this.lockPath = path.join(dataDir, '.revision.lock')
    this.txnRoot = path.join(dataDir, '.txn')
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.txnRoot, { recursive: true })
    return this.#withLock(async () => {
      await this.#recoverTransactionsUnlocked()
      try {
        await readFile(path.join(this.dataDir, 'CURRENT'), 'utf8')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        const state = createInitialState()
        const runtime = compileLibrary(state, { revision: 0, generatedAt: null })
        const transactionDir = await this.#stageTransactionUnlocked(state, runtime, 0)
        await this.#applyTransactionUnlocked(transactionDir, false)
      }
      await this.#hardenPermissionsUnlocked()
      return this.#readSnapshotUnlocked()
    })
  }

  async readSnapshot() {
    return this.#withLock(async () => {
      await this.#recoverTransactionsUnlocked()
      return this.#readSnapshotUnlocked()
    })
  }

  async transaction(mutator) {
    return this.#withLock(async () => {
      await this.#recoverTransactionsUnlocked()
      const current = await this.#readSnapshotUnlocked()
      const draft = structuredClone(current.state)
      const result = await mutator(draft, current)
      if (result?.[NO_COMMIT]) {
        return { result: result.value, revision: current.revision, runtime: current.runtime, changed: false }
      }
      const checkedAt = this.now().toISOString()
      refreshMachineReviews(draft, checkedAt)
      assertValidState(draft)
      const revision = current.revision + 1
      const runtime = compileLibrary(draft, { revision, generatedAt: checkedAt })
      const transactionDir = await this.#stageTransactionUnlocked(draft, runtime, revision)
      await this.#applyTransactionUnlocked(transactionDir, true)
      return { result, revision, runtime, changed: true }
    })
  }

  async recompile() {
    return this.#withLock(async () => {
      await this.#recoverTransactionsUnlocked()
      const current = await this.#readSnapshotUnlocked()
      assertValidState(current.state)
      const runtime = compileLibrary(current.state, {
        revision: current.revision,
        generatedAt: this.now().toISOString()
      })
      if (runtime.sourceContentHash === current.runtime.sourceContentHash) {
        return { changed: false, revision: current.revision, runtime: current.runtime }
      }
      const transactionDir = await this.#stageTransactionUnlocked(current.state, runtime, current.revision)
      await this.#applyTransactionUnlocked(transactionDir, true)
      return { changed: true, revision: current.revision, runtime }
    })
  }

  async #withLock(callback) {
    const handle = await this.#acquireLock()
    try {
      return await callback()
    } finally {
      await handle.close().catch(() => {})
      await unlink(this.lockPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  async #acquireLock() {
    const startedAt = Date.now()
    while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
        await handle.sync()
        return handle
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try {
          const lock = JSON.parse(await readFile(this.lockPath, 'utf8'))
          const age = Date.now() - Date.parse(lock.createdAt)
          if (!(await processIsAlive(lock.pid)) && age > 500) {
            await unlink(this.lockPath)
            continue
          }
        } catch (readError) {
          if (readError.code === 'ENOENT') continue
        }
        await sleep(LOCK_RETRY_MS)
      }
    }
    const error = new Error('Timed out waiting for data revision lock')
    error.code = 'data_locked'
    error.statusCode = 503
    throw error
  }

  async #readSnapshotUnlocked() {
    const revision = Number.parseInt((await readFile(path.join(this.dataDir, 'CURRENT'), 'utf8')).trim(), 10)
    if (!Number.isInteger(revision) || revision < 0) throw new Error('Invalid CURRENT revision')
    const capturesFile = parseCaptures(await readFile(path.join(this.dataDir, SOURCE_FILES.captures), 'utf8'))
    const [termsFile, recipesFile, promptsFile, runtime] = await Promise.all([
      this.#readJson(SOURCE_FILES.terms),
      this.#readJson(SOURCE_FILES.recipes),
      this.#readJson(SOURCE_FILES.prompts),
      this.#readJson(SOURCE_FILES.runtime)
    ])
    for (const [name, fileRevision] of [
      ['captures', capturesFile.revision],
      ['terms', termsFile.revision],
      ['recipes', recipesFile.revision],
      ['prompts', promptsFile.revision],
      ['runtime', runtime.sourceRevision]
    ]) {
      if (fileRevision !== revision) throw new Error(`${name} revision ${fileRevision} does not match CURRENT ${revision}`)
    }
    const state = {
      captures: capturesFile.captures,
      terms: termsFile.terms,
      recipes: recipesFile.recipes,
      prompts: promptsFile.prompts
    }
    assertValidState(state)
    const expectedRuntime = compileLibrary(state, { revision, generatedAt: runtime.generatedAt })
    if (runtime.sourceContentHash !== expectedRuntime.sourceContentHash) throw new Error('runtime source content hash is stale')
    return { revision, state, runtime }
  }

  async #readJson(relativePath) {
    const value = JSON.parse(await readFile(path.join(this.dataDir, relativePath), 'utf8'))
    if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported schema in ${relativePath}`)
    return value
  }

  async #hardenPermissionsUnlocked() {
    const files = ['CURRENT', ...Object.values(SOURCE_FILES)]
    for (const relativePath of files) await chmod(path.join(this.dataDir, relativePath), 0o600)
    await chmod(this.txnRoot, 0o700)
    await chmod(path.join(this.dataDir, '.secrets'), 0o700).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  async #stageTransactionUnlocked(state, runtime, revision) {
    const transactionId = `${revision}-${randomUUID()}`
    const transactionDir = path.join(this.txnRoot, transactionId)
    const newRoot = path.join(transactionDir, 'new')
    await mkdir(newRoot, { recursive: true })
    const files = [
      [SOURCE_FILES.captures, serializeCaptures(state.captures, revision)],
      [SOURCE_FILES.terms, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision, terms: state.terms }, null, 2)}\n`],
      [SOURCE_FILES.recipes, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision, recipes: state.recipes }, null, 2)}\n`],
      [SOURCE_FILES.prompts, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision, prompts: state.prompts }, null, 2)}\n`],
      [SOURCE_FILES.runtime, `${JSON.stringify(runtime, null, 2)}\n`]
    ]
    for (const [relativePath, content] of files) {
      await writeDurable(path.join(newRoot, relativePath), content)
    }
    await writeDurable(path.join(transactionDir, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      revision,
      files: files.map(([relativePath]) => relativePath)
    }, null, 2)}\n`)
    return transactionDir
  }

  async #applyTransactionUnlocked(transactionDir, allowFailure) {
    const manifest = JSON.parse(await readFile(path.join(transactionDir, 'manifest.json'), 'utf8'))
    let replacements = 0
    for (const relativePath of manifest.files) {
      const source = path.join(transactionDir, 'new', relativePath)
      const destination = path.join(this.dataDir, relativePath)
      await mkdir(path.dirname(destination), { recursive: true })
      const nextPath = `${destination}.txn-${manifest.transactionId}`
      await copyFile(source, nextPath)
      const handle = await open(nextPath, 'r')
      await handle.sync()
      await handle.close()
      await rename(nextPath, destination)
      replacements += 1
      if (allowFailure && this.failAfterReplace === replacements) {
        throw new Error(`simulated crash after replace ${replacements}`)
      }
    }
    await writeAtomic(path.join(this.dataDir, 'CURRENT'), `${manifest.revision}\n`)
    await rm(transactionDir, { recursive: true, force: true })
  }

  async #recoverTransactionsUnlocked() {
    let entries = []
    try {
      entries = await readdir(this.txnRoot, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return
    }
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    for (const directory of directories) {
      const transactionDir = path.join(this.txnRoot, directory)
      try {
        await stat(path.join(transactionDir, 'manifest.json'))
        await this.#applyTransactionUnlocked(transactionDir, false)
      } catch (error) {
        if (error.code === 'ENOENT') await rm(transactionDir, { recursive: true, force: true })
        else throw error
      }
    }
  }
}
