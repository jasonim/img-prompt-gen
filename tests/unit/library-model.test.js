import test from 'node:test'
import assert from 'node:assert/strict'

import { flattenLibrary, filterLibrary, presentEntry } from '../../extension/lib/library-model.js'

const library = {
  terms: [
    { id: 'term_1', name: '近距离高位斜俯拍', category: 'camera', responsibility: 'camera_angle' },
    { id: 'term_2', name: '窗边局部高曝光', category: 'lighting', responsibility: 'exposure' }
  ],
  recipes: [{ id: 'recipe_1', name: '青绿卧室俯卧人像', derivedPrompt: '完整描述' }],
  prompts: [{ id: 'prompt_1', title: '常用写真指令', text: '写实人像' }]
}

test('library flattening preserves entity type for rendering and actions', () => {
  const entries = flattenLibrary(library)
  assert.equal(entries.length, 4)
  assert.deepEqual(entries.map((entry) => entry.type), ['term', 'term', 'recipe', 'prompt'])
})

test('search is case-insensitive and spans names plus prompt text', () => {
  assert.deepEqual(filterLibrary(library, { query: '高位' }).map((item) => item.id), ['term_1'])
  assert.deepEqual(filterLibrary(library, { query: '写实' }).map((item) => item.id), ['prompt_1'])
})

test('type and category filters compose', () => {
  assert.deepEqual(filterLibrary(library, { type: 'term', category: 'lighting' }).map((item) => item.id), ['term_2'])
})

test('compact card presentation provides a title, preview, and useful tags', () => {
  assert.deepEqual(presentEntry(library.terms[0]), {
    title: '近距离高位斜俯拍',
    body: '镜头 · 机位角度',
    tags: ['原子词', '镜头', '机位角度']
  })
  assert.deepEqual(presentEntry(library.prompts[0]), {
    title: '常用写真指令',
    body: '写实人像',
    tags: ['常用 Prompt', '完整指令']
  })
})

test('card presentation handles recipes, unknown labels, and unnamed prompts', () => {
  assert.deepEqual(presentEntry({ type: 'recipe', name: '配方', derivedPrompt: '正文', termIds: ['a', 'b'] }), {
    title: '配方', body: '正文', tags: ['组合配方', '2 个原子词']
  })
  assert.deepEqual(presentEntry({ type: 'term', name: '未知', category: 'custom', responsibility: 'custom_role' }), {
    title: '未知', body: 'custom · custom_role', tags: ['原子词', 'custom', 'custom_role']
  })
  assert.deepEqual(presentEntry(null), { title: '未命名 Prompt', body: '', tags: ['常用 Prompt', '完整指令'] })
  assert.deepEqual(flattenLibrary(), [])
})
