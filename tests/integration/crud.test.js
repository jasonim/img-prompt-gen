import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createApplication } from '../../server/app.js'
import { createClientProof } from '../../server/pairing.js'

const ORIGIN = `chrome-extension://${'c'.repeat(32)}`

async function startApi(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prompt-crud-'))
  const application = await createApplication({ dataDir: path.join(root, 'data'), logger: () => {} })
  const server = createServer(application.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const secret = await application.pairing.reset()
  const challenge = (await (await fetch(`${baseUrl}/api/pair/challenge`, { headers: { Origin: ORIGIN } })).json()).data
  const completed = await (await fetch(`${baseUrl}/api/pair/complete`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: challenge.nonce, proof: createClientProof(secret, challenge.nonce, ORIGIN, challenge.protocol) })
  })).json()
  const authHeaders = {
    Origin: ORIGIN,
    Authorization: `Bearer ${completed.data.token}`,
    'X-Img-Prompt-Protocol': '1'
  }
  async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...authHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    return { response, payload: response.status === 204 ? null : await response.json() }
  }
  return { baseUrl, authHeaders, request }
}

test('term, recipe, and prompt CRUD publish and delete through guarded revisions', async (t) => {
  const api = await startApi(t)
  let revision = 0
  const termId = 'term_44444444-4444-4444-8444-444444444444'
  const recipeId = 'recipe_44444444-4444-4444-8444-444444444444'
  const promptId = 'prompt_44444444-4444-4444-8444-444444444444'

  let result = await api.request('/api/terms', {
    method: 'POST',
    body: { id: termId, expectedRevision: revision, name: '窗边局部高曝光', category: 'lighting', responsibility: 'exposure' }
  })
  assert.equal(result.response.status, 201)
  revision = result.payload.data.sourceRevision

  result = await api.request(`/api/terms/${termId}`, {
    method: 'PATCH',
    body: { expectedRevision: revision, name: '窗侧局部高曝光' }
  })
  assert.equal(result.response.status, 200)
  revision = result.payload.data.sourceRevision

  result = await api.request(`/api/terms/${termId}/review`, { method: 'POST', body: { expectedRevision: revision, decision: 'approved' } })
  revision = result.payload.data.sourceRevision

  result = await api.request('/api/recipes', {
    method: 'POST',
    body: { id: recipeId, expectedRevision: revision, name: '窗光人像', termIds: [termId], derivedPrompt: '窗侧局部高曝光。' }
  })
  revision = result.payload.data.sourceRevision
  result = await api.request(`/api/recipes/${recipeId}/review`, { method: 'POST', body: { expectedRevision: revision, decision: 'approved' } })
  revision = result.payload.data.sourceRevision

  result = await api.request('/api/prompts', {
    method: 'POST',
    body: { id: promptId, expectedRevision: revision, title: '常用写真指令', text: '写实生活方式人像。' }
  })
  revision = result.payload.data.sourceRevision
  result = await api.request(`/api/prompts/${promptId}/review`, { method: 'POST', body: { expectedRevision: revision, decision: 'approved' } })
  revision = result.payload.data.sourceRevision

  const library = await api.request('/api/library')
  assert.equal(library.payload.data.terms.length, 1)
  assert.equal(library.payload.data.recipes.length, 1)
  assert.equal(library.payload.data.prompts.length, 1)

  const sourceTerms = await api.request('/api/terms')
  assert.equal(sourceTerms.payload.data.items[0].review.human.status, 'approved')
  const sourceRecipes = await api.request('/api/recipes')
  const sourcePrompts = await api.request('/api/prompts')
  assert.equal(sourceRecipes.payload.data.items.length, 1)
  assert.equal(sourcePrompts.payload.data.items.length, 1)

  const blockedDelete = await api.request(`/api/terms/${termId}`, { method: 'DELETE', body: { expectedRevision: revision } })
  assert.equal(blockedDelete.response.status, 409)

  result = await api.request(`/api/recipes/${recipeId}`, { method: 'DELETE', body: { expectedRevision: revision } })
  revision = result.payload.data.sourceRevision
  result = await api.request(`/api/prompts/${promptId}`, { method: 'DELETE', body: { expectedRevision: revision } })
  revision = result.payload.data.sourceRevision
  result = await api.request(`/api/terms/${termId}`, { method: 'DELETE', body: { expectedRevision: revision } })
  assert.equal(result.response.status, 200)

  const exported = await api.request('/api/export')
  assert.equal(exported.payload.data.terms.length, 0)
  assert.equal('token' in exported.payload.data, false)
})

test('HTTP boundary rejects malformed, stale, oversized, and unknown requests', async (t) => {
  const api = await startApi(t)

  let result = await api.request('/api/captures', {
    method: 'POST',
    body: '{bad json',
    headers: { 'Content-Type': 'application/json' }
  })
  assert.equal(result.response.status, 400)

  const noContentType = await fetch(`${api.baseUrl}/api/captures`, {
    method: 'POST', headers: api.authHeaders, body: '{}'
  })
  assert.equal(noContentType.status, 415)

  const protocolMismatch = await fetch(`${api.baseUrl}/api/library`, {
    headers: { ...api.authHeaders, 'X-Img-Prompt-Protocol': '99' }
  })
  assert.equal(protocolMismatch.status, 426)

  result = await api.request('/api/terms', {
    method: 'POST',
    body: { id: 'term_bad', expectedRevision: 99, name: '测试', category: 'other', responsibility: 'other' }
  })
  assert.equal(result.response.status, 409)

  result = await api.request('/api/captures', {
    method: 'POST',
    body: JSON.stringify({ padding: 'x'.repeat(70_000) }),
    headers: { 'Content-Type': 'application/json' }
  })
  assert.equal(result.response.status, 413)

  result = await api.request('/api/not-found')
  assert.equal(result.response.status, 404)

  const preflight = await fetch(`${api.baseUrl}/api/library`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' }
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN)
})

test('capture listing, deletion, and review-needs-revision routes are reachable', async (t) => {
  const api = await startApi(t)
  const captureId = 'cap_55555555-5555-4555-8555-555555555555'
  let result = await api.request('/api/captures', {
    method: 'POST',
    body: { id: captureId, text: '安静轻倦意', capturedAt: '2026-08-22T06:00:00.000Z', sourceType: 'browser_selection' }
  })
  let revision = result.payload.data.sourceRevision
  result = await api.request('/api/captures?status=pending_review')
  assert.equal(result.payload.data.items.length, 1)

  const termId = 'term_55555555-5555-4555-8555-555555555555'
  result = await api.request('/api/terms', {
    method: 'POST',
    body: { id: termId, expectedRevision: revision, name: '安静轻倦意', category: 'emotion', responsibility: 'emotion', sourceCaptureIds: [captureId] }
  })
  revision = result.payload.data.sourceRevision
  result = await api.request(`/api/terms/${termId}/review`, { method: 'POST', body: { expectedRevision: revision, decision: 'needs_revision' } })
  assert.equal(result.payload.data.entity.review.human.status, 'needs_revision')

  const blocked = await api.request(`/api/captures/${captureId}`, { method: 'DELETE', body: { expectedRevision: result.payload.data.sourceRevision } })
  assert.equal(blocked.response.status, 409)
  result = await api.request(`/api/terms/${termId}`, { method: 'DELETE', body: { expectedRevision: result.payload.data.sourceRevision } })
  result = await api.request(`/api/captures/${captureId}`, { method: 'DELETE', body: { expectedRevision: result.payload.data.sourceRevision } })
  assert.equal(result.response.status, 200)
})
