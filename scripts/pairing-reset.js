import path from 'node:path'

import { PairingManager } from '../server/pairing.js'

const manager = new PairingManager({ secretsDir: path.resolve(import.meta.dirname, '../data/.secrets') })
const secret = await manager.reset()
console.log('旧配对已撤销。请保持本地服务运行，并在 10 分钟内输入新的配对密钥：')
console.log(secret)
