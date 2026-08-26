import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(scriptPath), '..')

const LOCAL_DIRECTORIES = ['extension']
const LOCAL_FILES = [
  'release/安装说明.md',
  'release/隐私说明.md'
]

async function copyInto(sourceRoot, targetRoot, relativePath) {
  const source = path.join(sourceRoot, relativePath)
  const targetName = relativePath.startsWith('release/') ? path.basename(relativePath) : relativePath
  const target = path.join(targetRoot, targetName)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })
}

async function assertCleanRelease(directory) {
  const forbidden = new Set(['.secrets', '.txn', '.revision.lock'])
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (forbidden.has(entry.name) || entry.name.endsWith('.pem') || entry.name.endsWith('.key')) {
        throw new Error(`release contains forbidden path: ${path.join(current, entry.name)}`)
      }
      if (entry.isDirectory()) await walk(path.join(current, entry.name))
    }
  }
  await walk(directory)
}

export async function buildReleaseStaging({ rootDir = defaultRoot, outDir = path.join(defaultRoot, 'dist'), generatedAt = new Date().toISOString() } = {}) {
  const sourcePackage = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))
  const localName = `zhiju-prompt-collector-v${sourcePackage.version}`
  const storeName = `zhiju-web-store-v${sourcePackage.version}`
  const localDir = path.join(outDir, localName)
  const storeDir = path.join(outDir, storeName)
  const assetsDir = path.join(outDir, `zhiju-store-assets-v${sourcePackage.version}`)

  await Promise.all([localDir, storeDir, assetsDir].map((directory) => rm(directory, { recursive: true, force: true })))
  await Promise.all([localDir, storeDir, assetsDir].map((directory) => mkdir(directory, { recursive: true })))

  for (const directory of LOCAL_DIRECTORIES) await copyInto(rootDir, localDir, directory)
  for (const file of LOCAL_FILES) await copyInto(rootDir, localDir, file)

  await writeFile(path.join(localDir, 'release-manifest.json'), `${JSON.stringify({
    name: '枝句 · 生图词库收录器',
    version: sourcePackage.version,
    generatedAt,
    containsUserData: false,
    requiresNode: false,
    storage: 'IndexedDB',
    extensionDirectory: 'extension'
  }, null, 2)}\n`)

  await cp(path.join(rootDir, 'extension'), storeDir, { recursive: true })
  await cp(path.join(rootDir, 'store-assets'), assetsDir, { recursive: true })
  await Promise.all([localDir, storeDir].map(assertCleanRelease))

  return { version: sourcePackage.version, localName, storeName, localDir, storeDir, assetsDir }
}

export async function buildReleaseArchives(options = {}) {
  const rootDir = options.rootDir ?? defaultRoot
  const outDir = options.outDir ?? path.join(rootDir, 'dist')
  const release = await buildReleaseStaging({ ...options, rootDir, outDir })
  const localZip = path.join(outDir, `${release.localName}.zip`)
  const storeZip = path.join(outDir, `${release.storeName}.zip`)
  await Promise.all([localZip, storeZip].map((file) => rm(file, { force: true })))
  await execFileAsync('/usr/bin/zip', ['-qry', localZip, release.localName], { cwd: outDir })
  await execFileAsync('/usr/bin/zip', ['-qry', storeZip, '.'], { cwd: release.storeDir })
  return { ...release, localZip, storeZip }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = await buildReleaseArchives()
  console.log(JSON.stringify({
    ok: true,
    version: result.version,
    localZip: result.localZip,
    storeZip: result.storeZip,
    assetsDir: result.assetsDir
  }, null, 2))
}
