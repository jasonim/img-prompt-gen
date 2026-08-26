import { createApiClient } from './lib/api-client.js'
import { createQueueManager, LAST_CAPTURE_STATUS_KEY } from './lib/capture-queue.js'

const MENU_ID = 'save-to-image-prompt-library'
const api = createApiClient()
const queue = createQueueManager({ storage: chrome.storage.local, api })

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.remove(MENU_ID, () => {
    void chrome.runtime.lastError
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '保存到生图词库',
      contexts: ['selection']
    })
  })
  void queue.drain()
})

chrome.runtime.onStartup.addListener(() => {
  void queue.drain()
})

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) void chrome.sidePanel.open({ tabId: tab.id })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return
  if (tab?.id) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {})
  else if (tab?.windowId) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {})

  void (async () => {
    const queued = await queue.enqueueSelection(info.selectionText ?? '')
    if (queued.status === 'queued') await queue.drain()
  })()
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'retry-capture-queue') {
    void queue.drain().then((items) => sendResponse({ ok: true, items })).catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === 'get-last-capture-status') {
    void chrome.storage.local.get(LAST_CAPTURE_STATUS_KEY).then((value) => sendResponse(value[LAST_CAPTURE_STATUS_KEY] ?? null))
    return true
  }
  return false
})
