import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const required = [
  'AGENTS.md',
  'README.md',
  'docs/data-contract.md',
  'docs/organizing-protocol.md',
  'extension/manifest.json',
  'extension/service-worker.js',
  'extension/sidepanel.html',
  'extension/sidepanel.js',
  'extension/lib/indexeddb-client.js',
  'release/安装说明.md',
  'release/隐私说明.md',
  'store-assets/PRIVACY_POLICY.zh-CN.md',
  'store-assets/STORE_LISTING.zh-CN.md',
  'store-assets/TEST_INSTRUCTIONS.zh-CN.md'
]

for (const relativePath of required) await access(path.join(root, relativePath))
JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'))
console.log(`contracts ok: ${required.length} required files`)
