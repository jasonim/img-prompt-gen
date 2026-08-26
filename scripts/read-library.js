import { authenticatedLocalRead } from './local-client.js'

console.log(JSON.stringify(await authenticatedLocalRead('/api/library'), null, 2))
