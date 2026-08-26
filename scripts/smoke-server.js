import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createApplication } from '../server/app.js'
import { createClientProof, createServerProof } from '../server/pairing.js'

const origin = `chrome-extension://${'a'.repeat(32)}`
const root = await mkdtemp(path.join(tmpdir(), 'img-prompt-smoke-'))
const application = await createApplication({ dataDir: path.join(root, 'data'), logger: () => {} })
const server = createServer(application.handler)

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`
  const secret = await application.pairing.reset()
  const challengeResponse = await fetch(`${baseUrl}/api/pair/challenge`, { headers: { Origin: origin } })
  const challenge = (await challengeResponse.json()).data
  const proof = createClientProof(secret, challenge.nonce, origin, challenge.protocol)
  const completeResponse = await fetch(`${baseUrl}/api/pair/complete`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: challenge.nonce, proof })
  })
  const completed = (await completeResponse.json()).data
  if (completed.serverProof !== createServerProof(secret, challenge.nonce, completed.token, origin, challenge.protocol)) {
    throw new Error('smoke pairing server proof mismatch')
  }
  const healthResponse = await fetch(`${baseUrl}/health`, {
    headers: {
      Origin: origin,
      Authorization: `Bearer ${completed.token}`,
      'X-Img-Prompt-Protocol': challenge.protocol
    }
  })
  const health = await healthResponse.json()
  if (!healthResponse.ok || !health.ok || health.data.status !== 'ok') throw new Error('smoke health readback failed')
  console.log(JSON.stringify({ ok: true, address: '127.0.0.1', pairing: 'verified', health: health.data }, null, 2))
} finally {
  await new Promise((resolve) => server.close(resolve))
}
