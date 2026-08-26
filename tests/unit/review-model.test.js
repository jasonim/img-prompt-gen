import test from 'node:test'
import assert from 'node:assert/strict'

import { buildOrganizePayload } from '../../extension/lib/review-model.js'

test('organize payload keeps two independent judgments per term and recipe relationships', () => {
  const payload = buildOrganizePayload({
    expectedRevision: 4,
    terms: [
      { id: 'term_1', name: '近距离高位斜俯拍', category: 'camera', responsibility: 'camera_angle' },
      { id: 'term_2', name: '俯卧床面', category: 'action', responsibility: 'pose' }
    ],
    recipe: { id: 'recipe_1', name: '高位俯拍人像', derivedPrompt: '近距离高位斜俯拍，俯卧床面。' }
  })
  assert.deepEqual(payload.recipe.termIds, ['term_1', 'term_2'])
  assert.equal(payload.terms[0].responsibility, 'camera_angle')
})

test('organize payload rejects terms missing category or responsibility', () => {
  assert.throws(() => buildOrganizePayload({
    expectedRevision: 1,
    terms: [{ id: 'term_1', name: '模糊词', category: '', responsibility: '' }],
    recipe: null
  }), /分类|职责/)
})

test('organize payload rejects stale, empty, unnamed, and incomplete recipe input', () => {
  assert.throws(() => buildOrganizePayload({ expectedRevision: null, terms: [] }), /当前数据版本/)
  assert.throws(() => buildOrganizePayload({ expectedRevision: 1, terms: [] }), /至少添加/)
  assert.throws(() => buildOrganizePayload({ expectedRevision: 1, terms: [{ id: 'term_1', name: ' ', category: 'other', responsibility: 'other' }] }), /缺少名称/)
  assert.throws(() => buildOrganizePayload({
    expectedRevision: 1,
    terms: [{ id: 'term_1', name: '词', category: 'other', responsibility: 'other' }],
    recipe: { id: 'recipe_1', name: '配方', derivedPrompt: ' ' }
  }), /完整 Prompt/)
})
