import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CAPTURE_BYTES,
  canonicalApprovalHash,
  createPendingReview,
  utf8ByteLength,
  validateState
} from '../../server/schemas.js'
import { makeCapture, makeTerm, approve } from '../helpers/fixtures.js'

test('UTF-8 byte limits count multibyte text rather than JS code units', () => {
  assert.equal(utf8ByteLength('图'), 3)
  assert.ok(utf8ByteLength('图'.repeat(17_000)) > MAX_CAPTURE_BYTES)
})

test('canonical approval hashes normalize Unicode and unordered source IDs', () => {
  const composed = makeTerm({ name: 'é', sourceCaptureIds: ['cap_b', 'cap_a'] })
  const decomposed = makeTerm({ name: 'e\u0301', sourceCaptureIds: ['cap_a', 'cap_b'] })
  assert.equal(canonicalApprovalHash('terms', composed), canonicalApprovalHash('terms', decomposed))
})

test('valid pending content remains legal without being approved', () => {
  const capture = makeCapture()
  const state = {
    captures: [capture],
    terms: [makeTerm()],
    recipes: [],
    prompts: []
  }
  const report = validateState(state)
  assert.equal(report.valid, true)
  assert.equal(report.machinePassed, 1)
})

test('terms exceeding the display gate are rejected', () => {
  const state = {
    captures: [makeCapture()],
    terms: [makeTerm({ name: '镜'.repeat(25), review: createPendingReview() })],
    recipes: [],
    prompts: []
  }
  const report = validateState(state)
  assert.equal(report.valid, false)
  assert.match(report.issues[0].message, /24/)
})

test('an approved item with a stale content hash is rejected', () => {
  const approved = approve(makeTerm(), 'terms')
  approved.name = '近距离低位仰拍'
  const report = validateState({
    captures: [makeCapture()],
    terms: [approved],
    recipes: [],
    prompts: []
  })
  assert.equal(report.valid, false)
  assert.ok(report.issues.some((issue) => issue.code === 'stale_approval'))
})

test('approved recipes cannot reference pending terms', () => {
  const capture = makeCapture()
  const term = makeTerm()
  const recipe = approve({
    id: 'recipe_11111111-1111-4111-8111-111111111111',
    name: '青绿卧室俯卧人像',
    termIds: [term.id],
    derivedPrompt: '近距离高位斜俯拍，俯卧床面。',
    sourceCaptureIds: [capture.id],
    review: createPendingReview(),
    createdAt: '2026-08-22T01:06:00.000Z',
    updatedAt: '2026-08-22T01:06:00.000Z'
  }, 'recipes')

  const report = validateState({ captures: [capture], terms: [term], recipes: [recipe], prompts: [] })
  assert.equal(report.valid, false)
  assert.ok(report.issues.some((issue) => issue.code === 'unpublished_recipe_term'))
})

test('validator reports duplicate IDs, dangling references, invalid captures, and malformed prompts', () => {
  const capture = makeCapture({
    text: ' ',
    capturedAt: 'not-a-date',
    sourceType: 'page_history',
    processingStatus: 'unknown',
    derivedTermIds: ['term_x', 'term_x']
  })
  const term = makeTerm({ sourceCaptureIds: ['cap_missing'] })
  const duplicate = makeTerm({ id: term.id, name: term.name })
  const prompt = {
    id: 'prompt_bad', title: '', text: '', sourceType: 'derived', sourceCaptureIds: ['cap_missing'],
    review: createPendingReview(), createdAt: 'x', updatedAt: 'x'
  }
  const report = validateState({ captures: [capture], terms: [term, duplicate], recipes: [], prompts: [prompt] })
  const codes = new Set(report.issues.map((issue) => issue.code))
  for (const code of ['duplicate_id', 'empty_capture', 'invalid_timestamp', 'invalid_source_type', 'invalid_capture_status', 'duplicate_reference', 'missing_capture', 'duplicate_term_name', 'empty_title', 'empty_prompt']) {
    assert.equal(codes.has(code), true, `missing issue ${code}`)
  }
})

test('validator rejects non-array collections without throwing', () => {
  const report = validateState({ captures: null, terms: [], recipes: [], prompts: [] })
  assert.equal(report.valid, false)
  assert.equal(report.issues[0].code, 'invalid_collection')
})
