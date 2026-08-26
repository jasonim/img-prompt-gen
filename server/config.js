export const HOST = '127.0.0.1'
export const DEFAULT_PORT = 43119

export function loadConfig(environment = process.env) {
  const requestedHost = environment.IMG_PROMPT_HOST ?? HOST
  if (requestedHost !== HOST) throw new Error('IMG_PROMPT_HOST must be 127.0.0.1; LAN/public binding is forbidden')
  const port = Number.parseInt(environment.IMG_PROMPT_PORT ?? String(DEFAULT_PORT), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('IMG_PROMPT_PORT must be an integer from 1 to 65535')
  return { host: HOST, port }
}
