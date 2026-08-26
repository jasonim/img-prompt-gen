export const USAGE_COUNTS_KEY = 'entryUsageCounts'

function sanitizeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, count]) => Number.isSafeInteger(count) && count >= 0))
}

export function createUsageTracker(storage = globalThis.chrome?.storage?.local) {
  if (!storage) throw new TypeError('storage adapter is required')

  async function all() {
    const stored = (await storage.get(USAGE_COUNTS_KEY))[USAGE_COUNTS_KEY]
    return sanitizeCounts(stored)
  }

  return {
    all,
    async count(id) {
      return (await all())[id] ?? 0
    },
    async increment(id) {
      if (typeof id !== 'string' || !id) throw new TypeError('entry id is required')
      const counts = await all()
      counts[id] = (counts[id] ?? 0) + 1
      await storage.set({ [USAGE_COUNTS_KEY]: counts })
      return counts[id]
    }
  }
}
