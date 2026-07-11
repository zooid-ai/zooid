export { SpawnRegistry } from './spawn-registry.js'
export { startDaemonSocketServer, callDaemon } from './daemon-socket.js'
export type { DaemonSocketHandle } from './daemon-socket.js'
export { buildContextMcpServer } from './mcp-server.js'
export {
  buildContextServerSpec,
  contextContainerMounts,
  CONTEXT_CONTAINER_BIN,
  CONTEXT_CONTAINER_BIN_DIR,
  CONTEXT_CONTAINER_SOCK,
} from './factory.js'
export type { SpawnBinding, ZooidContextServerSpec } from './types.js'
