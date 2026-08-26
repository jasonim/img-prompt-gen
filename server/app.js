import path from 'node:path'

import { AppError, LibraryService } from './library-service.js'
import { PairingError, PairingManager, PROTOCOL_VERSION, isExtensionOrigin } from './pairing.js'
import { StorageRepository } from './storage.js'

const MAX_REQUEST_BYTES = 64 * 1024
const EXTENSION_ORIGIN_HEADER = 'x-img-prompt-extension-origin'

function requestExtensionOrigin(request) {
  const nativeOrigin = request.headers.origin
  if (nativeOrigin !== undefined) return nativeOrigin
  const explicitOrigin = request.headers[EXTENSION_ORIGIN_HEADER]
  return typeof explicitOrigin === 'string' ? explicitOrigin : null
}

function jsonResponse(response, statusCode, payload, origin = null) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  if (origin && isExtensionOrigin(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  response.end(JSON.stringify(payload))
}

function success(response, data, { statusCode = 200, origin = null } = {}) {
  jsonResponse(response, statusCode, { ok: true, data }, origin)
}

function failure(response, error, origin) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500
  const isExpected = error instanceof AppError || error instanceof PairingError || statusCode < 500
  jsonResponse(response, statusCode, {
    ok: false,
    error: {
      code: isExpected ? (error.code ?? 'request_failed') : 'internal_error',
      message: isExpected ? error.message : '本地服务发生错误，请查看终端日志',
      nextAction: error.nextAction ?? null,
      fields: error.fields ?? null
    }
  }, origin)
}

async function readJson(request) {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) throw new AppError('请求必须使用 application/json', { code: 'invalid_content_type', statusCode: 415 })
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new AppError('请求体超过 64 KiB', { code: 'request_too_large', statusCode: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AppError('JSON 格式无效', { code: 'invalid_json', statusCode: 400 })
  }
}

function bearerToken(request) {
  const authorization = request.headers.authorization ?? ''
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : null
}

function requireLoopbackHost(request) {
  const host = request.headers.host ?? ''
  if (!(host === '127.0.0.1' || host.startsWith('127.0.0.1:'))) {
    throw new AppError('Host 必须是 127.0.0.1', { code: 'invalid_host', statusCode: 403 })
  }
}

async function requireAuth(request, pairing) {
  const origin = requestExtensionOrigin(request)
  if (!isExtensionOrigin(origin)) throw new AppError('请求 Origin 无效', { code: 'invalid_origin', statusCode: 403 })
  const token = bearerToken(request)
  if (!token) throw new AppError('尚未配对', { code: 'authentication_required', statusCode: 401, nextAction: '在侧栏完成本地服务配对' })
  if (request.headers['x-img-prompt-protocol'] !== PROTOCOL_VERSION) throw new AppError('客户端协议版本不匹配', { code: 'protocol_mismatch', statusCode: 426, nextAction: '重新加载扩展或更新本地服务' })
  const auth = await pairing.authenticate(token, origin)
  if (!auth.ok) {
    throw new AppError(auth.reason === 'origin_mismatch' ? 'Token 不属于当前扩展' : '配对 Token 无效', {
      code: auth.reason,
      statusCode: auth.reason === 'origin_mismatch' ? 403 : 401,
      nextAction: '重置配对后重试'
    })
  }
  return auth.credentials
}

function parseEntityPath(pathname) {
  const match = pathname.match(/^\/api\/(terms|recipes|prompts)\/([^/]+)(?:\/(review))?$/)
  return match ? { collection: match[1], id: decodeURIComponent(match[2]), action: match[3] ?? null } : null
}

export async function createApplication({ dataDir, logger = console.info, now = () => new Date() }) {
  const repository = new StorageRepository({ dataDir, now })
  await repository.initialize()
  const pairing = new PairingManager({ secretsDir: path.join(dataDir, '.secrets'), now })
  await pairing.initialize()
  const library = new LibraryService({ repository, now })

  async function handler(request, response) {
    const requestId = crypto.randomUUID()
    const startedAt = Date.now()
    const origin = requestExtensionOrigin(request)
    try {
      requireLoopbackHost(request)
      const url = new URL(request.url, 'http://127.0.0.1')
      const pathname = url.pathname

      if (request.method === 'OPTIONS') {
        if (!isExtensionOrigin(origin)) throw new AppError('Origin 无效', { code: 'invalid_origin', statusCode: 403 })
        response.statusCode = 204
        response.setHeader('Access-Control-Allow-Origin', origin)
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
        response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Img-Prompt-Protocol,X-Img-Prompt-Extension-Origin')
        response.setHeader('Access-Control-Max-Age', '600')
        response.end()
        return
      }

      if (request.method === 'GET' && pathname === '/api/pair/challenge') {
        success(response, await pairing.createChallenge(origin), { origin })
        return
      }
      if (request.method === 'POST' && pathname === '/api/pair/complete') {
        success(response, await pairing.completePairing({ origin, ...(await readJson(request)) }), { origin })
        return
      }
      if (request.method === 'GET' && pathname === '/health') {
        const publicStatus = await pairing.publicStatus()
        const token = bearerToken(request)
        if (!token) success(response, publicStatus, { origin })
        else {
          await requireAuth(request, pairing)
          success(response, { ...publicStatus, ...(await library.health()) }, { origin })
        }
        return
      }

      await requireAuth(request, pairing)

      if (request.method === 'GET' && pathname === '/api/library') {
        success(response, await library.getLibrary(), { origin })
        return
      }
      if (request.method === 'GET' && pathname === '/api/workbench') {
        success(response, await library.getWorkbench(), { origin })
        return
      }
      if (request.method === 'GET' && pathname === '/api/export') {
        success(response, await library.exportSources(), { origin })
        return
      }
      if (request.method === 'POST' && pathname === '/api/captures') {
        const result = await library.createCapture(await readJson(request))
        success(response, result, { statusCode: result.deduplicated ? 200 : 201, origin })
        return
      }
      if (request.method === 'GET' && pathname === '/api/captures') {
        const result = await library.getCollection('captures')
        const status = url.searchParams.get('status')
        success(response, { ...result, items: status ? result.items.filter((item) => item.processingStatus === status) : result.items }, { origin })
        return
      }
      const organizeMatch = pathname.match(/^\/api\/captures\/([^/]+)\/organize$/)
      if (request.method === 'POST' && organizeMatch) {
        success(response, await library.organizeCapture(decodeURIComponent(organizeMatch[1]), await readJson(request)), { origin })
        return
      }
      const captureMatch = pathname.match(/^\/api\/captures\/([^/]+)$/)
      if (request.method === 'DELETE' && captureMatch) {
        success(response, await library.deleteCapture(decodeURIComponent(captureMatch[1]), await readJson(request)), { origin })
        return
      }
      const collectionMatch = pathname.match(/^\/api\/(terms|recipes|prompts)$/)
      if (collectionMatch && request.method === 'GET') {
        success(response, await library.getCollection(collectionMatch[1]), { origin })
        return
      }
      if (collectionMatch && request.method === 'POST') {
        success(response, await library.createEntity(collectionMatch[1], await readJson(request)), { statusCode: 201, origin })
        return
      }
      const entityPath = parseEntityPath(pathname)
      if (entityPath?.action === 'review' && request.method === 'POST') {
        success(response, await library.reviewEntity(entityPath.collection, entityPath.id, await readJson(request)), { origin })
        return
      }
      if (entityPath && !entityPath.action && request.method === 'PATCH') {
        success(response, await library.updateEntity(entityPath.collection, entityPath.id, await readJson(request)), { origin })
        return
      }
      if (entityPath && !entityPath.action && request.method === 'DELETE') {
        success(response, await library.deleteEntity(entityPath.collection, entityPath.id, await readJson(request)), { origin })
        return
      }
      throw new AppError('接口不存在', { code: 'not_found', statusCode: 404 })
    } catch (error) {
      if ((error.statusCode ?? 500) >= 500) logger({ requestId, action: `${request.method} ${request.url}`, statusCode: error.statusCode ?? 500, durationMs: Date.now() - startedAt })
      failure(response, error, origin)
    }
  }

  return { handler, repository, pairing, library }
}
