import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createApiClient,
  createBrowserClientProof,
  createBrowserServerProof
} from '../../extension/lib/api-client.js'

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`
const SECRET = 'test-pairing-secret'

function memoryStorage() {
  let state = {}
  return {
    async get(key) { return { [key]: state[key] } },
    async set(update) { state = { ...state, ...update } },
    async remove(key) { delete state[key] },
    inspect() { return structuredClone(state) }
  }
}

test('pair verifies server proof before persisting the token', async () => {
  const storage = memoryStorage()
  const nonce = 'challenge-nonce'
  const token = 'bearer-token'
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers?.['X-Img-Prompt-Extension-Origin'], ORIGIN)
    if (url.endsWith('/challenge')) return Response.json({ ok: true, data: { nonce, protocol: '1', serviceId: 'service-1' } })
    const request = JSON.parse(options.body)
    assert.equal(request.proof, await createBrowserClientProof(SECRET, nonce, ORIGIN, '1'))
    return Response.json({ ok: true, data: {
      token,
      protocol: '1',
      serviceId: 'service-1',
      serverProof: await createBrowserServerProof(SECRET, nonce, token, ORIGIN, '1')
    } })
  }
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:43119', storage, fetchImpl, origin: ORIGIN })
  const result = await client.pair(SECRET)
  assert.equal(result.token, token)
  assert.equal(storage.inspect().servicePairing.token, token)
})

test('pair rejects a forged server proof and stores nothing', async () => {
  const storage = memoryStorage()
  const fetchImpl = async (url) => url.endsWith('/challenge')
    ? Response.json({ ok: true, data: { nonce: 'nonce', protocol: '1', serviceId: 'service-1' } })
    : Response.json({ ok: true, data: { token: 'token', protocol: '1', serviceId: 'service-1', serverProof: 'forged' } })
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:43119', storage, fetchImpl, origin: ORIGIN })
  await assert.rejects(client.pair(SECRET), (error) => error.code === 'invalid_server_proof')
  assert.equal(storage.inspect().servicePairing, undefined)
})

test('authenticated requests clear a revoked token and expose next action', async () => {
  const storage = memoryStorage()
  await storage.set({ servicePairing: { token: 'old', protocol: '1' } })
  const fetchImpl = async () => Response.json({
    ok: false,
    error: { code: 'invalid_token', message: '配对 Token 无效', nextAction: '重新配对' }
  }, { status: 401 })
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:43119', storage, fetchImpl, origin: ORIGIN })
  await assert.rejects(client.getLibrary(), (error) => error.code === 'invalid_token' && error.nextAction === '重新配对')
  assert.equal(storage.inspect().servicePairing, undefined)
})

test('all API method wrappers preserve paths, verbs, and JSON bodies', async () => {
  const storage = memoryStorage()
  await storage.set({ servicePairing: { token: 'token', protocol: '1' } })
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    return Response.json({ ok: true, data: { sourceRevision: 1 } })
  }
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:43119', storage, fetchImpl, origin: ORIGIN })
  assert.equal(await client.isPaired(), true)
  await client.health()
  await client.getLibrary()
  await client.getWorkbench()
  await client.getCollection('terms')
  await client.createCapture({ id: 'cap_1' })
  await client.createEntity('terms', { id: 'term_1' })
  await client.updateEntity('terms', 'term_1', { name: 'x' })
  await client.deleteEntity('terms', 'term_1', { expectedRevision: 1 })
  await client.deleteCapture('cap_1', { expectedRevision: 1 })
  await client.organizeCapture('cap_1', { terms: [] })
  await client.reviewEntity('terms', 'term_1', { decision: 'approved' })
  await client.exportSources()
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'GET', 'GET', 'POST', 'POST', 'PATCH', 'DELETE', 'DELETE', 'POST', 'POST', 'GET'])
  assert.equal(calls[6].url.endsWith('/api/terms/term_1'), true)
  await client.clearPairing()
  assert.equal(await client.isPaired(), false)
})

test('network failures are normalized for pairing and authenticated reads', async () => {
  const storage = memoryStorage()
  const offline = createApiClient({
    baseUrl: 'http://127.0.0.1:43119', storage, origin: ORIGIN,
    fetchImpl: async () => { throw new Error('network') }
  })
  await assert.rejects(offline.pair(SECRET), (error) => error.code === 'offline')
  await storage.set({ servicePairing: { token: 'token', protocol: '1' } })
  await assert.rejects(offline.getLibrary(), (error) => error.code === 'offline')
})
