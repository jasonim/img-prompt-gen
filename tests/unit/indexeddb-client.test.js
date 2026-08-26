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
