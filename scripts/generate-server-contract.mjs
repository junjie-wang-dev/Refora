import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const target = new URL('../src/shared/server-contract.ts', import.meta.url)
const { stdout } = await runFile('python3', ['backend/export_contract.py'], {
  env: {
    ...process.env,
    PYTHONPATH: 'backend',
    PYTHONNOUSERSITE: '1'
  }
})
const contract = JSON.parse(stdout)
const render = (value) => JSON.stringify(value, null, 2)
const output = [
  `export const SERVER_PROTOCOL_VERSION = ${contract.protocolVersion} as const`,
  `export const SERVER_PROTOCOL_DIGEST = ${JSON.stringify(contract.protocolDigest)} as const`,
  `export const SERVER_HTTP_ROUTES = ${render(contract.httpRoutes)} as const`,
  `export const SERVER_WEBSOCKET_PATH = ${JSON.stringify(contract.websocketPath)} as const`,
  `export const SERVER_EVENT_NAMES = ${render(contract.serverEvents)} as const`,
  `export const CONNECTOR_EVENT_NAMES = ${render(contract.connectorEvents)} as const`,
  `export const CLIENT_WEBSOCKET_EVENT_NAMES = ${render(contract.clientWebsocketEvents)} as const`,
  `export const SERVER_WEBSOCKET_EVENT_NAMES = ${render(contract.serverWebsocketEvents)} as const`,
  'export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number]',
  'export type ConnectorEventName = (typeof CONNECTOR_EVENT_NAMES)[number]',
  'export type ServerWebsocketEventName = (typeof SERVER_WEBSOCKET_EVENT_NAMES)[number]',
  ''
].join('\n\n')

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '')
  if (current !== output) {
    throw new Error('src/shared/server-contract.ts is stale; run npm run generate:server-contract')
  }
} else {
  await writeFile(target, output)
}
