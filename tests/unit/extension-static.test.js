import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')

test('manifest is MV3, Chrome 116+, and needs no localhost access', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.minimum_chrome_version, '116')
  assert.deepEqual(manifest.permissions.sort(), ['clipboardWrite', 'contextMenus', 'sidePanel', 'storage'].sort())
  assert.equal('host_permissions' in manifest, false)
})

test('side panel avoids inline handlers and unsafe HTML rendering', async () => {
  const [html, script] = await Promise.all([
    readFile(path.join(root, 'extension/sidepanel.html'), 'utf8'),
    readFile(path.join(root, 'extension/sidepanel.js'), 'utf8')
  ])
  assert.doesNotMatch(html, /\son\w+=/i)
  assert.doesNotMatch(script, /\.innerHTML\s*=/)
  assert.doesNotMatch(html, /配对|npm start|43119/)
  assert.doesNotMatch(script, /createApiClient|isPaired|showPairing/)
  assert.match(script, /createIndexedDbClient/)
  for (const id of ['app-shell', 'library-view', 'workbench-view', 'queue-view', 'editor-view']) {
    assert.match(html, new RegExp(`id=["']${id}["']`))
  }
})

test('narrow side panel explicitly prevents horizontal clipping', async () => {
  const css = await readFile(path.join(root, 'extension/sidepanel.css'), 'utf8')
  assert.match(css, /overflow-x:\s*hidden/)
  assert.doesNotMatch(css, /\.pairing-panel\s*\{/)
  assert.match(css, /\.masthead\s*>\s*div\s*\{[^}]*min-width:\s*0/s)
})

test('library uses the compact collector card anatomy from the visual reference', async () => {
  const [html, css, script] = await Promise.all([
    readFile(path.join(root, 'extension/sidepanel.html'), 'utf8'),
    readFile(path.join(root, 'extension/sidepanel.css'), 'utf8'),
    readFile(path.join(root, 'extension/sidepanel.js'), 'utf8')
  ])
  assert.match(html, /生图词库收录器/)
  assert.match(html, /id=["']copy-toast["']/)
  assert.match(css, /\.entry-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s)
  assert.match(css, /\.entry-body\s*\{[^}]*-webkit-line-clamp:\s*2/s)
  assert.match(script, /entry-usage/)
})
