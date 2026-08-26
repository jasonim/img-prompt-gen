import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createApplication } from '../../server/app.js'
import { createClientProof, createServerProof } from '../../server/pairing.js'

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`
const PROTOCOL = '1'

async function startTestServer(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prompt-server-'))
  const application = await createApplication({ dataDir: path.join(root, 'data'), logger: () => {} })
  const server = createServer(application.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`
  const secret = await application.pairing.reset()

  async function pair() {
    const challengeResponse = await fetch(`${baseUrl}/api/pair/challenge`, { headers: { Origin: ORIGIN } })
    const challengeBody = await challengeResponse.json()
    const challenge = challengeBody.data
    const proof = createClientProof(secret, challenge.nonce, ORIGIN, challenge.protocol)
    const completeResponse = await fetch(`${baseUrl}/api/pair/complete`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: challenge.nonce, proof })
    })
    const completeBody = await completeResponse.json()
    assert.equal(completeResponse.status, 200)
    assert.equal(
      completeBody.data.serverProof,
      createServerProof(secret, challenge.nonce, completeBody.data.token, ORIGIN, challenge.protocol)
    )
    return completeBody.data.token
  }

  function headers(token, origin = ORIGIN) {
    return {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      'X-Img-Prompt-Protocol': PROTOCOL,
      'Content-Type': 'application/json'
    }
  }

  return { application, baseUrl, pair, headers, secret }
}

test('explicit extension origin supports Chrome requests that omit the Origin header', async (t) => {
  const server = await startTestServer(t)
  const extensionHeaders = { 'X-Img-Prompt-Extension-Origin': ORIGIN }
  const challengeResponse = await fetch(`${server.baseUrl}/api/pair/challenge`, { headers: extensionHeaders })
  const challengeBody = await challengeResponse.json()
  assert.equal(challengeResponse.status, 200)

  const challenge = challengeBody.data
  const proof = createClientProof(server.secret, challenge.nonce, ORIGIN, challenge.protocol)
  const completeResponse = await fetch(`${server.baseUrl}/api/pair/complete`, {
    method: 'POST',
    headers: { ...extensionHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: challenge.nonce, proof })
  })
  const completeBody = await completeResponse.json()
  assert.equal(completeResponse.status, 200)

  const healthResponse = await fetch(`${server.baseUrl}/health`, {
    headers: {
      ...extensionHeaders,
      Authorization: `Bearer ${completeBody.data.token}`,
      'X-Img-Prompt-Protocol': PROTOCOL
    }
  })
  assert.equal(healthResponse.status, 200)

  const spoofed = await fetch(`${server.baseUrl}/api/pair/challenge`, {
    headers: { Origin: 'https://example.com', ...extensionHeaders }
  })
  assert.equal(spoofed.status, 403)
})

test('health hides counts until a client completes pairing', async (t) => {
  const server = await startTestServer(t)
  const anonymous = await fetch(`${server.baseUrl}/health`, { headers: { Origin: ORIGIN } })
  const anonymousBody = await anonymous.json()
  assert.equal(anonymous.status, 200)
  assert.equal(anonymousBody.data.service, 'img-prompt-gen')
  assert.equal('counts' in anonymousBody.data, false)

  const token = await server.pair()
  const authenticated = await fetch(`${server.baseUrl}/health`, { headers: server.headers(token) })
  const body = await authenticated.json()
  assert.equal(authenticated.status, 200)
  assert.equal(body.data.status, 'ok')
  assert.equal(body.data.counts.captures, 0)
  assert.equal(body.data.sourceRevision, 0)
})

test('capture writes are authenticated, idempotent, exact, and conflict on ID reuse', async (t) => {
  const server = await startTestServer(t)
  const token = await server.pair()
  const capture = {
    id: 'cap_22222222-2222-4222-8222-222222222222',
    text: '  近距离高位斜俯拍  ',
    capturedAt: '2026-08-22T03:00:00.000Z',
    sourceType: 'browser_selection'
  }

  const unauthorized = await fetch(`${server.baseUrl}/api/captures`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(capture)
  })
  assert.equal(unauthorized.status, 401)

  const first = await fetch(`${server.baseUrl}/api/captures`, {
    method: 'POST', headers: server.headers(token), body: JSON.stringify(capture)
  })
  assert.equal(first.status, 201)
  const firstBody = await first.json()
  assert.equal(firstBody.data.capture.text, capture.text)

  const duplicate = await fetch(`${server.baseUrl}/api/captures`, {
    method: 'POST', headers: server.headers(token), body: JSON.stringify(capture)
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).data.deduplicated, true)

  const conflict = await fetch(`${server.baseUrl}/api/captures`, {
    method: 'POST',
    headers: server.headers(token),
    body: JSON.stringify({ ...capture, text: '另一段文字' })
  })
  assert.equal(conflict.status, 409)

  const workbench = await fetch(`${server.baseUrl}/api/workbench`, { headers: server.headers(token) })
  const workbenchBody = await workbench.json()
  assert.equal(workbenchBody.data.captures.length, 1)
  assert.equal(workbenchBody.data.captures[0].text, capture.text)
})

test('paired token is bound to the extension origin', async (t) => {
  const server = await startTestServer(t)
  const token = await server.pair()
  const response = await fetch(`${server.baseUrl}/api/library`, {
    headers: server.headers(token, `chrome-extension://${'b'.repeat(32)}`)
  })
  assert.equal(response.status, 403)
})

test('organizing, reviewing, and reading runtime forms a traceable workflow', async (t) => {
  const server = await startTestServer(t)
  const token = await server.pair()
  const captureId = 'cap_33333333-3333-4333-8333-333333333333'
  const termId = 'term_33333333-3333-4333-8333-333333333333'
  const recipeId = 'recipe_33333333-3333-4333-8333-333333333333'
  await fetch(`${server.baseUrl}/api/captures`, {
    method: 'POST',
    headers: server.headers(token),
    body: JSON.stringify({
      id: captureId,
      text: '近距离高位斜俯拍，俯卧床面。',
      capturedAt: '2026-08-22T03:00:00.000Z',
      sourceType: 'browser_selection'
    })
  })
  const health = await (await fetch(`${server.baseUrl}/health`, { headers: server.headers(token) })).json()

  const organize = await fetch(`${server.baseUrl}/api/captures/${captureId}/organize`, {
    method: 'POST',
    headers: server.headers(token),
    body: JSON.stringify({
      expectedRevision: health.data.sourceRevision,
      terms: [{ id: termId, name: '近距离高位斜俯拍', category: 'camera', responsibility: 'camera_angle' }],
      recipe: {
        id: recipeId,
        name: '高位俯拍人像',
        termIds: [termId],
        derivedPrompt: '近距离高位斜俯拍，俯卧床面。'
      }
    })
  })
  assert.equal(organize.status, 200)
  const organizeBody = await organize.json()

  const pendingLibrary = await (await fetch(`${server.baseUrl}/api/library`, { headers: server.headers(token) })).json()
  assert.equal(pendingLibrary.data.terms.length, 0)

  const review = await fetch(`${server.baseUrl}/api/terms/${termId}/review`, {
    method: 'POST',
    headers: server.headers(token),
    body: JSON.stringify({ expectedRevision: organizeBody.data.sourceRevision, decision: 'approved' })
  })
  assert.equal(review.status, 200)

  const library = await (await fetch(`${server.baseUrl}/api/library`, { headers: server.headers(token) })).json()
  assert.equal(library.data.terms.length, 1)
  assert.equal(library.data.terms[0].id, termId)

  const deleteReferenced = await fetch(`${server.baseUrl}/api/terms/${termId}`, {
    method: 'DELETE',
    headers: server.headers(token),
    body: JSON.stringify({ expectedRevision: library.data.sourceRevision })
  })
  assert.equal(deleteReferenced.status, 409)
})
