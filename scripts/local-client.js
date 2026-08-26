import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_PORT } from '../server/config.js'

export async function authenticatedLocalRead(pathname, { dataDir = path.resolve(import.meta.dirname, '../data') } = {}) {
  let credentials
  try {
    credentials = JSON.parse(await readFile(path.join(dataDir, '.secrets/client-token.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('尚未配对扩展；请先启动服务并在 Chrome 侧栏完成配对')
    throw error
  }
  const port = Number.parseInt(process.env.IMG_PROMPT_PORT ?? String(DEFAULT_PORT), 10)
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: {
      Origin: credentials.origin,
      Authorization: `Bearer ${credentials.token}`,
      'X-Img-Prompt-Protocol': credentials.protocol
    }
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`)
  return payload.data
}
