import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')

async function collectJavaScript(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectJavaScript(absolute))
    else if (entry.name.endsWith('.js')) files.push(absolute)
  }
  return files
}

const files = []
for (const directory of ['server', 'extension', 'scripts']) files.push(...await collectJavaScript(path.join(root, directory)))
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${path.relative(root, file)} syntax failed:\n${result.stderr}`)
}

for (const relativePath of ['package.json', 'extension/manifest.json', 'data/terms.json', 'data/recipes.json', 'data/prompts.json', 'data/runtime/library.json']) {
  JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
}

const [html, sidepanelScript] = await Promise.all([
  readFile(path.join(root, 'extension/sidepanel.html'), 'utf8'),
  readFile(path.join(root, 'extension/sidepanel.js'), 'utf8')
])
if (/\son\w+=/i.test(html)) throw new Error('Inline event handlers are forbidden in sidepanel.html')
if (/\.innerHTML\s*=/.test(sidepanelScript)) throw new Error('innerHTML assignment is forbidden in sidepanel.js')
console.log(`syntax ok: ${files.length} JavaScript files and 6 JSON files`)
