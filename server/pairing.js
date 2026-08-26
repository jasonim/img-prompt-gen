import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const PROTOCOL_VERSION = '1'
export const PAIRING_TTL_MS = 10 * 60 * 1000
export const MAX_PAIRING_ATTEMPTS = 5

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/

function hmac(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex')
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function isExtensionOrigin(origin) {
  return EXTENSION_ORIGIN.test(origin ?? '')
}

export function createClientProof(secret, nonce, origin, protocol = PROTOCOL_VERSION) {
  return hmac(secret, `client:${nonce}:${origin}:${protocol}`)
}

export function createServerProof(secret, nonce, token, origin, protocol = PROTOCOL_VERSION) {
  return hmac(secret, `server:${nonce}:${tokenHash(token)}:${origin}:${protocol}`)
}

export class PairingError extends Error {
  constructor(message, code = 'pairing_failed', statusCode = 401) {
    super(message)
    this.name = 'PairingError'
    this.code = code
    this.statusCode = statusCode
  }
}

export class PairingManager {
  constructor({ secretsDir, now = () => new Date() }) {
    this.secretsDir = secretsDir
    this.now = now
    this.secretPath = path.join(secretsDir, 'pairing-secret.json')
    this.tokenPath = path.join(secretsDir, 'client-token.json')
    this.servicePath = path.join(secretsDir, 'service.json')
    this.challenges = new Map()
  }

  async initialize() {
    await mkdir(this.secretsDir, { recursive: true, mode: 0o700 })
    try {
      await readFile(this.servicePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await this.#writePrivate(this.servicePath, { serviceId: randomUUID() })
    }
  }

  async reset() {
    await this.initialize()
    const secret = randomBytes(24).toString('base64url')
    const issuedAt = this.now().toISOString()
    await unlink(this.tokenPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    await this.#writePrivate(this.secretPath, {
      secret,
      issuedAt,
      expiresAt: new Date(this.now().getTime() + PAIRING_TTL_MS).toISOString(),
      attempts: 0
    })
    this.challenges.clear()
    return secret
  }

  async ensurePairingSecret() {
    await this.initialize()
    const token = await this.#readJson(this.tokenPath, null)
    if (token) return null
    const secretState = await this.#readJson(this.secretPath, null)
    if (secretState && Date.parse(secretState.expiresAt) > this.now().getTime() && secretState.attempts < MAX_PAIRING_ATTEMPTS) {
      return secretState.secret
    }
    return this.reset()
  }

  async createChallenge(origin) {
    await this.initialize()
    if (!isExtensionOrigin(origin)) throw new PairingError('Invalid extension origin', 'invalid_origin', 403)
    const secretState = await this.#readActiveSecret()
    if (secretState.attempts >= MAX_PAIRING_ATTEMPTS) throw new PairingError('Pairing attempt limit reached', 'pairing_locked', 429)
    const nonce = randomBytes(24).toString('base64url')
    const service = await this.#readJson(this.servicePath)
    this.challenges.set(nonce, {
      origin,
      expiresAt: Math.min(Date.parse(secretState.expiresAt), this.now().getTime() + 60_000)
    })
    return {
      nonce,
      serviceId: service.serviceId,
      protocol: PROTOCOL_VERSION,
      expiresAt: new Date(this.challenges.get(nonce).expiresAt).toISOString()
    }
  }

  async completePairing({ origin, nonce, proof }) {
    if (!isExtensionOrigin(origin)) throw new PairingError('Invalid extension origin', 'invalid_origin', 403)
    const challenge = this.challenges.get(nonce)
    if (!challenge || challenge.origin !== origin || challenge.expiresAt <= this.now().getTime()) {
      throw new PairingError('Pairing challenge expired', 'challenge_expired', 401)
    }
    const secretState = await this.#readActiveSecret()
    if (secretState.attempts >= MAX_PAIRING_ATTEMPTS) throw new PairingError('Pairing attempt limit reached', 'pairing_locked', 429)
    const expected = createClientProof(secretState.secret, nonce, origin, PROTOCOL_VERSION)
    if (!safeEqual(proof, expected)) {
      secretState.attempts += 1
      await this.#writePrivate(this.secretPath, secretState)
      throw new PairingError(
        secretState.attempts >= MAX_PAIRING_ATTEMPTS ? 'Pairing attempt limit reached' : 'Invalid pairing proof',
        secretState.attempts >= MAX_PAIRING_ATTEMPTS ? 'pairing_locked' : 'invalid_proof',
        secretState.attempts >= MAX_PAIRING_ATTEMPTS ? 429 : 401
      )
    }

    const token = randomBytes(32).toString('base64url')
    const pairedAt = this.now().toISOString()
    await this.#writePrivate(this.tokenPath, { token, origin, protocol: PROTOCOL_VERSION, pairedAt })
    const serverProof = createServerProof(secretState.secret, nonce, token, origin, PROTOCOL_VERSION)
    await unlink(this.secretPath)
    this.challenges.delete(nonce)
    return { token, origin, protocol: PROTOCOL_VERSION, pairedAt, serverProof }
  }

  async authenticate(token, origin) {
    const stored = await this.#readJson(this.tokenPath, null)
    if (!stored || !safeEqual(token, stored.token)) return { ok: false, reason: 'invalid_token' }
    if (stored.origin !== origin) return { ok: false, reason: 'origin_mismatch' }
    if (stored.protocol !== PROTOCOL_VERSION) return { ok: false, reason: 'protocol_mismatch' }
    return { ok: true, credentials: stored }
  }

  async authorize(token, origin) {
    return (await this.authenticate(token, origin)).ok
  }

  async publicStatus() {
    await this.initialize()
    const service = await this.#readJson(this.servicePath)
    const token = await this.#readJson(this.tokenPath, null)
    return {
      service: 'img-prompt-gen',
      serviceId: service.serviceId,
      protocol: PROTOCOL_VERSION,
      pairing: token ? 'paired' : 'required'
    }
  }

  async credentials() {
    return this.#readJson(this.tokenPath, null)
  }

  async #readActiveSecret() {
    const secretState = await this.#readJson(this.secretPath, null)
    if (!secretState) throw new PairingError('Pairing reset required', 'pairing_required', 409)
    if (Date.parse(secretState.expiresAt) <= this.now().getTime()) throw new PairingError('Pairing secret expired', 'pairing_expired', 410)
    return secretState
  }

  async #readJson(filePath, fallback) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT' && arguments.length > 1) return fallback
      throw error
    }
  }

  async #writePrivate(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  }
}
