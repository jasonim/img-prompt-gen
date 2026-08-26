import { randomUUID } from 'node:crypto'

import {
  CATEGORIES,
  MAX_CAPTURE_BYTES,
  MAX_PROMPT_BYTES,
  RESPONSIBILITIES,
  canonicalApprovalHash,
  createPendingReview,
  utf8ByteLength
} from './schemas.js'
import { noCommit } from './storage.js'

export class AppError extends Error {
  constructor(message, { code = 'bad_request', statusCode = 400, fields = null, nextAction = null } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
    this.fields = fields
    this.nextAction = nextAction
  }
}

function requireRevision(expectedRevision, currentRevision) {
  if (!Number.isInteger(expectedRevision)) throw new AppError('缺少 expectedRevision', { code: 'revision_required', statusCode: 428, nextAction: '刷新数据后重试' })
  if (expectedRevision !== currentRevision) throw new AppError('数据已被其他窗口更新', { code: 'revision_conflict', statusCode: 409, nextAction: '刷新后重新应用修改' })
}

function requireString(value, field, { maxBytes = null } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new AppError(`${field} 不能为空`, { code: 'invalid_input', fields: { [field]: '不能为空' } })
  if (maxBytes && utf8ByteLength(value) > maxBytes) throw new AppError(`${field} 超过大小限制`, { code: 'input_too_large', statusCode: 413, fields: { [field]: `最多 ${maxBytes} UTF-8 字节` } })
  return value
}

function validIso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new AppError(`${field} 时间无效`, { code: 'invalid_input', fields: { [field]: '必须是 ISO-8601 时间' } })
  return value
}

function resetHumanReview(entity) {
  entity.review ??= createPendingReview()
  entity.review.human = createPendingReview().human
  entity.review.machine = createPendingReview().machine
}

function findById(collection, id, label) {
  const entity = collection.find((item) => item.id === id)
  if (!entity) throw new AppError(`${label}不存在`, { code: 'not_found', statusCode: 404 })
  return entity
}

export class LibraryService {
  constructor({ repository, now = () => new Date() }) {
    this.repository = repository
    this.now = now
  }

  async health() {
    const snapshot = await this.repository.readSnapshot()
    return {
      status: 'ok',
      sourceRevision: snapshot.revision,
      runtimeGeneratedAt: snapshot.runtime.generatedAt,
      counts: snapshot.runtime.counts
    }
  }

  async getLibrary() {
    return (await this.repository.readSnapshot()).runtime
  }

  async getWorkbench() {
    const snapshot = await this.repository.readSnapshot()
    const pending = (items) => items.filter((item) => item.review?.human?.status !== 'approved')
    return {
      sourceRevision: snapshot.revision,
      captures: snapshot.state.captures.filter((capture) => capture.processingStatus !== 'processed'),
      terms: pending(snapshot.state.terms),
      recipes: pending(snapshot.state.recipes),
      prompts: pending(snapshot.state.prompts)
    }
  }

  async getCollection(collection) {
    if (!['terms', 'recipes', 'prompts', 'captures'].includes(collection)) throw new AppError('集合不存在', { code: 'not_found', statusCode: 404 })
    const snapshot = await this.repository.readSnapshot()
    return { sourceRevision: snapshot.revision, items: snapshot.state[collection] }
  }

  async createCapture(input) {
    requireString(input?.id, 'id')
    if (!input.id.startsWith('cap_')) throw new AppError('capture ID 无效', { code: 'invalid_input', fields: { id: '必须以 cap_ 开头' } })
    requireString(input.text, 'text', { maxBytes: MAX_CAPTURE_BYTES })
    validIso(input.capturedAt, 'capturedAt')
    if (input.sourceType !== 'browser_selection') throw new AppError('sourceType 无效', { code: 'invalid_input' })
    const receivedAt = this.now().toISOString()
    const transaction = await this.repository.transaction((draft) => {
      const existing = draft.captures.find((capture) => capture.id === input.id)
      if (existing) {
        if (existing.text !== input.text || existing.capturedAt !== input.capturedAt || existing.sourceType !== input.sourceType) {
          throw new AppError('相同 capture ID 已用于其他内容', { code: 'idempotency_conflict', statusCode: 409, nextAction: '生成新的 capture ID 后重试' })
        }
        return noCommit({ capture: existing, deduplicated: true })
      }
      const capture = {
        recordType: 'capture',
        id: input.id,
        text: input.text,
        capturedAt: input.capturedAt,
        receivedAt,
        sourceType: 'browser_selection',
        processingStatus: 'pending_review',
        processedAt: null,
        derivedTermIds: [],
        derivedRecipeIds: []
      }
      draft.captures.push(capture)
      return { capture, deduplicated: false }
    })
    return { ...transaction.result, sourceRevision: transaction.revision }
  }

  async createEntity(collection, input) {
    this.#requireEntityCollection(collection)
    const now = this.now().toISOString()
    const transaction = await this.repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      if (draft[collection].some((entity) => entity.id === input.id)) throw new AppError('实体 ID 已存在', { code: 'idempotency_conflict', statusCode: 409 })
      const entity = this.#buildEntity(collection, input, now)
      draft[collection].push(entity)
      return { entity }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async updateEntity(collection, id, input) {
    this.#requireEntityCollection(collection)
    const now = this.now().toISOString()
    const transaction = await this.repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const entity = findById(draft[collection], id, '条目')
      const allowed = collection === 'terms'
        ? ['name', 'category', 'responsibility', 'sourceCaptureIds']
        : collection === 'recipes'
          ? ['name', 'termIds', 'derivedPrompt', 'sourceCaptureIds']
          : ['title', 'text', 'sourceCaptureIds']
      for (const field of allowed) if (field in input) entity[field] = input[field]
      entity.updatedAt = now
      resetHumanReview(entity)
      const affectedRecipeIds = []
      if (collection === 'terms') {
        for (const recipe of draft.recipes.filter((candidate) => candidate.termIds.includes(id) && candidate.review?.human?.status === 'approved')) {
          resetHumanReview(recipe)
          recipe.updatedAt = now
          affectedRecipeIds.push(recipe.id)
        }
      }
      return { entity, affectedRecipeIds }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async deleteEntity(collection, id, input) {
    this.#requireEntityCollection(collection)
    const transaction = await this.repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const index = draft[collection].findIndex((entity) => entity.id === id)
      if (index < 0) throw new AppError('条目不存在', { code: 'not_found', statusCode: 404 })
      if (collection === 'terms') {
        const references = draft.recipes.filter((recipe) => recipe.termIds.includes(id)).map((recipe) => recipe.id)
        if (references.length > 0) throw new AppError('原子词仍被配方引用', { code: 'entity_referenced', statusCode: 409, fields: { references }, nextAction: '先修改或删除引用它的配方' })
      }
      draft[collection].splice(index, 1)
      return { deletedId: id }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async deleteCapture(id, input) {
    const transaction = await this.repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const capture = findById(draft.captures, id, '原始收录')
      const references = [
        ...capture.derivedTermIds,
        ...capture.derivedRecipeIds,
        ...draft.terms.filter((term) => term.sourceCaptureIds.includes(id)).map((term) => term.id),
        ...draft.recipes.filter((recipe) => recipe.sourceCaptureIds.includes(id)).map((recipe) => recipe.id),
        ...draft.prompts.filter((prompt) => (prompt.sourceCaptureIds ?? []).includes(id)).map((prompt) => prompt.id)
      ].filter((reference, index, all) => all.indexOf(reference) === index)
      if (references.length > 0) throw new AppError('原始收录仍有派生引用', { code: 'entity_referenced', statusCode: 409, fields: { references } })
      draft.captures = draft.captures.filter((item) => item.id !== id)
      return { deletedId: id }
    })
    return { ...transaction.result, sourceRevision: transaction.revision }
  }

  async organizeCapture(captureId, input) {
    const now = this.now().toISOString()
    const terms = Array.isArray(input.terms) ? input.terms : []
    if (terms.length === 0) throw new AppError('至少需要一个原子词', { code: 'invalid_input', fields: { terms: '不能为空' } })
    const transaction = await this.repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const capture = findById(draft.captures, captureId, '原始收录')
      const createdTerms = terms.map((term) => this.#buildEntity('terms', { ...term, sourceCaptureIds: [captureId] }, now))
      for (const term of createdTerms) {
        if (draft.terms.some((existing) => existing.id === term.id)) throw new AppError(`原子词 ID 已存在: ${term.id}`, { code: 'idempotency_conflict', statusCode: 409 })
        draft.terms.push(term)
      }
      let recipe = null
      if (input.recipe) {
        recipe = this.#buildEntity('recipes', { ...input.recipe, sourceCaptureIds: [captureId] }, now)
        if (draft.recipes.some((existing) => existing.id === recipe.id)) throw new AppError('配方 ID 已存在', { code: 'idempotency_conflict', statusCode: 409 })
        draft.recipes.push(recipe)
      }
      capture.processingStatus = 'processed'
      capture.processedAt = now
      capture.derivedTermIds = createdTerms.map((term) => term.id)
      capture.derivedRecipeIds = recipe ? [recipe.id] : []
      return { capture, terms: createdTerms, recipe }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async reviewEntity(collection, id, input) {
    this.#requireEntityCollection(collection)
    if (!['approved', 'needs_revision'].includes(input.decision)) throw new AppError('审核决定无效', { code: 'invalid_input', fields: { decision: '必须是 approved 或 needs_revision' } })
    const now = this.now().toISOString()
    const transaction = await this.repository.transaction((draft, current) => {
      requireRevision(input.expectedRevision, current.revision)
      const entity = findById(draft[collection], id, '条目')
      if (input.decision === 'approved') {
        entity.review.human = {
          status: 'approved',
          approvedContentHash: canonicalApprovalHash(collection, entity),
          approvedAt: now,
          reviewer: 'local_user'
        }
      } else {
        entity.review.human = {
          status: 'needs_revision',
          approvedContentHash: null,
          approvedAt: null,
          reviewer: 'local_user'
        }
      }
      entity.updatedAt = now
      return { entity }
    })
    return { ...transaction.result, sourceRevision: transaction.revision, runtimeGeneratedAt: transaction.runtime.generatedAt }
  }

  async exportSources() {
    const snapshot = await this.repository.readSnapshot()
    return { schemaVersion: 1, sourceRevision: snapshot.revision, exportedAt: this.now().toISOString(), ...snapshot.state }
  }

  #requireEntityCollection(collection) {
    if (!['terms', 'recipes', 'prompts'].includes(collection)) throw new AppError('集合不存在', { code: 'not_found', statusCode: 404 })
  }

  #buildEntity(collection, input, now) {
    requireString(input?.id, 'id')
    const expectedPrefix = collection === 'terms' ? 'term_' : collection === 'recipes' ? 'recipe_' : 'prompt_'
    if (!input.id.startsWith(expectedPrefix)) throw new AppError('实体 ID 前缀无效', { code: 'invalid_input', fields: { id: `必须以 ${expectedPrefix} 开头` } })
    const common = { id: input.id, review: createPendingReview(), createdAt: now, updatedAt: now }
    if (collection === 'terms') {
      requireString(input.name, 'name')
      if (!CATEGORIES.includes(input.category)) throw new AppError('浏览分类无效', { code: 'invalid_input', fields: { category: '不在允许范围' } })
      if (!RESPONSIBILITIES.includes(input.responsibility)) throw new AppError('视觉职责无效', { code: 'invalid_input', fields: { responsibility: '不在允许范围' } })
      return { ...common, name: input.name, category: input.category, responsibility: input.responsibility, sourceCaptureIds: input.sourceCaptureIds ?? [] }
    }
    if (collection === 'recipes') {
      requireString(input.name, 'name')
      requireString(input.derivedPrompt, 'derivedPrompt', { maxBytes: MAX_PROMPT_BYTES })
      if (!Array.isArray(input.termIds) || input.termIds.length === 0) throw new AppError('配方至少需要一个原子词', { code: 'invalid_input', fields: { termIds: '不能为空' } })
      return { ...common, name: input.name, termIds: input.termIds, derivedPrompt: input.derivedPrompt, sourceCaptureIds: input.sourceCaptureIds ?? [] }
    }
    requireString(input.title, 'title')
    requireString(input.text, 'text', { maxBytes: MAX_PROMPT_BYTES })
    return { ...common, title: input.title, text: input.text, sourceType: 'manual', sourceCaptureIds: input.sourceCaptureIds ?? [] }
  }
}
