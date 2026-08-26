import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { StorageRepository, parseCaptures } from '../../server/storage.js'
import { makeCapture } from '../helpers/fixtures.js'

async function tempDataDir() {
  const root = await mkdtemp(path.join(tmpdir(), 'prompt-library-'))
  return path.join(root, 'data')
}

test('repository initializes a coherent revision-zero snapshot', async () => {
  const dataDir = await tempDataDir()
  const repository = new StorageRepository({ dataDir })
  await repository.initialize()
  const snapshot = await repository.readSnapshot()

  assert.equal(snapshot.revision, 0)
  assert.deepEqual(snapshot.state.terms, [])
  assert.equal(snapshot.runtime.sourceRevision, 0)
})

test('transactions persist all source files and runtime at one revision', async () => {
  const dataDir = await tempDataDir()
  const repository = new StorageRepository({ dataDir })
  await repository.initialize()

  await repository.transaction((draft) => {
    draft.captures.push(makeCapture())
    return { savedId: draft.captures[0].id }
  })

  const snapshot = await repository.readSnapshot()
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.state.captures.length, 1)
  assert.equal(snapshot.runtime.sourceRevision, 1)
  assert.equal((await readFile(path.join(dataDir, 'CURRENT'), 'utf8')).trim(), '1')
})

test('a later repository rolls forward an interrupted multi-file commit', async () => {
  const dataDir = await tempDataDir()
  const crashing = new StorageRepository({ dataDir, failAfterReplace: 2 })
  await crashing.initialize()

  await assert.rejects(
    crashing.transaction((draft) => {
      draft.captures.push(makeCapture())
    }),
    /simulated crash/
  )

  const recovered = new StorageRepository({ dataDir })
  await recovered.initialize()
  const snapshot = await recovered.readSnapshot()
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.state.captures.length, 1)
  assert.equal(snapshot.runtime.sourceRevision, 1)
})

test('JSONL parser rejects truncated tail records', () => {
  assert.throws(
    () => parseCaptures('{"recordType":"meta","schemaVersion":1,"revision":0}\n{"recordType":"capture"'),
    /line 2/
  )
})

test('recompile is a true no-op when runtime already matches source content', async () => {
  const dataDir = await tempDataDir()
  const repository = new StorageRepository({ dataDir })
  await repository.initialize()
  const result = await repository.recompile()
  assert.equal(result.changed, false)
  assert.equal(result.revision, 0)
})

test('JSONL parser rejects invalid metadata and record types', () => {
  assert.throws(() => parseCaptures('{"recordType":"capture","schemaVersion":1,"revision":0}\n'), /metadata/)
  assert.throws(() => parseCaptures('{"recordType":"meta","schemaVersion":1,"revision":0}\n{"recordType":"other"}\n'), /record type/)
})

test('initialization hardens all source and runtime files to owner-only permissions', async () => {
  const dataDir = await tempDataDir()
  const repository = new StorageRepository({ dataDir })
  await repository.initialize()
  const termsPath = path.join(dataDir, 'terms.json')
  await chmod(termsPath, 0o644)
  await new StorageRepository({ dataDir }).initialize()
  assert.equal((await stat(termsPath)).mode & 0o777, 0o600)
})
