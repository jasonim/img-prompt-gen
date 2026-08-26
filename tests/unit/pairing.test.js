import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  PairingManager,
  createClientProof,
  createServerProof
} from '../../server/pairing.js'

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`

async function createManager() {
  const root = await mkdtemp(path.join(tmpdir(), 'prompt-pairing-'))
  return new PairingManager({ secretsDir: path.join(root, '.secrets') })
}

test('challenge-response proves the service without transmitting the secret', async () => {
  const manager = await createManager()
  const secret = await manager.reset()
  const challenge = await manager.createChallenge(ORIGIN)
  assert.equal('secret' in challenge, false)

  const proof = createClientProof(secret, challenge.nonce, ORIGIN, challenge.protocol)
  const completed = await manager.completePairing({ origin: ORIGIN, nonce: challenge.nonce, proof })

  assert.equal(
    completed.serverProof,
    createServerProof(secret, challenge.nonce, completed.token, ORIGIN, challenge.protocol)
  )
  assert.equal(await manager.authorize(completed.token, ORIGIN), true)
  assert.equal(await manager.authorize(completed.token, `chrome-extension://${'b'.repeat(32)}`), false)
})

test('pairing locks after five invalid attempts and reset revokes the old token', async () => {
  const manager = await createManager()
  const firstSecret = await manager.reset()
  const challenge = await manager.createChallenge(ORIGIN)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      manager.completePairing({ origin: ORIGIN, nonce: challenge.nonce, proof: '0'.repeat(64) }),
      /proof|attempt/i
    )
  }

  await assert.rejects(
    manager.completePairing({
      origin: ORIGIN,
      nonce: challenge.nonce,
      proof: createClientProof(firstSecret, challenge.nonce, ORIGIN, challenge.protocol)
    }),
    /attempt/i
  )

  const newSecret = await manager.reset()
  assert.notEqual(newSecret, firstSecret)
  assert.equal(await manager.authorize('missing-token', ORIGIN), false)
})

test('public pairing state and existing secret lifecycle remain stable', async () => {
  const manager = await createManager()
  const first = await manager.ensurePairingSecret()
  const second = await manager.ensurePairingSecret()
  assert.equal(first, second)
  const status = await manager.publicStatus()
  assert.equal(status.pairing, 'required')
  assert.equal(typeof status.serviceId, 'string')
  assert.equal(await manager.credentials(), null)
  await assert.rejects(manager.createChallenge('https://example.com'), /origin/i)
})
