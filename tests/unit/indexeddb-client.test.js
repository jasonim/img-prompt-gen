import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'

import { createIndexedDbClient } from '../../extension/lib/indexeddb-client.js'

function createClient({ name = `zhiju-test-${crypto.randomUUID()}`, now = () => new Date('2026-08-26T00:00:00.000Z') } = {}) {
  return createIndexedDbClient({ indexedDB: new IDBFactory(), databaseName: name, now })
}

test('IndexedDB client starts ready without pairing or a local HTTP service', async () => {
  const client = createClient()

  assert.equal(await client.isReady(), true)
  assert.deepEqual(await client.getLibrary(), {
    schemaVersion: 1,
    sourceRevision: 0,
    sourceContentHash: await client.hashSources({ captures: [], terms: [], recipes: [], prompts: [] }),
    generatedAt: null,
    counts: {
      captures: 0,
      pendingCaptures: 0,
      sourceTerms: 0,
      sourceRecipes: 0,
      sourcePrompts: 0,
      machinePassed: 0,
      humanApproved: 0,
      publishedTerms: 0,
      publishedRecipes: 0,
      publishedPrompts: 0
    },
    terms: [],
    recipes: [],
    prompts: []
  })
  assert.equal((await client.health()).storage, 'indexeddb')
})

test('captures preserve exact selected text and remain idempotent', async () => {
  const client = createClient()
  const capture = {
    id: 'cap_11111111-1111-4111-8111-111111111111',
    text: '  近距离高位斜俯拍\n保留原始空白  ',
    capturedAt: '2026-08-26T00:00:00.000Z',
    sourceType: 'browser_selection'
  }

  const created = await client.createCapture(capture)
  assert.equal(created.deduplicated, false)
  assert.equal(created.capture.text, capture.text)
  assert.equal(created.sourceRevision, 1)

  const duplicate = await client.createCapture(capture)
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.sourceRevision, 1)

  await assert.rejects(
    client.createCapture({ ...capture, text: '不同正文' }),
    (error) => error.code === 'idempotency_conflict'
  )

  const workbench = await client.getWorkbench()
  assert.equal(workbench.captures[0].text, capture.text)
})

test('organize, review, compile, and edit keep human approval bound to current content', async () => {
  let tick = 0
  const client = createClient({ now: () => new Date(Date.UTC(2026, 7, 26, 0, 0, tick++)) })
  const captureId = 'cap_22222222-2222-4222-8222-222222222222'
  const termId = 'term_22222222-2222-4222-8222-222222222222'
  const recipeId = 'recipe_22222222-2222-4222-8222-222222222222'

  let result = await client.createCapture({
    id: captureId,
    text: '窗边局部高曝光，安静轻倦意。',
    capturedAt: '2026-08-26T00:00:00.000Z',
    sourceType: 'browser_selection'
  })
  result = await client.organizeCapture(captureId, {
    expectedRevision: result.sourceRevision,
    terms: [{ id: termId, name: '窗边局部高曝光', category: 'lighting', responsibility: 'exposure' }],
    recipe: { id: recipeId, name: '窗光倦意', termIds: [termId], derivedPrompt: '窗边局部高曝光，安静轻倦意。' }
  })

  await assert.rejects(
    client.reviewEntity('recipes', recipeId, { expectedRevision: result.sourceRevision, decision: 'approved' }),
    (error) => error.code === 'validation_failed'
  )

  result = await client.reviewEntity('terms', termId, { expectedRevision: result.sourceRevision, decision: 'approved' })
  result = await client.reviewEntity('recipes', recipeId, { expectedRevision: result.sourceRevision, decision: 'approved' })
  let library = await client.getLibrary()
  assert.equal(library.terms.length, 1)
  assert.equal(library.recipes.length, 1)

  await assert.rejects(
    client.updateEntity('terms', termId, { expectedRevision: 1, name: '过期写入' }),
    (error) => error.code === 'revision_conflict'
  )

  result = await client.updateEntity('terms', termId, {
    expectedRevision: result.sourceRevision,
    name: '窗侧局部高曝光'
  })
  assert.deepEqual(result.affectedRecipeIds, [recipeId])
  library = await client.getLibrary()
  assert.equal(library.terms.length, 0)
  assert.equal(library.recipes.length, 0)

  const workbench = await client.getWorkbench()
  assert.equal(workbench.terms[0].review.human.status, 'pending')
  assert.equal(workbench.recipes[0].review.human.status, 'pending')
})

test('manual prompts, guarded deletion, and export stay inside the selected database', async () => {
  const first = createClient({ name: 'zhiju-isolated-first' })
  const second = createClient({ name: 'zhiju-isolated-second' })
  const promptId = 'prompt_33333333-3333-4333-8333-333333333333'

  let result = await first.createEntity('prompts', {
    id: promptId,
    expectedRevision: 0,
    title: '常用写真指令',
    text: '写实生活方式人像。'
  })
  result = await first.reviewEntity('prompts', promptId, {
    expectedRevision: result.sourceRevision,
    decision: 'approved'
  })
  assert.equal((await first.getLibrary()).prompts.length, 1)
  assert.equal((await second.getLibrary()).prompts.length, 0)

  const exported = await first.exportSources()
  assert.equal(exported.sourceRevision, result.sourceRevision)
  assert.equal(exported.prompts[0].text, '写实生活方式人像。')
  assert.equal('token' in exported, false)

  await first.deleteEntity('prompts', promptId, { expectedRevision: result.sourceRevision })
  assert.equal((await first.getLibrary()).prompts.length, 0)
})

test('a validated backup can replace the current database without trusting its old revision', async () => {
  const source = createClient({ name: 'zhiju-import-source' })
  const target = createClient({ name: 'zhiju-import-target' })
  const promptId = 'prompt_44444444-4444-4444-8444-444444444444'

  let result = await source.createEntity('prompts', {
    id: promptId,
    expectedRevision: 0,
    title: '迁移后的 Prompt',
    text: '完整保留旧词库正文。'
  })
  result = await source.reviewEntity('prompts', promptId, {
    expectedRevision: result.sourceRevision,
    decision: 'approved'
  })

  const backup = await source.exportSources()
  const imported = await target.importSources(backup, { expectedRevision: 0 })
  assert.equal(imported.sourceRevision, 1)
  assert.equal(imported.importedCounts.prompts, 1)
  assert.equal((await target.getLibrary()).prompts[0].text, '完整保留旧词库正文。')

  await assert.rejects(
    target.importSources({ ...backup, prompts: [{ ...backup.prompts[0], text: '' }] }, { expectedRevision: 1 }),
    (error) => error.code === 'validation_failed'
  )
  assert.equal((await target.getLibrary()).prompts[0].text, '完整保留旧词库正文。')
})

test('unsafe operations fail before they can corrupt the current snapshot', async () => {
  assert.throws(() => createIndexedDbClient({ indexedDB: null }), /indexedDB is required/)
  assert.throws(() => createIndexedDbClient({ indexedDB: new IDBFactory(), cryptoImpl: null }), /Web Crypto is required/)

  const client = createClient({ name: 'zhiju-guardrails' })
  const validCapture = {
    id: 'cap_55555555-5555-4555-8555-555555555555',
    text: '保留正文',
    capturedAt: '2026-08-26T00:00:00.000Z',
    sourceType: 'browser_selection'
  }
  await assert.rejects(client.createCapture({ ...validCapture, id: 'wrong' }), (error) => error.code === 'invalid_input')
  await assert.rejects(client.createCapture({ ...validCapture, capturedAt: 'not-a-date' }), (error) => error.code === 'invalid_input')
  await assert.rejects(client.createCapture({ ...validCapture, sourceType: 'page' }), (error) => error.code === 'invalid_input')
  await assert.rejects(client.createCapture({ ...validCapture, text: '字'.repeat(49 * 1024) }), (error) => error.code === 'input_too_large')
  await assert.rejects(client.createEntity('unknown', {}), (error) => error.code === 'not_found')
  await assert.rejects(client.createEntity('terms', { id: 'term_missing_revision' }), (error) => error.code === 'revision_required')
  await assert.rejects(client.createEntity('terms', {
    id: 'term_invalid_category', expectedRevision: 0, name: '词', category: 'bad', responsibility: 'other'
  }), (error) => error.code === 'invalid_input')
  await assert.rejects(client.createEntity('recipes', {
    id: 'recipe_empty', expectedRevision: 0, name: '配方', termIds: [], derivedPrompt: '正文'
  }), (error) => error.code === 'invalid_input')
  await assert.rejects(client.createEntity('prompts', {
    id: 'prompt_large', expectedRevision: 0, title: '太长', text: '字'.repeat(49 * 1024)
  }), (error) => error.code === 'input_too_large')
  await assert.rejects(client.reviewEntity('terms', 'term_none', { expectedRevision: 0, decision: 'maybe' }), (error) => error.code === 'invalid_input')
  await assert.rejects(client.deleteEntity('prompts', 'prompt_none', { expectedRevision: 0 }), (error) => error.code === 'not_found')
  await assert.rejects(client.deleteCapture('cap_none', { expectedRevision: 0 }), (error) => error.code === 'not_found')
  await assert.rejects(client.organizeCapture('cap_none', { expectedRevision: 0, terms: [] }), (error) => error.code === 'invalid_input')
  await assert.rejects(client.getCollection('unknown'), (error) => error.code === 'not_found')
  await assert.rejects(client.importSources({ schemaVersion: 2 }, { expectedRevision: 0 }), (error) => error.code === 'invalid_backup')
  assert.equal((await client.health()).sourceRevision, 0)
})

test('backup validation reports malformed records and preserves the previous snapshot', async () => {
  const client = createClient({ name: 'zhiju-invalid-backup' })
  const pending = {
    machine: { status: 'pending', checkedAt: null, issues: [] },
    human: { status: 'pending', approvedContentHash: null, approvedAt: null, reviewer: null }
  }
  const approvedButStale = {
    machine: { status: 'passed', checkedAt: 'bad', issues: [] },
    human: { status: 'approved', approvedContentHash: 'stale', approvedAt: 'bad', reviewer: 'someone_else' }
  }
  const malformed = {
    schemaVersion: 1,
    captures: [
      { recordType: 'wrong', id: 'bad', text: '', capturedAt: 'bad', receivedAt: 'bad', sourceType: 'page', processingStatus: 'bad', derivedTermIds: null, derivedRecipeIds: ['x', 'x'] },
      { recordType: 'capture', id: 'bad', text: '字'.repeat(49 * 1024), capturedAt: '2026-08-26T00:00:00.000Z', receivedAt: '2026-08-26T00:00:00.000Z', sourceType: 'browser_selection', processingStatus: 'pending_review', derivedTermIds: [], derivedRecipeIds: [] }
    ],
    terms: [
      { id: 'bad', name: '', category: 'bad', responsibility: 'bad', sourceCaptureIds: ['missing'], review: { human: { status: 'wrong' } } },
      { id: 'bad', name: '词'.repeat(25), category: 'other', responsibility: 'other', sourceCaptureIds: [], review: approvedButStale },
      { id: 'term_duplicate_name', name: '重复', category: 'other', responsibility: 'other', sourceCaptureIds: [], review: pending },
      { id: 'term_duplicate_name_2', name: ' 重复 ', category: 'other', responsibility: 'other', sourceCaptureIds: [], review: pending }
    ],
    recipes: [
      { id: 'bad', name: '', termIds: [], derivedPrompt: '', sourceCaptureIds: ['missing'], review: pending },
      { id: 'recipe_bad', name: '坏配方', termIds: ['missing'], derivedPrompt: '字'.repeat(49 * 1024), sourceCaptureIds: [], review: approvedButStale }
    ],
    prompts: [
      { id: 'bad', title: '', text: '', sourceType: 'page', sourceCaptureIds: ['missing'], review: pending },
      { id: 'bad', title: '太长', text: '字'.repeat(49 * 1024), sourceType: 'manual', sourceCaptureIds: [], review: approvedButStale }
    ]
  }

  await assert.rejects(
    client.importSources(malformed, { expectedRevision: 0 }),
    (error) => {
      assert.equal(error.code, 'validation_failed')
      const codes = new Set(error.fields.issues.map((issue) => issue.code))
      for (const code of ['duplicate_id', 'invalid_array', 'duplicate_reference', 'invalid_review', 'stale_approval', 'invalid_approval_evidence', 'missing_capture', 'dangling_term', 'prompt_too_large']) assert.equal(codes.has(code), true)
      return true
    }
  )
  assert.equal((await client.health()).sourceRevision, 0)
})
