import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const required = [
  'AGENTS.md',
  'README.md',
  'docs/data-contract.md',
  'docs/organizing-protocol.md',
  'data/CURRENT',
  'data/captures.jsonl',
  'data/terms.json',
  'data/recipes.json',
  'data/prompts.json',
  'data/runtime/library.json'
]

for (const relativePath of required) await access(path.join(root, relativePath))
for (const relativePath of ['terms.json', 'recipes.json', 'prompts.json', 'runtime/library.json']) {
  JSON.parse(await readFile(path.join(root, 'data', relativePath), 'utf8'))
}
console.log(`contracts ok: ${required.length} required files`)
