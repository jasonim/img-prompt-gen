import { authenticatedLocalRead } from './local-client.js'

console.log(JSON.stringify(await authenticatedLocalRead('/health'), null, 2))
