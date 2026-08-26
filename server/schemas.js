import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const MAX_CAPTURE_BYTES = 48 * 1024
export const MAX_PROMPT_BYTES = 48 * 1024
export const MAX_TERM_NAME_CODEPOINTS = 24

export const CATEGORIES = Object.freeze([
  'imaging',
  'lighting',
  'camera',
  'composition',
  'subject',
  'action',
  'emotion',
  'clothing',
  'scene',
  'prop',
  'color',
  'material',
  'typography',
  'other'
])

export const RESPONSIBILITIES = Object.freeze([
  'image_texture',
  'exposure',
  'light_color',
  'camera_angle',
  'lens',
  'framing',
  'pose',
  'gaze',
  'emotion',
  'appearance',
  'clothing',
  'environment',
  'prop',
  'color',
  'material',
  'layout',
  'other'
])

const COLLECTION_ID_PREFIX = Object.freeze({
  terms: 'term_',
  recipes: 'recipe_',
  prompts: 'prompt_'
})

const HUMAN_REVIEW_STATUSES = new Set(['pending', 'approved', 'needs_revision'])
const CAPTURE_STATUSES = new Set(['pending_review', 'processed', 'needs_review'])

export class DataValidationError extends Error {
  constructor(issues) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
    this.name = 'DataValidationError'
    this.code = 'validation_failed'
    this.statusCode = 422
    this.issues = issues
  }
}

export function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), 'utf8')
}

export function codePointLength(value) {
  return [...String(value)].length
}

export function createPendingReview() {
  return {
    machine: { status: 'pending', checkedAt: null, issues: [] },
    human: {
      status: 'pending',
      approvedContentHash: null,
      approvedAt: null,
      reviewer: null
    }
  }
}

function normalizeCanonical(value) {
  if (typeof value === 'string') return value.normalize('NFC')
  if (Array.isArray(value)) return value.map(normalizeCanonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeCanonical(value[key])])
    )
  }
  return value
}

export function canonicalStringify(value) {
  return JSON.stringify(normalizeCanonical(value))
}

export function approvalPayload(collection, entity) {
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

export function canonicalApprovalHash(collection, entity) {
  return createHash('sha256').update(canonicalStringify(approvalPayload(collection, entity))).digest('hex')
}

export function sourceContentHash(state) {
  return createHash('sha256').update(canonicalStringify({
    captures: state.captures,
    terms: state.terms,
    recipes: state.recipes,
    prompts: state.prompts
  })).digest('hex')
}

function addIssue(issues, path, code, message) {
  issues.push({ path, code, message })
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function validateUniqueStrings(value, path, issues) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    addIssue(issues, path, 'invalid_array', '必须是字符串数组')
    return []
  }
  const duplicates = value.filter((item, index) => value.indexOf(item) !== index)
  if (duplicates.length > 0) addIssue(issues, path, 'duplicate_reference', '不能包含重复引用')
  return value
}

function validateReview(collection, entity, path, issues) {
  const human = entity.review?.human
  if (!human || !HUMAN_REVIEW_STATUSES.has(human.status)) {
    addIssue(issues, `${path}.review.human.status`, 'invalid_review', '人工审核状态无效')
    return
  }
  if (human.status === 'approved') {
    const expected = canonicalApprovalHash(collection, entity)
    if (human.approvedContentHash !== expected) {
      addIssue(issues, `${path}.review.human.approvedContentHash`, 'stale_approval', '批准内容已变化，需要重新审核')
    }
    if (!validateIso(human.approvedAt) || human.reviewer !== 'local_user') {
      addIssue(issues, `${path}.review.human`, 'invalid_approval_evidence', '人工批准缺少有效时间或审核人')
    }
  }
}

function validateCapture(capture, index, issues) {
  const path = `captures[${index}]`
  if (capture?.recordType !== 'capture') addIssue(issues, `${path}.recordType`, 'invalid_record_type', '必须是 capture')
  if (!isNonEmptyString(capture?.id) || !capture.id.startsWith('cap_')) addIssue(issues, `${path}.id`, 'invalid_id', 'capture ID 无效')
  if (typeof capture?.text !== 'string' || capture.text.trim().length === 0) addIssue(issues, `${path}.text`, 'empty_capture', '原始文本不能为空')
  if (typeof capture?.text === 'string' && utf8ByteLength(capture.text) > MAX_CAPTURE_BYTES) addIssue(issues, `${path}.text`, 'capture_too_large', `原始文本不能超过 ${MAX_CAPTURE_BYTES} UTF-8 字节`)
  if (!validateIso(capture?.capturedAt) || !validateIso(capture?.receivedAt)) addIssue(issues, path, 'invalid_timestamp', '收录时间无效')
  if (capture?.sourceType !== 'browser_selection') addIssue(issues, `${path}.sourceType`, 'invalid_source_type', '来源类型无效')
  if (!CAPTURE_STATUSES.has(capture?.processingStatus)) addIssue(issues, `${path}.processingStatus`, 'invalid_capture_status', '整理状态无效')
  validateUniqueStrings(capture?.derivedTermIds, `${path}.derivedTermIds`, issues)
  validateUniqueStrings(capture?.derivedRecipeIds, `${path}.derivedRecipeIds`, issues)
}

function validateTerm(term, index, captureIds, issues) {
  const path = `terms[${index}]`
  if (!isNonEmptyString(term?.id) || !term.id.startsWith(COLLECTION_ID_PREFIX.terms)) addIssue(issues, `${path}.id`, 'invalid_id', 'term ID 无效')
  if (!isNonEmptyString(term?.name)) addIssue(issues, `${path}.name`, 'empty_name', '词名不能为空')
  if (typeof term?.name === 'string' && codePointLength(term.name) > MAX_TERM_NAME_CODEPOINTS) addIssue(issues, `${path}.name`, 'term_name_too_long', `词名不能超过 ${MAX_TERM_NAME_CODEPOINTS} 个 Unicode 字符`)
  if (!CATEGORIES.includes(term?.category)) addIssue(issues, `${path}.category`, 'invalid_category', '浏览分类无效')
  if (!RESPONSIBILITIES.includes(term?.responsibility)) addIssue(issues, `${path}.responsibility`, 'invalid_responsibility', '视觉职责无效')
  for (const captureId of validateUniqueStrings(term?.sourceCaptureIds, `${path}.sourceCaptureIds`, issues)) {
    if (!captureIds.has(captureId)) addIssue(issues, `${path}.sourceCaptureIds`, 'missing_capture', `找不到原始收录 ${captureId}`)
  }
  validateReview('terms', term, path, issues)
}

function validateRecipe(recipe, index, captureIds, termsById, issues) {
  const path = `recipes[${index}]`
  if (!isNonEmptyString(recipe?.id) || !recipe.id.startsWith(COLLECTION_ID_PREFIX.recipes)) addIssue(issues, `${path}.id`, 'invalid_id', 'recipe ID 无效')
  if (!isNonEmptyString(recipe?.name)) addIssue(issues, `${path}.name`, 'empty_name', '配方名不能为空')
  const termIds = validateUniqueStrings(recipe?.termIds, `${path}.termIds`, issues)
  if (termIds.length === 0) addIssue(issues, `${path}.termIds`, 'empty_recipe', '配方至少引用一个原子词')
  for (const termId of termIds) {
    const term = termsById.get(termId)
    if (!term) addIssue(issues, `${path}.termIds`, 'dangling_term', `找不到原子词 ${termId}`)
    if (recipe.review?.human?.status === 'approved' && term?.review?.human?.status !== 'approved') {
      addIssue(issues, `${path}.termIds`, 'unpublished_recipe_term', `已批准配方引用了未批准原子词 ${termId}`)
    }
  }
  if (!isNonEmptyString(recipe?.derivedPrompt)) addIssue(issues, `${path}.derivedPrompt`, 'empty_prompt', '配方必须保留完整 Prompt 快照')
  if (typeof recipe?.derivedPrompt === 'string' && utf8ByteLength(recipe.derivedPrompt) > MAX_PROMPT_BYTES) addIssue(issues, `${path}.derivedPrompt`, 'prompt_too_large', '配方 Prompt 超过大小限制')
  for (const captureId of validateUniqueStrings(recipe?.sourceCaptureIds, `${path}.sourceCaptureIds`, issues)) {
    if (!captureIds.has(captureId)) addIssue(issues, `${path}.sourceCaptureIds`, 'missing_capture', `找不到原始收录 ${captureId}`)
  }
  validateReview('recipes', recipe, path, issues)
}

function validatePrompt(prompt, index, captureIds, issues) {
  const path = `prompts[${index}]`
  if (!isNonEmptyString(prompt?.id) || !prompt.id.startsWith(COLLECTION_ID_PREFIX.prompts)) addIssue(issues, `${path}.id`, 'invalid_id', 'prompt ID 无效')
  if (!isNonEmptyString(prompt?.title)) addIssue(issues, `${path}.title`, 'empty_title', 'Prompt 标题不能为空')
  if (!isNonEmptyString(prompt?.text)) addIssue(issues, `${path}.text`, 'empty_prompt', 'Prompt 正文不能为空')
  if (typeof prompt?.text === 'string' && utf8ByteLength(prompt.text) > MAX_PROMPT_BYTES) addIssue(issues, `${path}.text`, 'prompt_too_large', 'Prompt 超过大小限制')
  if (prompt?.sourceType !== 'manual') addIssue(issues, `${path}.sourceType`, 'invalid_source_type', '常用 Prompt 只能是 manual 来源')
  for (const captureId of validateUniqueStrings(prompt?.sourceCaptureIds ?? [], `${path}.sourceCaptureIds`, issues)) {
    if (!captureIds.has(captureId)) addIssue(issues, `${path}.sourceCaptureIds`, 'missing_capture', `找不到原始收录 ${captureId}`)
  }
  validateReview('prompts', prompt, path, issues)
}

function validateDuplicateIds(collection, issues) {
  const seen = new Set()
  for (const [index, entity] of collection.entries()) {
    if (seen.has(entity?.id)) addIssue(issues, `[${index}].id`, 'duplicate_id', `重复 ID: ${entity.id}`)
    seen.add(entity?.id)
  }
}

export function validateState(state) {
  const issues = []
  for (const key of ['captures', 'terms', 'recipes', 'prompts']) {
    if (!Array.isArray(state?.[key])) addIssue(issues, key, 'invalid_collection', '必须是数组')
  }
  if (issues.length > 0) return { valid: false, issues, machinePassed: 0, humanApproved: 0 }

  validateDuplicateIds(state.captures, issues)
  validateDuplicateIds(state.terms, issues)
  validateDuplicateIds(state.recipes, issues)
  validateDuplicateIds(state.prompts, issues)

  state.captures.forEach((capture, index) => validateCapture(capture, index, issues))
  const captureIds = new Set(state.captures.map((capture) => capture.id))
  state.terms.forEach((term, index) => validateTerm(term, index, captureIds, issues))
  const termsById = new Map(state.terms.map((term) => [term.id, term]))
  state.recipes.forEach((recipe, index) => validateRecipe(recipe, index, captureIds, termsById, issues))
  state.prompts.forEach((prompt, index) => validatePrompt(prompt, index, captureIds, issues))

  const normalizedNames = new Map()
  state.terms.forEach((term, index) => {
    const normalized = term.name?.normalize('NFC').trim().toLocaleLowerCase('zh-CN')
    if (normalizedNames.has(normalized)) addIssue(issues, `terms[${index}].name`, 'duplicate_term_name', `与 ${normalizedNames.get(normalized)} 重名`)
    else normalizedNames.set(normalized, term.id)
  })

  const entityCount = state.terms.length + state.recipes.length + state.prompts.length
  const humanApproved = [...state.terms, ...state.recipes, ...state.prompts]
    .filter((entity) => entity.review?.human?.status === 'approved').length
  return {
    valid: issues.length === 0,
    issues,
    machinePassed: issues.length === 0 ? entityCount : Math.max(0, entityCount - new Set(issues.map((issue) => issue.path.split('.')[0])).size),
    humanApproved
  }
}

export function assertValidState(state) {
  const report = validateState(state)
  if (!report.valid) throw new DataValidationError(report.issues)
  return report
}

export function refreshMachineReviews(state, checkedAt) {
  for (const collection of ['terms', 'recipes', 'prompts']) {
    for (const entity of state[collection]) {
      entity.review ??= createPendingReview()
      entity.review.machine = { status: 'passed', checkedAt, issues: [] }
    }
  }
  return state
}
