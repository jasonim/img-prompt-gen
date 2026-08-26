export const QUEUE_KEY = 'captureQueue'
export const LAST_CAPTURE_STATUS_KEY = 'lastCaptureStatus'
export const MAX_CAPTURE_BYTES = 48 * 1024

const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000
const RECEIPT_LIMIT = 200

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength
}

function normalizeError(error) {
  return {
    code: error?.code ?? 'sync_failed',
    message: error?.message ?? '同步失败',
    nextAction: error?.nextAction ?? '启动本地服务后重试'
  }
}

async function readQueue(storage) {
  const queue = (await storage.get(QUEUE_KEY))[QUEUE_KEY]
  return Array.isArray(queue) ? queue : []
}

function pruneReceipts(queue, now) {
  const threshold = now.getTime() - RECEIPT_TTL_MS
  const pending = queue.filter((item) => item.state !== 'synced')
  const receipts = queue
    .filter((item) => item.state === 'synced' && Date.parse(item.syncedAt) >= threshold)
    .sort((left, right) => Date.parse(right.syncedAt) - Date.parse(left.syncedAt))
    .slice(0, RECEIPT_LIMIT)
  return [...pending, ...receipts]
}

export function createQueueManager({
  storage = globalThis.chrome?.storage?.local,
  api,
  now = () => new Date(),
  randomUUID = () => globalThis.crypto.randomUUID()
} = {}) {
  if (!storage || !api) throw new TypeError('storage and api are required')
  let drainPromise = null

  async function persist(queue, status = null) {
    const update = { [QUEUE_KEY]: pruneReceipts(queue, now()) }
    if (status) update[LAST_CAPTURE_STATUS_KEY] = status
    await storage.set(update)
  }

  async function enqueueSelection(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      const result = { status: 'empty', message: '内容为空，没有保存' }
      await storage.set({ [LAST_CAPTURE_STATUS_KEY]: result }).catch(() => {})
      return result
    }
    if (byteLength(text) > MAX_CAPTURE_BYTES) {
      const result = { status: 'too_large', message: '内容超过 48 KiB，未保存' }
      await storage.set({ [LAST_CAPTURE_STATUS_KEY]: result }).catch(() => {})
      return result
    }
    const timestamp = now().toISOString()
    const item = {
      id: `cap_${randomUUID()}`,
      text,
      capturedAt: timestamp,
      sourceType: 'browser_selection',
      state: 'queued',
      attemptId: null,
      attempts: 0,
      updatedAt: timestamp,
      lastError: null
    }
    try {
      const queue = await readQueue(storage)
      queue.push(item)
      await persist(queue, { status: 'queued', id: item.id, message: '已在浏览器本地暂存，正在同步' })
    } catch {
      return { status: 'storage_failed', message: '浏览器暂存失败，内容未发送' }
    }
    return { status: 'queued', id: item.id, message: '已在浏览器本地暂存，正在同步' }
  }

  async function doDrain() {
    let queue = await readQueue(storage)
    queue = queue.map((item) => item.state === 'syncing'
      ? { ...item, state: 'queued', attemptId: null, updatedAt: now().toISOString() }
      : item)
    await persist(queue)

    for (const candidate of queue.filter((item) => item.state === 'queued' || item.state === 'failed')) {
      const attemptId = randomUUID()
      queue = await readQueue(storage)
      const index = queue.findIndex((item) => item.id === candidate.id)
      if (index < 0 || queue[index].state === 'synced') continue
      queue[index] = {
        ...queue[index],
        state: 'syncing',
        attemptId,
        attempts: (queue[index].attempts ?? 0) + 1,
        updatedAt: now().toISOString(),
        lastError: null
      }
      await persist(queue, { status: 'syncing', id: candidate.id, message: '正在写入本地词库' })
      try {
        await api.createCapture({
          id: candidate.id,
          text: candidate.text,
          capturedAt: candidate.capturedAt,
          sourceType: candidate.sourceType
        })
        queue = await readQueue(storage)
        const currentIndex = queue.findIndex((item) => item.id === candidate.id)
        if (currentIndex >= 0 && queue[currentIndex].attemptId === attemptId) {
          queue[currentIndex] = {
            id: candidate.id,
            state: 'synced',
            attempts: queue[currentIndex].attempts,
            syncedAt: now().toISOString(),
            updatedAt: now().toISOString()
          }
          await persist(queue, { status: 'synced', id: candidate.id, message: '已同步到本地词库' })
        }
      } catch (error) {
        queue = await readQueue(storage)
        const currentIndex = queue.findIndex((item) => item.id === candidate.id)
        if (currentIndex >= 0 && queue[currentIndex].attemptId === attemptId) {
          queue[currentIndex] = {
            ...queue[currentIndex],
            state: 'failed',
            attemptId: null,
            updatedAt: now().toISOString(),
            lastError: normalizeError(error)
          }
          await persist(queue, { status: 'failed', id: candidate.id, message: error?.message ?? '同步失败，内容仍在本地暂存' })
        }
      }
    }
    return readQueue(storage)
  }

  function drain() {
    if (!drainPromise) drainPromise = doDrain().finally(() => { drainPromise = null })
    return drainPromise
  }

  return {
    enqueueSelection,
    drain,
    list: () => readQueue(storage),
    async clearReceipt(id) {
      const queue = (await readQueue(storage)).filter((item) => !(item.id === id && item.state === 'synced'))
      await persist(queue)
    },
    async removePending(id) {
      const queue = (await readQueue(storage)).filter((item) => item.id !== id)
      await persist(queue, { status: 'removed', id, message: '已删除本地暂存内容' })
    }
  }
}
