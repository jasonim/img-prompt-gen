export const API_BASE_URL = 'http://127.0.0.1:43119'
export const PROTOCOL_VERSION = '1'
export const PAIRING_KEY = 'servicePairing'
export const EXTENSION_ORIGIN_HEADER = 'X-Img-Prompt-Extension-Origin'

const encoder = new TextEncoder()

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret, message, cryptoImpl = globalThis.crypto) {
  const key = await cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return bytesToHex(await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(message)))
}

async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  return bytesToHex(await cryptoImpl.subtle.digest('SHA-256', encoder.encode(value)))
}

export async function createBrowserClientProof(secret, nonce, origin, protocol = PROTOCOL_VERSION, cryptoImpl = globalThis.crypto) {
  return hmacHex(secret, `client:${nonce}:${origin}:${protocol}`, cryptoImpl)
}

export async function createBrowserServerProof(secret, nonce, token, origin, protocol = PROTOCOL_VERSION, cryptoImpl = globalThis.crypto) {
  const digest = await sha256Hex(token, cryptoImpl)
  return hmacHex(secret, `server:${nonce}:${digest}:${origin}:${protocol}`, cryptoImpl)
}

export class ApiClientError extends Error {
  constructor(message, { code = 'request_failed', status = 0, nextAction = null, fields = null } = {}) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.nextAction = nextAction
    this.fields = fields
  }
}

async function readStored(storage, key) {
  return (await storage.get(key))[key]
}

export function createApiClient({
  baseUrl = API_BASE_URL,
  storage = globalThis.chrome?.storage?.local,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  origin = globalThis.location?.origin
} = {}) {
  if (!storage) throw new TypeError('storage adapter is required')
  if (!fetchImpl) throw new TypeError('fetch implementation is required')

  async function parseResponse(response) {
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new ApiClientError('本地服务返回了无法解析的内容', { code: 'invalid_response', status: response.status })
    }
    if (!response.ok || !payload.ok) {
      const details = payload.error ?? {}
      if (response.status === 401) await storage.remove(PAIRING_KEY)
      throw new ApiClientError(details.message ?? '本地服务请求失败', {
        code: details.code,
        status: response.status,
        nextAction: details.nextAction,
        fields: details.fields
      })
    }
    return payload.data
  }

  async function pair(secret) {
    if (typeof secret !== 'string' || secret.trim().length < 12) throw new ApiClientError('配对密钥格式无效', { code: 'invalid_pairing_secret' })
    let challengeResponse
    try {
      challengeResponse = await fetchImpl(`${baseUrl}/api/pair/challenge`, {
        headers: origin ? { [EXTENSION_ORIGIN_HEADER]: origin } : {}
      })
    } catch {
      throw new ApiClientError('无法连接本地服务', { code: 'offline', nextAction: '先在终端运行 npm start' })
    }
    const challenge = await parseResponse(challengeResponse)
    const proof = await createBrowserClientProof(secret.trim(), challenge.nonce, origin, challenge.protocol, cryptoImpl)
    const completed = await parseResponse(await fetchImpl(`${baseUrl}/api/pair/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(origin ? { [EXTENSION_ORIGIN_HEADER]: origin } : {})
      },
      body: JSON.stringify({ nonce: challenge.nonce, proof })
    }))
    const expectedServerProof = await createBrowserServerProof(
      secret.trim(),
      challenge.nonce,
      completed.token,
      origin,
      challenge.protocol,
      cryptoImpl
    )
    if (completed.serverProof !== expectedServerProof) {
      throw new ApiClientError('服务身份证明失败，未保存 Token', { code: 'invalid_server_proof', nextAction: '检查 43119 端口是否被其他程序占用' })
    }
    const pairing = {
      token: completed.token,
      protocol: challenge.protocol,
      serviceId: challenge.serviceId,
      pairedAt: completed.pairedAt ?? new Date().toISOString()
    }
    await storage.set({ [PAIRING_KEY]: pairing })
    return pairing
  }

  async function request(path, { method = 'GET', body = undefined } = {}) {
    const pairing = await readStored(storage, PAIRING_KEY)
    if (!pairing?.token) throw new ApiClientError('尚未配对本地服务', { code: 'authentication_required', status: 401, nextAction: '输入终端显示的配对密钥' })
    const headers = {
      Authorization: `Bearer ${pairing.token}`,
      'X-Img-Prompt-Protocol': pairing.protocol ?? PROTOCOL_VERSION,
      ...(origin ? { [EXTENSION_ORIGIN_HEADER]: origin } : {})
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch {
      throw new ApiClientError('本地服务未连接', { code: 'offline', nextAction: '启动服务后点击重试' })
    }
    return parseResponse(response)
  }

  return {
    pair,
    async isPaired() { return Boolean((await readStored(storage, PAIRING_KEY))?.token) },
    async clearPairing() { await storage.remove(PAIRING_KEY) },
    health: () => request('/health'),
    getLibrary: () => request('/api/library'),
    getWorkbench: () => request('/api/workbench'),
    getCollection: (collection) => request(`/api/${collection}`),
    createCapture: (capture) => request('/api/captures', { method: 'POST', body: capture }),
    createEntity: (collection, body) => request(`/api/${collection}`, { method: 'POST', body }),
    updateEntity: (collection, id, body) => request(`/api/${collection}/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deleteEntity: (collection, id, body) => request(`/api/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE', body }),
    deleteCapture: (id, body) => request(`/api/captures/${encodeURIComponent(id)}`, { method: 'DELETE', body }),
    organizeCapture: (id, body) => request(`/api/captures/${encodeURIComponent(id)}/organize`, { method: 'POST', body }),
    reviewEntity: (collection, id, body) => request(`/api/${collection}/${encodeURIComponent(id)}/review`, { method: 'POST', body }),
    exportSources: () => request('/api/export')
  }
}
