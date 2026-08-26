import { createIndexedDbClient } from './lib/indexeddb-client.js'
import { createQueueManager, LAST_CAPTURE_STATUS_KEY, QUEUE_KEY } from './lib/capture-queue.js'
import { CATEGORY_LABELS, RESPONSIBILITY_LABELS, filterLibrary, presentEntry } from './lib/library-model.js'
import { buildOrganizePayload } from './lib/review-model.js'
import { createUsageTracker, USAGE_COUNTS_KEY } from './lib/usage-model.js'

const api = createIndexedDbClient()
const queue = createQueueManager({ storage: chrome.storage.local, api })
const usage = createUsageTracker(chrome.storage.local)

const dom = Object.fromEntries([
  'service-status', 'app-shell',
  'library-view', 'workbench-view', 'queue-view', 'editor-view', 'library-search', 'type-filter',
  'category-filter', 'library-summary', 'library-list', 'workbench-list', 'queue-list',
  'last-capture-status', 'retry-queue-button', 'export-backup-button', 'import-backup-input',
  'new-entry-button', 'entity-form', 'entity-id',
  'entity-type', 'entity-title', 'term-fields', 'recipe-fields', 'text-fields', 'entity-category',
  'entity-responsibility', 'entity-term-ids', 'entity-text', 'delete-entry-button', 'editor-message',
  'organize-form', 'organize-capture-id', 'organize-source', 'organize-term-rows',
  'add-term-row-button', 'organize-recipe-name', 'organize-recipe-prompt', 'copy-toast'
].map((id) => [id, document.getElementById(id)]))

const state = {
  library: { sourceRevision: 0, terms: [], recipes: [], prompts: [] },
  workbench: { sourceRevision: 0, captures: [], terms: [], recipes: [], prompts: [] },
  usageCounts: {},
  editing: null,
  organizingCapture: null,
  initialViewResolved: false
}

let toastTimer = null

function element(tag, className = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function button(text, handler, className = 'button small') {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', handler)
  return node
}

function setMessage(node, message, success = false) {
  node.textContent = message ?? ''
  node.classList.toggle('success', success)
}

function setServiceStatus(label, mode = '') {
  dom['service-status'].textContent = label
  dom['service-status'].className = `status-dot ${mode}`.trim()
}

function fillSelect(select, labels, allLabel = null) {
  select.replaceChildren()
  if (allLabel) {
    const option = element('option', '', allLabel)
    option.value = 'all'
    select.append(option)
  }
  for (const [value, label] of Object.entries(labels)) {
    const option = element('option', '', label)
    option.value = value
    select.append(option)
  }
}

function activateView(viewId) {
  for (const view of document.querySelectorAll('.view')) {
    const active = view.id === viewId
    view.hidden = !active
    view.classList.toggle('active-view', active)
  }
  for (const tab of document.querySelectorAll('.nav-tab')) tab.classList.toggle('active', tab.dataset.target === viewId)
}

function emptyState(message) {
  return element('div', 'empty-state', message)
}

function collectionForType(type) {
  return type === 'term' ? 'terms' : type === 'recipe' ? 'recipes' : 'prompts'
}

function showCopyToast(message) {
  dom['copy-toast'].textContent = message
  dom['copy-toast'].hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { dom['copy-toast'].hidden = true }, 1600)
}

async function copyText(text, entryId = null) {
  try {
    await navigator.clipboard.writeText(text)
    if (entryId) state.usageCounts[entryId] = await usage.increment(entryId)
    if (entryId) renderLibrary()
    showCopyToast('已复制到剪贴板')
  } catch {
    showCopyToast('复制失败，请检查权限')
  }
}

function presentCapture(entry) {
  const lines = String(entry.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const titleLine = lines.find((line) => line.startsWith('标题：'))
  const metadata = ['标题：', '作者：', '原文：', 'X Article：']
  const body = lines.filter((line) => !metadata.some((prefix) => line.startsWith(prefix))).join(' ')
  return {
    title: titleLine?.slice(3).trim() || '待整理原料',
    body: body || entry.text,
    tags: ['原始收录', entry.processingStatus === 'needs_review' ? '需返修' : '待整理']
  }
}

function createEntryCard(entry, { workbench = false } = {}) {
  const card = element('article', `entry-card ${entry.type ?? 'capture'}`)
  const presentation = entry.type ? presentEntry(entry) : presentCapture(entry)
  const main = element('div', 'entry-main')
  main.append(element('h3', 'entry-title', presentation.title))
  main.append(element('p', 'entry-body', presentation.body))
  const tags = element('div', 'entry-tags')
  for (const tag of presentation.tags) tags.append(element('span', 'entry-tag', tag))
  if (entry.review?.human?.status) {
    tags.append(element('span', 'entry-tag pending', entry.review.human.status === 'needs_revision' ? '需返修' : '待审核'))
  }
  main.append(tags)
  card.append(main)

  const copyValue = entry.type === 'term' ? entry.name : entry.type === 'recipe' ? entry.derivedPrompt : entry.type === 'prompt' ? entry.text : entry.text
  const utility = element('div', 'entry-utility')
  if (entry.type && !workbench) utility.append(element('span', 'entry-usage', `${state.usageCounts[entry.id] ?? 0} 次`))
  utility.append(button('复制', () => void copyText(copyValue, entry.type && !workbench ? entry.id : null), 'button copy-button'))
  card.append(utility)

  const actions = element('div', 'entry-actions')
  if (entry.type) {
    actions.append(button('编辑', () => openEntityEditor(entry)))
    if (workbench) {
      actions.append(button('人工批准', () => void reviewEntry(entry, 'approved'), 'button small primary'))
      actions.append(button('需返修', () => void reviewEntry(entry, 'needs_revision'), 'button small danger'))
    }
  } else {
    actions.append(button('开始整理', () => openOrganizeEditor(entry), 'button small primary'))
    actions.append(button('删除原料', () => void deleteCapture(entry), 'button small danger'))
  }
  card.append(actions)
  return card
}

function renderLibrary() {
  const entries = filterLibrary(state.library, {
    query: dom['library-search'].value,
    type: dom['type-filter'].value,
    category: dom['category-filter'].value
  })
  dom['library-summary'].textContent = `${entries.length} 条可直接使用 · runtime revision ${state.library.sourceRevision}`
  dom['library-list'].replaceChildren(...(entries.length ? entries.map((entry) => createEntryCard(entry)) : [emptyState('正式词库还是空的。去整理台批准第一条原子词。')]))
}

function renderWorkbench() {
  const entries = [
    ...state.workbench.captures,
    ...state.workbench.terms.map((entry) => ({ ...entry, type: 'term' })),
    ...state.workbench.recipes.map((entry) => ({ ...entry, type: 'recipe' })),
    ...state.workbench.prompts.map((entry) => ({ ...entry, type: 'prompt' }))
  ]
  dom['workbench-list'].replaceChildren(...(entries.length ? entries.map((entry) => createEntryCard(entry, { workbench: true })) : [emptyState('没有待整理或待审核内容。')]))
}

function queueLabel(item) {
  return item.state === 'synced' ? '已保存' : item.state === 'syncing' ? '保存中' : item.state === 'failed' ? '等待重试' : '等待保存'
}

async function renderQueue() {
  const items = await queue.list()
  const cards = items.map((item) => {
    const card = element('article', 'entry-card capture')
    card.append(element('div', 'entry-meta', queueLabel(item)))
    card.append(element('h3', 'entry-title', item.id))
    card.append(element('p', 'entry-body', item.text ?? `保存于 ${item.syncedAt ?? item.updatedAt}`))
    const actions = element('div', 'entry-actions')
    if (item.state === 'failed' || item.state === 'queued') actions.append(button('重试', () => void retryQueue(), 'button small primary'))
    actions.append(button(item.state === 'synced' ? '清除收据' : '删除暂存', async () => {
      if (item.state === 'synced') await queue.clearReceipt(item.id)
      else await queue.removePending(item.id)
      await renderQueue()
    }, 'button small danger'))
    card.append(actions)
    return card
  })
  dom['queue-list'].replaceChildren(...(cards.length ? cards : [emptyState('浏览器暂存区为空。')]))
  const last = (await chrome.storage.local.get(LAST_CAPTURE_STATUS_KEY))[LAST_CAPTURE_STATUS_KEY]
  dom['last-capture-status'].textContent = last?.message ?? '右键收录的本机保存状态会显示在这里。'
}

async function exportBackup() {
  try {
    const backup = await api.exportSources()
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `zhiju-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    showCopyToast('备份已导出')
  } catch (error) {
    dom['last-capture-status'].textContent = error.nextAction ?? error.message
  }
}

async function importBackup(file) {
  if (!file) return
  try {
    const backup = JSON.parse(await file.text())
    const health = await api.health()
    const counts = health.counts
    const hasData = counts.captures + counts.sourceTerms + counts.sourceRecipes + counts.sourcePrompts > 0
    if (hasData && !confirm('导入会替换当前扩展内的全部词库。请先导出备份，确定继续吗？')) return
    const imported = await api.importSources(backup, { expectedRevision: health.sourceRevision })
    await loadData()
    dom['last-capture-status'].textContent = `导入完成：${Object.values(imported.importedCounts).reduce((sum, count) => sum + count, 0)} 条记录`
  } catch (error) {
    dom['last-capture-status'].textContent = error.nextAction ?? error.message
  } finally {
    dom['import-backup-input'].value = ''
  }
}

function syncEditorFields() {
  const type = dom['entity-type'].value
  dom['term-fields'].hidden = type !== 'term'
  dom['recipe-fields'].hidden = type !== 'recipe'
  dom['text-fields'].hidden = type === 'term'
  dom['entity-text'].required = type !== 'term'
}

function openEntityEditor(entry = null) {
  state.organizingCapture = null
  state.editing = entry
  dom['entity-form'].hidden = false
  dom['organize-form'].hidden = true
  dom['entity-id'].value = entry?.id ?? ''
  dom['entity-type'].value = entry?.type ?? 'term'
  dom['entity-type'].disabled = Boolean(entry)
  dom['entity-title'].value = entry?.name ?? entry?.title ?? ''
  dom['entity-category'].value = entry?.category ?? 'other'
  dom['entity-responsibility'].value = entry?.responsibility ?? 'other'
  dom['entity-term-ids'].value = entry?.termIds?.join(', ') ?? ''
  dom['entity-text'].value = entry?.derivedPrompt ?? entry?.text ?? ''
  dom['delete-entry-button'].hidden = !entry
  syncEditorFields()
  setMessage(dom['editor-message'], entry ? '编辑已批准内容会自动撤销原批准。' : '新条目先进入待审核区。')
  activateView('editor-view')
}

function createOptionSelect(labels, className) {
  const select = element('select', className)
  for (const [value, label] of Object.entries(labels)) {
    const option = element('option', '', label)
    option.value = value
    select.append(option)
  }
  return select
}

function addTermRow(values = {}) {
  const row = element('div', 'term-row')
  row.dataset.id = values.id ?? `term_${crypto.randomUUID()}`
  const name = element('input', 'term-name')
  name.placeholder = '一个可独立替换的视觉变量'
  name.maxLength = 24
  name.value = values.name ?? ''
  name.required = true
  const category = createOptionSelect(CATEGORY_LABELS, 'term-category')
  category.value = values.category ?? 'other'
  const responsibility = createOptionSelect(RESPONSIBILITY_LABELS, 'term-responsibility')
  responsibility.value = values.responsibility ?? 'other'
  const remove = button('移除此词', () => row.remove(), 'button small danger remove-row')
  row.append(name, category, responsibility, remove)
  dom['organize-term-rows'].append(row)
}

function openOrganizeEditor(capture) {
  state.editing = null
  state.organizingCapture = capture
  dom['entity-form'].hidden = true
  dom['organize-form'].hidden = false
  dom['organize-capture-id'].value = capture.id
  dom['organize-source'].textContent = capture.text
  dom['organize-term-rows'].replaceChildren()
  addTermRow()
  dom['organize-recipe-name'].value = ''
  dom['organize-recipe-prompt'].value = capture.text
  setMessage(dom['editor-message'], '每个原子词都要分别选择浏览分类和真实视觉职责。')
  activateView('editor-view')
}

async function reviewEntry(entry, decision) {
  const collection = collectionForType(entry.type)
  try {
    await api.reviewEntity(collection, entry.id, { expectedRevision: state.workbench.sourceRevision, decision })
    await loadData()
    activateView(decision === 'approved' ? 'library-view' : 'workbench-view')
  } catch (error) {
    setMessage(dom['editor-message'], error.nextAction ?? error.message)
    activateView('editor-view')
  }
}

async function deleteCapture(capture) {
  if (!confirm('删除后将无法从原文追溯。确定删除这条未整理原料吗？')) return
  try {
    await api.deleteCapture(capture.id, { expectedRevision: state.workbench.sourceRevision })
    await loadData()
    activateView('workbench-view')
  } catch (error) {
    setMessage(dom['editor-message'], error.nextAction ?? error.message)
    activateView('editor-view')
  }
}

async function retryQueue() {
  setServiceStatus('保存中')
  await queue.drain()
  await renderQueue()
  try {
    await loadData()
  } catch {
    setServiceStatus('存储异常', 'error')
  }
}

async function loadData() {
  try {
    const [library, workbench, health, usageCounts] = await Promise.all([api.getLibrary(), api.getWorkbench(), api.health(), usage.all()])
    state.library = library
    state.workbench = workbench
    state.usageCounts = usageCounts
    renderLibrary()
    renderWorkbench()
    await renderQueue()
    setServiceStatus(`R${health.sourceRevision} · 本机`, 'online')
    if (!state.initialViewResolved) {
      const libraryCount = library.terms.length + library.recipes.length + library.prompts.length
      const pendingCount = workbench.captures.length + workbench.terms.length + workbench.recipes.length + workbench.prompts.length
      if (libraryCount === 0 && pendingCount > 0) activateView('workbench-view')
      state.initialViewResolved = true
    }
  } catch (error) {
    setServiceStatus('存储异常', 'error')
    await renderQueue()
    setMessage(dom['editor-message'], error.nextAction ?? error.message)
  }
}

for (const tab of document.querySelectorAll('.nav-tab')) tab.addEventListener('click', () => activateView(tab.dataset.target))
dom['library-search'].addEventListener('input', renderLibrary)
dom['type-filter'].addEventListener('change', renderLibrary)
dom['category-filter'].addEventListener('change', renderLibrary)
dom['entity-type'].addEventListener('change', syncEditorFields)
dom['new-entry-button'].addEventListener('click', () => openEntityEditor())
dom['retry-queue-button'].addEventListener('click', () => void retryQueue())
dom['export-backup-button'].addEventListener('click', () => void exportBackup())
dom['import-backup-input'].addEventListener('change', () => void importBackup(dom['import-backup-input'].files?.[0]))
dom['add-term-row-button'].addEventListener('click', () => addTermRow())

dom['entity-form'].addEventListener('submit', async (event) => {
  event.preventDefault()
  const type = dom['entity-type'].value
  const collection = collectionForType(type)
  const id = dom['entity-id'].value || `${type}_${crypto.randomUUID()}`
  const expectedRevision = state.workbench.sourceRevision || state.library.sourceRevision
  const payload = type === 'term'
    ? { id, expectedRevision, name: dom['entity-title'].value, category: dom['entity-category'].value, responsibility: dom['entity-responsibility'].value }
    : type === 'recipe'
      ? { id, expectedRevision, name: dom['entity-title'].value, termIds: dom['entity-term-ids'].value.split(',').map((value) => value.trim()).filter(Boolean), derivedPrompt: dom['entity-text'].value }
      : { id, expectedRevision, title: dom['entity-title'].value, text: dom['entity-text'].value }
  try {
    if (state.editing) await api.updateEntity(collection, id, payload)
    else await api.createEntity(collection, payload)
    setMessage(dom['editor-message'], '已保存到待审核区', true)
    await loadData()
    activateView('workbench-view')
  } catch (error) {
    setMessage(dom['editor-message'], error.nextAction ?? error.message)
  }
})

dom['delete-entry-button'].addEventListener('click', async () => {
  if (!state.editing || !confirm('确定删除这条内容吗？被配方引用的原子词不会被删除。')) return
  try {
    await api.deleteEntity(collectionForType(state.editing.type), state.editing.id, { expectedRevision: state.workbench.sourceRevision || state.library.sourceRevision })
    await loadData()
    activateView('library-view')
  } catch (error) {
    setMessage(dom['editor-message'], error.nextAction ?? error.message)
  }
})

dom['organize-form'].addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const terms = [...dom['organize-term-rows'].querySelectorAll('.term-row')].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector('.term-name').value,
      category: row.querySelector('.term-category').value,
      responsibility: row.querySelector('.term-responsibility').value
    }))
    const recipeName = dom['organize-recipe-name'].value
    const payload = buildOrganizePayload({
      expectedRevision: state.workbench.sourceRevision,
      terms,
      recipe: recipeName.trim() ? {
        id: `recipe_${crypto.randomUUID()}`,
        name: recipeName,
        derivedPrompt: dom['organize-recipe-prompt'].value
      } : null
    })
    await api.organizeCapture(state.organizingCapture.id, payload)
    setMessage(dom['editor-message'], '拆词与配方已保存，等待人工审核', true)
    await loadData()
    activateView('workbench-view')
  } catch (error) {
    setMessage(dom['editor-message'], error.nextAction ?? error.message)
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[QUEUE_KEY] || changes[LAST_CAPTURE_STATUS_KEY])) void renderQueue()
  if (area === 'local' && changes[USAGE_COUNTS_KEY]) {
    void usage.all().then((counts) => {
      state.usageCounts = counts
      renderLibrary()
    })
  }
})

fillSelect(dom['category-filter'], CATEGORY_LABELS, '全部分类')
fillSelect(dom['entity-category'], CATEGORY_LABELS)
fillSelect(dom['entity-responsibility'], RESPONSIBILITY_LABELS)
syncEditorFields()
void loadData().then(() => queue.drain()).then(loadData)
