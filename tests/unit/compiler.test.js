import test from 'node:test'
import assert from 'node:assert/strict'

import { compileLibrary } from '../../server/compiler.js'
import { makeCapture, makeTerm, approve } from '../helpers/fixtures.js'

test('compiler excludes valid pending terms without failing', () => {
  const runtime = compileLibrary({
    captures: [makeCapture()],
    terms: [makeTerm()],
    recipes: [],
    prompts: []
  }, { revision: 2, generatedAt: '2026-08-22T02:00:00.000Z' })

  assert.equal(runtime.sourceRevision, 2)
  assert.equal(runtime.terms.length, 0)
  assert.equal(runtime.counts.sourceTerms, 1)
  assert.equal(runtime.counts.publishedTerms, 0)
})

test('compiler publishes only machine-valid content with a current human approval', () => {
  const approved = approve(makeTerm(), 'terms')
  const runtime = compileLibrary({
    captures: [makeCapture()],
    terms: [approved],
    recipes: [],
    prompts: []
  }, { revision: 3, generatedAt: '2026-08-22T02:00:00.000Z' })

  assert.equal(runtime.terms.length, 1)
  assert.equal(runtime.terms[0].name, '近距离高位斜俯拍')
  assert.equal(runtime.counts.machinePassed, 1)
  assert.equal(runtime.counts.humanApproved, 1)
  assert.match(runtime.sourceContentHash, /^[a-f0-9]{64}$/)
})

test('compiler publishes approved recipes and common prompts with their distinct fields', () => {
  const capture = makeCapture()
  const term = approve(makeTerm(), 'terms')
  const recipe = approve({
    id: 'recipe_66666666-6666-4666-8666-666666666666',
    name: '高位俯拍人像',
    termIds: [term.id],
    derivedPrompt: '近距离高位斜俯拍。',
    sourceCaptureIds: [capture.id],
    review: term.review,
    createdAt: term.createdAt,
    updatedAt: term.updatedAt
  }, 'recipes')
  const prompt = approve({
    id: 'prompt_66666666-6666-4666-8666-666666666666',
    title: '常用写真指令',
    text: '写实生活方式人像。',
    sourceType: 'manual',
    sourceCaptureIds: [],
    review: term.review,
    createdAt: term.createdAt,
    updatedAt: term.updatedAt
  }, 'prompts')
  const runtime = compileLibrary({ captures: [capture], terms: [term], recipes: [recipe], prompts: [prompt] }, { revision: 8 })
  assert.equal(runtime.recipes[0].derivedPrompt, recipe.derivedPrompt)
  assert.equal(runtime.prompts[0].title, prompt.title)
  assert.equal(runtime.counts.publishedRecipes, 1)
  assert.equal(runtime.counts.publishedPrompts, 1)
})
