import path from 'node:path'

import { StorageRepository } from '../server/storage.js'

const repository = new StorageRepository({ dataDir: path.resolve(import.meta.dirname, '../data') })
await repository.initialize()
const result = await repository.recompile()
console.log(JSON.stringify({ ok: true, changed: result.changed, revision: result.revision, counts: result.runtime.counts }, null, 2))
