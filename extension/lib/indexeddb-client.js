import { CATEGORY_LABELS, RESPONSIBILITY_LABELS } from './library-model.js'

const SCHEMA_VERSION = 1
const DATABASE_VERSION = 1
const STORE_NAME = 'snapshots'
const SNAPSHOT_KEY = 'current'
const MAX_CAPTURE_BYTES = 48 * 1024
const MAX_PROMPT_BYTES = 48 * 1024
const MAX_TERM_NAME_CODEPOINTS = 24
const CATEGORIES = Object.freeze(Object.keys(CATEGORY_LABELS))
const RESPONSIBILITIES = Object.freeze(Object.keys(RESPONSIBILITY_LABELS))
const ENTITY_COLLECTIONS = Object.freeze(['terms', 'recipes', 'prompts'])
const ALL_COLLECTIONS = Object.freeze(['captures', ...ENTITY_COLLECTIONS])
const NO_COMMIT = Symbol('no-commit')

export class IndexedDbClientError extends Error {
  constructor(message, { code = 'bad_request', status = 400, fields = null, nextAction = null } = {}) {
    super(message)
    this.name = 'IndexedDbClientError'
    this.code = code
    this.status = status
    this.fields = fields
    this.nextAction = nextAction
  }
}

function noCommit(value) {
  return { [NO_COMMIT]: true, value }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength
}

function codePointLength(value) {
  return [...String(value)].length
}

function normalizeCanonical(value) {
  if (typeof value === 'string') return value.normalize('NFC')
  if (Array.isArray(value)) return value.map(normalizeCanonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeCanonical(value[key])]))
  }
  return value
}

function canonicalStringify(value) {
  return JSON.stringify(normalizeCanonical(value))
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(value, cryptoImpl) {
  return bytesToHex(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

function approvalPayload(collection, entity) {
  if (collection === 'terms') {
    return {
      name: entity.name,
      category: entity.category,
      responsibility: entity.responsibility,
      sourceCaptureIds: [...(entity.sourceCaptureIds ?? [])].sort()
    }
  }
  if (collection === 'recipes') {
    return {
      name: entity.name,
      termIds: [...(entity.termIds ?? [])],
      derivedPrompt: entity.derivedPrompt,
      sourceCaptureIds: [...(entity.sourceCaptureIds ?? [])].sort()
    }
  }
  if (collection === 'prompts') {
    return {
      title: entity.title,
      text: entity.text,
      sourceType: entity.sourceType,
      sourceCaptureIds: [...(entity.sourceCaptureIds ?? [])].sort()
    }
  }
  throw new TypeError(`Unsupported collection: ${collection}`)
}

async function canonicalApprovalHash(collection, entity, cryptoImpl) {
  return sha256Hex(canonicalStringify(approvalPayload(collection, entity)), cryptoImpl)
}

async function sourceContentHash(state, cryptoImpl) {
  return sha256Hex(canonicalStringify({
    captures: state.captures,
    terms: state.terms,
    recipes: state.recipes,
    prompts: state.prompts
  }), cryptoImpl)
}

function createPendingReview() {
  return {
    machine: { status: 'pending', checkedAt: null, issues: [] },
    human: { status: 'pending', approvedContentHash: null, approvedAt: null, reviewer: null }
  }
}

function resetReview(entity) {
  entity.review = createPendingReview()
}

function addIssue(issues, path, code, message) {
  issues.push({ path, code, message })
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function validateStringArray(value, path, issues) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    addIssue(issues, path, 'invalid_array', '必须是字符串数组')
    return []
  }
  if (new Set(value).size !== value.length) addIssue(issues, path, 'duplicate_reference', '不能包含重复引用')
  return value
}

async function validateReview(collection, entity, path, issues, cryptoImpl) {
  const status = entity.review?.human?.status
  if (!['pending', 'approved', 'needs_revision'].includes(status)) {
    addIssue(issues, `${path}.review.human.status`, 'invalid_review', '人工审核状态无效')
    return
  }
  if (status !== 'approved') return
  const expected = await canonicalApprovalHash(collection, entity, cryptoImpl)
  if (entity.review.human.approvedContentHash !== expected) {
    addIssue(issues, `${path}.review.human.approvedContentHash`, 'stale_approval', '批准内容已变化，需要重新审核')
  }
  if (!validIso(entity.review.human.approvedAt) || entity.review.human.reviewer !== 'local_user') {
    addIssue(issues, `${path}.review.human`, 'invalid_approval_evidence', '人工批准缺少有效时间或审核人')
  }
}

function validateUniqueIds(collection, label, issues) {
  const seen = new Set()
  collection.forEach((entity, index) => {
    if (seen.has(entity?.id)) addIssue(issues, `${label}[${index}].id`, 'duplicate_id', `重复 ID: ${entity.id}`)
    seen.add(entity?.id)
  })
}

async function validateState(state, cryptoImpl) {
  const issues = []
  for (const key of ALL_COLLECTIONS) {
    if (!Array.isArray(state?.[key])) addIssue(issues, key, 'invalid_collection', '必须是数组')
  }
  if (issues.length > 0) return { valid: false, issues, machinePassed: 0, humanApproved: 0 }

  for (const key of ALL_COLLECTIONS) validateUniqueIds(state[key], key, issues)

  state.captures.forEach((capture, index) => {
    const path = `captures[${index}]`
    if (capture?.recordType !== 'capture') addIssue(issues, `${path}.recordType`, 'invalid_record_type', '必须是 capture')
    if (!nonEmpty(capture?.id) || !capture.id.startsWith('cap_')) addIssue(issues, `${path}.id`, 'invalid_id', 'capture ID 无效')
    if (!nonEmpty(capture?.text)) addIssue(issues, `${path}.text`, 'empty_capture', '原始文本不能为空')
    if (typeof capture?.text === 'string' && utf8ByteLength(capture.text) > MAX_CAPTURE_BYTES) addIssue(issues, `${path}.text`, 'capture_too_large', '原始文本超过大小限制')
    if (!validIso(capture?.capturedAt) || !validIso(capture?.receivedAt)) addIssue(issues, path, 'invalid_timestamp', '收录时间无效')
    if (capture?.sourceType !== 'browser_selection') addIssue(issues, `${path}.sourceType`, 'invalid_source_type', '来源类型无效')
    if (!['pending_review', 'processed', 'needs_review'].includes(capture?.processingStatus)) addIssue(issues, `${path}.processingStatus`, 'invalid_capture_status', '整理状态无效')
    validateStringArray(capture?.derivedTermIds, `${path}.derivedTermIds`, issues)
    validateStringArray(capture?.derivedRecipeIds, `${path}.derivedRecipeIds`, issues)
  })

  const captureIds = new Set(state.captures.map((capture) => capture.id))
  const termIds = new Set(state.terms.map((term) => term.id))
  const termsById = new Map(state.terms.map((term) => [term.id, term]))
  const normalizedNames = new Map()

  for (const [index, term] of state.terms.entries()) {
    const path = `terms[${index}]`
    if (!nonEmpty(term?.id) || !term.id.startsWith('term_')) addIssue(issues, `${path}.id`, 'invalid_id', 'term ID 无效')
    if (!nonEmpty(term?.name)) addIssue(issues, `${path}.name`, 'empty_name', '词名不能为空')
    if (typeof term?.name === 'string' && codePointLength(term.name) > MAX_TERM_NAME_CODEPOINTS) addIssue(issues, `${path}.name`, 'term_name_too_long', '词名不能超过 24 个字符')
    if (!CATEGORIES.includes(term?.category)) addIssue(issues, `${path}.category`, 'invalid_category', '浏览分类无效')
    if (!RESPONSIBILITIES.includes(term?.responsibility)) addIssue(issues, `${path}.responsibility`, 'invalid_responsibility', '视觉职责无效')
    for (const captureId of validateStringArray(term?.sourceCaptureIds, `${path}.sourceCaptureIds`, issues)) {
      if (!captureIds.has(captureId)) addIssue(issues, `${path}.sourceCaptureIds`, 'missing_capture', `找不到原始收录 ${captureId}`)
    }
    const normalized = term?.name?.normalize('NFC').trim().toLocaleLowerCase('zh-CN')
    if (normalizedNames.has(normalized)) addIssue(issues, `${path}.name`, 'duplicate_term_name', `与 ${normalizedNames.get(normalized)} 重名`)
    else normalizedNames.set(normalized, term.id)
    await validateReview('terms', term, path, issues, cryptoImpl)
  }

  for (const [index, recipe] of state.recipes.entries()) {
    const path = `recipes[${index}]`
    if (!nonEmpty(recipe?.id) || !recipe.id.startsWith('recipe_')) addIssue(issues, `${path}.id`, 'invalid_id', 'recipe ID 无效')
    if (!nonEmpty(recipe?.name)) addIssue(issues, `${path}.name`, 'empty_name', '配方名不能为空')
    const references = validateStringArray(recipe?.termIds, `${path}.termIds`, issues)
    if (references.length === 0) addIssue(issues, `${path}.termIds`, 'empty_recipe', '配方至少引用一个原子词')
    for (const termId of references) {
      if (!termIds.has(termId)) addIssue(issues, `${path}.termIds`, 'dangling_term', `找不到原子词 ${termId}`)
      if (recipe.review?.human?.status === 'approved' && termsById.get(termId)?.review?.human?.status !== 'approved') {
        addIssue(issues, `${path}.termIds`, 'unpublished_recipe_term', `已批准配方引用了未批准原子词 ${termId}`)
      }
    }
    if (!nonEmpty(recipe?.derivedPrompt)) addIssue(issues, `${path}.derivedPrompt`, 'empty_prompt', '配方必须保留完整 Prompt')
    if (typeof recipe?.derivedPrompt === 'string' && utf8ByteLength(recipe.derivedPrompt) > MAX_PROMPT_BYTES) addIssue(issues, `${path}.derivedPrompt`, 'prompt_too_large', '配方 Prompt 超过大小限制')
    for (const captureId of validateStringArray(recipe?.sourceCaptureIds, `${path}.sourceCaptureIds`, issues)) {
      if (!captureIds.has(captureId)) addIssue(issues, `${path}.sourceCaptureIds`, 'missing_capture', `找不到原始收录 ${captureId}`)
    }
    await validateReview('recipes', recipe, path, issues, cryptoImpl)
  }

  for (const [index, prompt] of state.prompts.entries()) {
    const path = `prompts[${index}]`
    if (!nonEmpty(prompt?.id) || !prompt.id.startsWith('prompt_')) addIssue(issues, `${path}.id`, 'invalid_id', 'prompt ID 无效')
    if (!nonEmpty(prompt?.title)) addIssue(issues, `${path}.title`, 'empty_title', 'Prompt 标题不能为空')
    if (!nonEmpty(prompt?.text)) addIssue(issues, `${path}.text`, 'empty_prompt', 'Prompt 正文不能为空')
    if (typeof prompt?.text === 'string' && utf8ByteLength(prompt.text) > MAX_PROMPT_BYTES) addIssue(issues, `${path}.text`, 'prompt_too_large', 'Prompt 超过大小限制')
    if (prompt?.sourceType !== 'manual') addIssue(issues, `${path}.sourceType`, 'invalid_source_type', '常用 Prompt 只能是手动来源')
    for (const captureId of validateStringArray(prompt?.sourceCaptureIds ?? [], `${path}.sourceCaptureIds`, issues)) {
      if (!captureIds.has(captureId)) addIssue(issues, `${path}.sourceCaptureIds`, 'missing_capture', `找不到原始收录 ${captureId}`)
    }
    await validateReview('prompts', prompt, path, issues, cryptoImpl)
  }

  const entities = [...state.terms, ...state.recipes, ...state.prompts]
  return {
    valid: issues.length === 0,
    issues,
    machinePassed: issues.length === 0 ? entities.length : Math.max(0, entities.length - new Set(issues.map((issue) => issue.path.split('.')[0])).size),
    humanApproved: entities.filter((entity) => entity.review?.human?.status === 'approved').length
  }
}

function refreshMachineReviews(state, checkedAt) {
  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of state[collection]) {
      entity.review ??= createPendingReview()
      entity.review.machine = { status: 'passed', checkedAt, issues: [] }
    }
  }
}

async function compileLibrary(state, { revision = 0, generatedAt = null, cryptoImpl, report = null } = {}) {
  const validation = report ?? await validateState(state, cryptoImpl)
  if (!validation.valid) throw new IndexedDbClientError('数据验证失败', { code: 'validation_failed', status: 422, fields: { issues: validation.issues } })

  const terms = []
  for (const term of state.terms) {
    const currentHash = await canonicalApprovalHash('terms', term, cryptoImpl)
    if (term.review?.human?.status === 'approved' && term.review.human.approvedContentHash === currentHash) {
      terms.push({ id: term.id, name: term.name, category: term.category, responsibility: term.responsibility, sourceCaptureIds: term.sourceCaptureIds, approvedAt: term.review.human.approvedAt, updatedAt: term.updatedAt })
    }
  }
  const publishedTermIds = new Set(terms.map((term) => term.id))
  const recipes = []
  for (const recipe of state.recipes) {
    const currentHash = await canonicalApprovalHash('recipes', recipe, cryptoImpl)
    if (recipe.review?.human?.status === 'approved' && recipe.review.human.approvedContentHash === currentHash && recipe.termIds.every((id) => publishedTermIds.has(id))) {
      recipes.push({ id: recipe.id, name: recipe.name, termIds: recipe.termIds, derivedPrompt: recipe.derivedPrompt, sourceCaptureIds: recipe.sourceCaptureIds, approvedAt: recipe.review.human.approvedAt, updatedAt: recipe.updatedAt })
    }
  }
  const prompts = []
  for (const prompt of state.prompts) {
    const currentHash = await canonicalApprovalHash('prompts', prompt, cryptoImpl)
    if (prompt.review?.human?.status === 'approved' && prompt.review.human.approvedContentHash === currentHash) {
      prompts.push({ id: prompt.id, title: prompt.title, text: prompt.text, sourceType: prompt.sourceType, sourceCaptureIds: prompt.sourceCaptureIds ?? [], approvedAt: prompt.review.human.approvedAt, updatedAt: prompt.updatedAt })
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceRevision: revision,
    sourceContentHash: await sourceContentHash(state, cryptoImpl),
    generatedAt,
    counts: {
      captures: state.captures.length,
      pendingCaptures: state.captures.filter((capture) => capture.processingStatus !== 'processed').length,
      sourceTerms: state.terms.length,
      sourceRecipes: state.recipes.length,
      sourcePrompts: state.prompts.length,
      machinePassed: validation.machinePassed,
      humanApproved: validation.humanApproved,
      publishedTerms: terms.length,
      publishedRecipes: recipes.length,
      publishedPrompts: prompts.length
    },
    terms,
    recipes,
    prompts
  }
}

class IndexedDbRepository {
  constructor({ indexedDB, databaseName, now, cryptoImpl }) {
    this.indexedDB = indexedDB
    this.databaseName = databaseName
    this.now = now
    this.cryptoImpl = cryptoImpl
    this.databasePromise = null
    this.initializationPromise = null
  }

  async database() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.databaseName, DATABASE_VERSION)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'))
        request.onblocked = () => reject(new IndexedDbClientError('词库数据库升级被其他窗口阻止', { code: 'database_blocked', nextAction: '关闭其他枝句窗口后重试' }))
      })
    }
    return this.databasePromise
  }

  async initialize() {
    if (!this.initializationPromise) this.initializationPromise = this.#initializeOnce()
    return this.initializationPromise
  }

  async #initializeOnce() {
    const state = { captures: [], terms: [], recipes: [], prompts: [] }
    const runtime = await compileLibrary(state, { revision: 0, generatedAt: null, cryptoImpl: this.cryptoImpl })
    const database = await this.database()
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const existing = await requestResult(store.get(SNAPSHOT_KEY))
    if (!existing) store.put({ key: SNAPSHOT_KEY, schemaVersion: SCHEMA_VERSION, revision: 0, state, runtime })
    await transactionDone(transaction)
    return this.readSnapshot({ skipInitialize: true })
  }

  async readSnapshot({ skipInitialize = false } = {}) {
    if (!skipInitialize) await this.initialize()
    const database = await this.database()
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const snapshot = await requestResult(transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY))
    await transactionDone(transaction)
    if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION) throw new IndexedDbClientError('词库数据库结构无效', { code: 'invalid_database' })
    return structuredClone(snapshot)
  }

  async transaction(mutator) {
    await this.initialize()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.readSnapshot({ skipInitialize: true })
      const draft = structuredClone(current.state)
      const result = await mutator(draft, current)
      if (result?.[NO_COMMIT]) return { result: result.value, revision: current.revision, runtime: current.runtime, changed: false }

      const checkedAt = this.now().toISOString()
      refreshMachineReviews(draft, checkedAt)
      const report = await validateState(draft, this.cryptoImpl)
      if (!report.valid) throw new IndexedDbClientError('数据验证失败', { code: 'validation_failed', status: 422, fields: { issues: report.issues } })
      const revision = current.revision + 1
      const runtime = await compileLibrary(draft, { revision, generatedAt: checkedAt, cryptoImpl: this.cryptoImpl, report })
      const committed = await this.#tryCommit(current.revision, { key: SNAPSHOT_KEY, schemaVersion: SCHEMA_VERSION, revision, state: draft, runtime })
      if (committed) return { result, revision, runtime, changed: true }
    }
    throw new IndexedDbClientError('数据已被其他窗口连续更新', { code: 'revision_conflict', status: 409, nextAction: '刷新后重新应用修改' })
  }

  async #tryCommit(expectedRevision, snapshot) {
    const database = await this.database()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      let conflict = false
      const read = store.get(SNAPSHOT_KEY)
      read.onerror = () => reject(read.error ?? new Error('无法读取 IndexedDB 快照'))
      read.onsuccess = () => {
        if (read.result?.revision !== expectedRevision) {
          conflict = true
          transaction.abort()
          return
        }
        store.put(snapshot)
      }
      transaction.oncomplete = () => resolve(true)
      transaction.onabort = () => conflict ? resolve(false) : reject(transaction.error ?? new Error('IndexedDB 写入被中止'))
      transaction.onerror = () => {
        if (!conflict) reject(transaction.error ?? new Error('IndexedDB 写入失败'))
      }
    })
  }
}

function requireRevision(expectedRevision, currentRevision) {
  if (!Number.isInteger(expectedRevision)) throw new IndexedDbClientError('缺少 expectedRevision', { code: 'revision_required', status: 428, nextAction: '刷新数据后重试' })
  if (expectedRevision !== currentRevision) throw new IndexedDbClientError('数据已被其他窗口更新', { code: 'revision_conflict', status: 409, nextAction: '刷新后重新应用修改' })
}

function requireString(value, field, { maxBytes = null } = {}) {
  if (!nonEmpty(value)) throw new IndexedDbClientError(`${field} 不能为空`, { code: 'invalid_input', fields: { [field]: '不能为空' } })
  if (maxBytes && utf8ByteLength(value) > maxBytes) throw new IndexedDbClientError(`${field} 超过大小限制`, { code: 'input_too_large', status: 413, fields: { [field]: `最多 ${maxBytes} UTF-8 字节` } })
  return value
}

function findById(collection, id, label) {
  const entity = collection.find((item) => item.id === id)
  if (!entity) throw new IndexedDbClientError(`${label}不存在`, { code: 'not_found', status: 404 })
  return entity
}

function requireEntityCollection(collection) {
  if (!ENTITY_COLLECTIONS.includes(collection)) throw new IndexedDbClientError('集合不存在', { code: 'not_found', status: 404 })
}

function buildEntity(collection, input, now) {
  requireString(input?.id, 'id')
  const prefix = collection === 'terms' ? 'term_' : collection === 'recipes' ? 'recipe_' : 'prompt_'
  if (!input.id.startsWith(prefix)) throw new IndexedDbClientError('实体 ID 前缀无效', { code: 'invalid_input', fields: { id: `必须以 ${prefix} 开头` } })
  const common = { id: input.id, review: createPendingReview(), createdAt: now, updatedAt: now }
  if (collection === 'terms') {
    requireString(input.name, 'name')
    if (!CATEGORIES.includes(input.category)) throw new IndexedDbClientError('浏览分类无效', { code: 'invalid_input', fields: { category: '不在允许范围' } })
    if (!RESPONSIBILITIES.includes(input.responsibility)) throw new IndexedDbClientError('视觉职责无效', { code: 'invalid_input', fields: { responsibility: '不在允许范围' } })
    return { ...common, name: input.name, category: input.category, responsibility: input.responsibility, sourceCaptureIds: input.sourceCaptureIds ?? [] }
  }
  if (collection === 'recipes') {
    requireString(input.name, 'name')
    requireString(input.derivedPrompt, 'derivedPrompt', { maxBytes: MAX_PROMPT_BYTES })
    if (!Array.isArray(input.termIds) || input.termIds.length === 0) throw new IndexedDbClientError('配方至少需要一个原子词', { code: 'invalid_input', fields: { termIds: '不能为空' } })
    return { ...common, name: input.name, termIds: input.termIds, derivedPrompt: input.derivedPrompt, sourceCaptureIds: input.sourceCaptureIds ?? [] }
  }
  requireString(input.title, 'title')
  requireString(input.text, 'text', { maxBytes: MAX_PROMPT_BYTES })
  return { ...common, title: input.title, text: input.text, sourceType: 'manual', sourceCaptureIds: input.sourceCaptureIds ?? [] }
}

export function createIndexedDbClient({
  indexedDB = globalThis.indexedDB,
  databaseName = 'zhiju-library',
  now = () => new Date(),
  cryptoImpl = globalThis.crypto
} = {}) {
  if (!indexedDB) throw new TypeError('indexedDB is required')
  if (!cryptoImpl?.subtle) throw new TypeError('Web Crypto is required')
  const repository = new IndexedDbRepository({ indexedDB, databaseName, now, cryptoImpl })

  async function createCapture(input) {
    requireString(input?.id, 'id')
    if (!input.id.startsWith('cap_')) throw new IndexedDbClientError('capture ID 无效', { code: 'invalid_input', fields: { id: '必须以 cap_ 开头' } })
    requireString(input.text, 'text', { maxBytes: MAX_CAPTURE_BYTES })
    if (!validIso(input.capturedAt)) throw new IndexedDbClientError('capturedAt 时间无效', { code: 'invalid_input', fields: { capturedAt: '必须是 ISO-8601 时间' } })
    if (input.sourceType !== 'browser_selection') throw new IndexedDbClientError('sourceType 无效', { code: 'invalid_input' })
    const receivedAt = now().toISOString()
    const transaction = await repository.transaction((draft) => {
      const existing = draft.captures.find((capture) => capture.id === input.id)
      if (existing) {
        if (existing.text !== input.text || existing.capturedAt !== input.capturedAt || existing.sourceType !== input.sourceType) {
          throw new IndexedDbClientError('相同 capture ID 已用于其他内容', { code: 'idempotency_conflict', status: 409, nextAction: '生成新的 capture ID 后重试' })
        }
        return noCommit({ capture: existing, deduplicated: true })
      }
      const capture = {
        recordType: 'capture', id: input.id, text: input.text, capturedAt: input.capturedAt, receivedAt,
        sourceType: 'browser_selection', processingStatus: 'pending_review', processedAt: null,
        derivedTermIds: [], derivedRecipeIds: []
      }
      draft.captures.push(capture)
      return { capture, deduplicated: false }
    })
    return { ...transaction.result, sourceRevision: transaction.revision }
  }

  async function createEntity(collection, input) {
    requireEntityCollection(collection)
    const timestamp = now().toISOString()
    const transaction = await repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      if (draft[collection].some((entity) => entity.id === input.id)) throw new IndexedDbClientError('实体 ID 已存在', { code: 'idempotency_conflict', status: 409 })
      const entity = buildEntity(collection, input, timestamp)
      draft[collection].push(entity)
      return { entity }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async function updateEntity(collection, id, input) {
    requireEntityCollection(collection)
    const timestamp = now().toISOString()
    const transaction = await repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const entity = findById(draft[collection], id, '条目')
      const allowed = collection === 'terms'
        ? ['name', 'category', 'responsibility', 'sourceCaptureIds']
        : collection === 'recipes'
          ? ['name', 'termIds', 'derivedPrompt', 'sourceCaptureIds']
          : ['title', 'text', 'sourceCaptureIds']
      for (const field of allowed) if (field in input) entity[field] = input[field]
      entity.updatedAt = timestamp
      resetReview(entity)
      const affectedRecipeIds = []
      if (collection === 'terms') {
        for (const recipe of draft.recipes.filter((candidate) => candidate.termIds.includes(id) && candidate.review?.human?.status === 'approved')) {
          resetReview(recipe)
          recipe.updatedAt = timestamp
          affectedRecipeIds.push(recipe.id)
        }
      }
      return { entity, affectedRecipeIds }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async function deleteEntity(collection, id, input) {
    requireEntityCollection(collection)
    const transaction = await repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const index = draft[collection].findIndex((entity) => entity.id === id)
      if (index < 0) throw new IndexedDbClientError('条目不存在', { code: 'not_found', status: 404 })
      if (collection === 'terms') {
        const references = draft.recipes.filter((recipe) => recipe.termIds.includes(id)).map((recipe) => recipe.id)
        if (references.length > 0) throw new IndexedDbClientError('原子词仍被配方引用', { code: 'entity_referenced', status: 409, fields: { references }, nextAction: '先修改或删除引用它的配方' })
      }
      draft[collection].splice(index, 1)
      return { deletedId: id }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async function deleteCapture(id, input) {
    const transaction = await repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const capture = findById(draft.captures, id, '原始收录')
      const references = [
        ...capture.derivedTermIds, ...capture.derivedRecipeIds,
        ...draft.terms.filter((term) => term.sourceCaptureIds.includes(id)).map((term) => term.id),
        ...draft.recipes.filter((recipe) => recipe.sourceCaptureIds.includes(id)).map((recipe) => recipe.id),
        ...draft.prompts.filter((prompt) => (prompt.sourceCaptureIds ?? []).includes(id)).map((prompt) => prompt.id)
      ]
      if (new Set(references).size > 0) throw new IndexedDbClientError('原始收录仍有派生引用', { code: 'entity_referenced', status: 409, fields: { references: [...new Set(references)] } })
      draft.captures = draft.captures.filter((capture) => capture.id !== id)
      return { deletedId: id }
    })
    return { ...transaction.result, sourceRevision: transaction.revision }
  }

  async function organizeCapture(captureId, input) {
    const timestamp = now().toISOString()
    const terms = Array.isArray(input.terms) ? input.terms : []
    if (terms.length === 0) throw new IndexedDbClientError('至少需要一个原子词', { code: 'invalid_input', fields: { terms: '不能为空' } })
    const transaction = await repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const capture = findById(draft.captures, captureId, '原始收录')
      const createdTerms = terms.map((term) => buildEntity('terms', { ...term, sourceCaptureIds: [captureId] }, timestamp))
      for (const term of createdTerms) {
        if (draft.terms.some((existing) => existing.id === term.id)) throw new IndexedDbClientError(`原子词 ID 已存在: ${term.id}`, { code: 'idempotency_conflict', status: 409 })
        draft.terms.push(term)
      }
      let recipe = null
      if (input.recipe) {
        recipe = buildEntity('recipes', { ...input.recipe, sourceCaptureIds: [captureId] }, timestamp)
        if (draft.recipes.some((existing) => existing.id === recipe.id)) throw new IndexedDbClientError('配方 ID 已存在', { code: 'idempotency_conflict', status: 409 })
        draft.recipes.push(recipe)
      }
      capture.processingStatus = 'processed'
      capture.processedAt = timestamp
      capture.derivedTermIds = createdTerms.map((term) => term.id)
      capture.derivedRecipeIds = recipe ? [recipe.id] : []
      return { capture, terms: createdTerms, recipe }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async function reviewEntity(collection, id, input) {
    requireEntityCollection(collection)
    if (!['approved', 'needs_revision'].includes(input.decision)) throw new IndexedDbClientError('审核决定无效', { code: 'invalid_input', fields: { decision: '必须是 approved 或 needs_revision' } })
    const timestamp = now().toISOString()
    const transaction = await repository.transaction(async (draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const entity = findById(draft[collection], id, '条目')
      entity.review ??= createPendingReview()
      entity.review.human = input.decision === 'approved'
        ? { status: 'approved', approvedContentHash: await canonicalApprovalHash(collection, entity, cryptoImpl), approvedAt: timestamp, reviewer: 'local_user' }
        : { status: 'needs_revision', approvedContentHash: null, approvedAt: null, reviewer: 'local_user' }
      entity.updatedAt = timestamp
      return { entity }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async function importSources(payload, input = {}) {
    if (payload?.schemaVersion !== SCHEMA_VERSION) {
      throw new IndexedDbClientError('备份版本不受支持', { code: 'invalid_backup', status: 422, nextAction: '请选择枝句导出的 schemaVersion 1 JSON 文件' })
    }
    const importedState = Object.fromEntries(ALL_COLLECTIONS.map((collection) => [collection, structuredClone(payload?.[collection])]))
    const transaction = await repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      for (const collection of ALL_COLLECTIONS) draft[collection] = importedState[collection]
      return {
        importedCounts: Object.fromEntries(ALL_COLLECTIONS.map((collection) => [collection, Array.isArray(importedState[collection]) ? importedState[collection].length : 0]))
      }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  return {
    isReady: async () => { await repository.initialize(); return true },
    hashSources: (state) => sourceContentHash(state, cryptoImpl),
    async health() {
      const snapshot = await repository.readSnapshot()
      return { status: 'ok', storage: 'indexeddb', sourceRevision: snapshot.revision, runtimeGeneratedAt: snapshot.runtime.generatedAt, counts: snapshot.runtime.counts }
    },
    async getLibrary() { return (await repository.readSnapshot()).runtime },
    async getWorkbench() {
      const snapshot = await repository.readSnapshot()
      const pending = (items) => items.filter((item) => item.review?.human?.status !== 'approved')
      return {
        sourceRevision: snapshot.revision,
        captures: snapshot.state.captures.filter((capture) => capture.processingStatus !== 'processed'),
        terms: pending(snapshot.state.terms), recipes: pending(snapshot.state.recipes), prompts: pending(snapshot.state.prompts)
      }
    },
    async getCollection(collection) {
      if (!ALL_COLLECTIONS.includes(collection)) throw new IndexedDbClientError('集合不存在', { code: 'not_found', status: 404 })
      const snapshot = await repository.readSnapshot()
      return { sourceRevision: snapshot.revision, items: snapshot.state[collection] }
    },
    createCapture,
    createEntity,
    updateEntity,
    deleteEntity,
    deleteCapture,
    organizeCapture,
    reviewEntity,
    importSources,
    async exportSources() {
      const snapshot = await repository.readSnapshot()
      return { schemaVersion: SCHEMA_VERSION, sourceRevision: snapshot.revision, exportedAt: now().toISOString(), ...snapshot.state }
    }
  }
}
