import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildReleaseStaging } from '../../scripts/package-release.js'

const root = path.resolve(import.meta.dirname, '../..')

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative))
    else files.push(relative)
  }
  return files.sort()
}

async function readPngSize(file) {
  const png = await readFile(file)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

test('local release is an unpack-and-load extension with no Node service or personal data', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'zhiju-release-'))
  const release = await buildReleaseStaging({ rootDir: root, outDir, generatedAt: '2026-08-22T00:00:00.000Z' })

  await access(path.join(release.localDir, 'extension/manifest.json'))
  await access(path.join(release.localDir, '安装说明.md'))

  const files = await listFiles(release.localDir)
  assert.equal(files.some((file) => file.startsWith('server') || file.startsWith('data') || file === 'package.json'), false)
  assert.equal(files.some((file) => /启动服务|pairing|\.secrets|\.txn|\.revision\.lock/.test(file)), false)
})

test('web store staging has manifest at ZIP root and contains extension code only', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'zhiju-store-'))
  const release = await buildReleaseStaging({ rootDir: root, outDir, generatedAt: '2026-08-22T00:00:00.000Z' })
  const files = await listFiles(release.storeDir)

  assert.equal(files.includes('manifest.json'), true)
  assert.equal(files.includes('icons/icon-128.png'), true)
  assert.equal(files.some((file) => file.startsWith('server') || file.startsWith('data') || file === 'package.json'), false)
  assert.equal(files.some((file) => file.endsWith('.pem') || file.endsWith('.key')), false)
})

test('release metadata is deterministic apart from the injected build time', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'zhiju-metadata-'))
  const release = await buildReleaseStaging({ rootDir: root, outDir, generatedAt: '2026-08-22T00:00:00.000Z' })
  const metadata = JSON.parse(await readFile(path.join(release.localDir, 'release-manifest.json'), 'utf8'))

  assert.equal(metadata.version, '0.1.0')
  assert.equal(metadata.generatedAt, '2026-08-22T00:00:00.000Z')
  assert.equal(metadata.containsUserData, false)
  assert.equal(metadata.requiresNode, false)
  assert.equal(metadata.storage, 'IndexedDB')
})

test('store assets include correctly sized mandatory artwork', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'zhiju-artwork-'))
  const release = await buildReleaseStaging({ rootDir: root, outDir, generatedAt: '2026-08-22T00:00:00.000Z' })

  assert.deepEqual(await readPngSize(path.join(release.assetsDir, 'store-icon-128.png')), { width: 128, height: 128 })
  assert.deepEqual(await readPngSize(path.join(release.assetsDir, 'screenshot-library-1280x800.png')), { width: 1280, height: 800 })
  assert.deepEqual(await readPngSize(path.join(release.assetsDir, 'promo-small-440x280.png')), { width: 440, height: 280 })
})
