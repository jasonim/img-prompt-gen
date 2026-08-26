import test from 'node:test'
import assert from 'node:assert/strict'

import { createUsageTracker } from '../../extension/lib/usage-model.js'

function memoryStorage(initial = {}) {
  let state = structuredClone(initial)
  return {
    async get(key) { return { [key]: state[key] } },
    async set(update) { state = { ...state, ...update } },
    inspect() { return structuredClone(state) }
  }
}

test('copy usage starts at zero and persists per library entry', async () => {
  const storage = memoryStorage()
  const usage = createUsageTracker(storage)

  assert.equal(await usage.count('prompt_1'), 0)
  assert.equal(await usage.increment('prompt_1'), 1)
  assert.equal(await usage.increment('prompt_1'), 2)
  assert.equal(await usage.count('prompt_1'), 2)
  assert.deepEqual(await usage.all(), { prompt_1: 2 })
})

test('malformed local counters are ignored instead of reaching the UI', async () => {
  const storage = memoryStorage({ entryUsageCounts: { prompt_1: -1, prompt_2: 'many', prompt_3: 3 } })
  const usage = createUsageTracker(storage)
  assert.deepEqual(await usage.all(), { prompt_3: 3 })
})
