import test from 'node:test'
import assert from 'node:assert/strict'

import { createQueueManager } from '../../extension/lib/capture-queue.js'

function memoryStorage(initial = {}) {
  let state = structuredClone(initial)
  return {
    async get(key) {
      return { [key]: structuredClone(state[key]) }
    },
    async set(update) {
      state = { ...state, ...structuredClone(update) }
    },
    inspect() {
      return structuredClone(state)
    }
  }
}

test('blank selections are rejected without touching storage or network', async () => {
  const storage = memoryStorage()
  let calls = 0
  const queue = createQueueManager({ storage, api: { createCapture: async () => { calls += 1 } } })
  const result = await queue.enqueueSelection(' \n ')
  assert.equal(result.status, 'empty')
  assert.equal(calls, 0)
  assert.equal(storage.inspect().captureQueue, undefined)
})

test('exact selected text is persisted before network synchronization', async () => {
  const storage = memoryStorage()
  const seen = []
  const queue = createQueueManager({
    storage,
    api: { createCapture: async (capture) => seen.push(capture) },
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    now: () => new Date('2026-08-22T04:00:00.000Z')
  })

  const original = '  近距离高位斜俯拍  '
  const queued = await queue.enqueueSelection(original)
  assert.equal(queued.status, 'queued')
  assert.equal(storage.inspect().captureQueue[0].text, original)

  await queue.drain()
  assert.equal(seen[0].text, original)
  const receipt = storage.inspect().captureQueue[0]
  assert.equal(receipt.state, 'synced')
  assert.equal('text' in receipt, false)
})

test('storage failure prevents a network write', async () => {
  const storage = { get: async () => ({ captureQueue: [] }), set: async () => { throw new Error('quota') } }
  let calls = 0
  const queue = createQueueManager({ storage, api: { createCapture: async () => { calls += 1 } } })
  const result = await queue.enqueueSelection('有效文字')
  assert.equal(result.status, 'storage_failed')
  assert.equal(calls, 0)
})

test('stale syncing entries recover and concurrent drains are single-flight', async () => {
  const storage = memoryStorage({
    captureQueue: [{
      id: 'cap_11111111-1111-4111-8111-111111111111',
      text: '俯卧床面',
      capturedAt: '2026-08-22T04:00:00.000Z',
      sourceType: 'browser_selection',
      state: 'syncing',
      attemptId: 'old',
      attempts: 1,
      updatedAt: '2026-08-22T04:00:00.000Z'
    }]
  })
  let calls = 0
  const queue = createQueueManager({
    storage,
    api: { createCapture: async () => { calls += 1 } },
    now: () => new Date('2026-08-22T05:00:00.000Z')
  })

  await Promise.all([queue.drain(), queue.drain(), queue.drain()])
  assert.equal(calls, 1)
  assert.equal(storage.inspect().captureQueue[0].state, 'synced')
})

test('failed synchronization preserves original text for a later retry', async () => {
  const storage = memoryStorage()
  let shouldFail = true
  const queue = createQueueManager({
    storage,
    api: { createCapture: async () => { if (shouldFail) throw Object.assign(new Error('offline'), { code: 'offline' }) } },
    randomUUID: () => '11111111-1111-4111-8111-111111111111'
  })
  await queue.enqueueSelection('窗边局部高曝光')
  await queue.drain()
  assert.equal(storage.inspect().captureQueue[0].state, 'failed')
  assert.equal(storage.inspect().captureQueue[0].text, '窗边局部高曝光')

  shouldFail = false
  await queue.drain()
  assert.equal(storage.inspect().captureQueue[0].state, 'synced')
  assert.equal('text' in storage.inspect().captureQueue[0], false)
})

test('oversized selections are rejected and queue entries can be removed', async () => {
  const storage = memoryStorage()
  const queue = createQueueManager({ storage, api: { createCapture: async () => {} } })
  const oversized = await queue.enqueueSelection('图'.repeat(17_000))
  assert.equal(oversized.status, 'too_large')

  await storage.set({ captureQueue: [
    { id: 'cap_pending', text: '原文', state: 'failed' },
    { id: 'cap_done', state: 'synced', syncedAt: new Date().toISOString() }
  ] })
  await queue.removePending('cap_pending')
  await queue.clearReceipt('cap_done')
  assert.deepEqual(storage.inspect().captureQueue, [])
})
