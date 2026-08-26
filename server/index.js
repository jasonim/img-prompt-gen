import { createServer } from 'node:http'
import path from 'node:path'

import { createApplication } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const dataDir = path.resolve(import.meta.dirname, '../data')
const application = await createApplication({
  dataDir,
  logger(event) {
    console.error(JSON.stringify(event))
  }
})
const server = createServer(application.handler)

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(config.port, config.host, resolve)
})

const pairingSecret = await application.pairing.ensurePairingSecret()
console.log(`枝句本地服务已启动：http://${config.host}:${config.port}`)
if (pairingSecret) {
  console.log('一次性配对密钥（10 分钟有效）：')
  console.log(pairingSecret)
} else {
  console.log('已有扩展完成配对；如需重置，请运行 npm run pairing:reset。')
}

async function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭本地服务。`)
  await new Promise((resolve) => server.close(resolve))
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
