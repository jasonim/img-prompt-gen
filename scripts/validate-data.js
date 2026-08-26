import path from 'node:path'

import { StorageRepository } from '../server/storage.js'
import { validateState } from '../server/schemas.js'

const dataDir = path.resolve(import.meta.dirname, '../data')
const repository = new StorageRepository({ dataDir })
await repository.initialize()
const snapshot = await repository.readSnapshot()
const report = validateState(snapshot.state)
if (!report.valid) {
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({
    ok: true,
    revision: snapshot.revision,
    captures: snapshot.state.captures.length,
    terms: snapshot.state.terms.length,
    recipes: snapshot.state.recipes.length,
    prompts: snapshot.state.prompts.length,
    machinePassed: report.machinePassed,
    humanApproved: report.humanApproved
  }, null, 2))
}
