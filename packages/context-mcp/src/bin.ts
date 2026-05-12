#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildContextMcpServer } from './mcp-server.js'
import { callDaemon } from './daemon-socket.js'
import type { TransportContextProvider } from '@zooid/core'

const spawnIdIdx = process.argv.indexOf('--spawn-id')
const spawnId = spawnIdIdx >= 0 ? process.argv[spawnIdIdx + 1] : undefined
const sockPath = process.env.ZOOID_DAEMON_SOCK
if (!spawnId || !sockPath) {
  process.stderr.write('zooid-context-mcp: --spawn-id and ZOOID_DAEMON_SOCK are required\n')
  process.exit(2)
}

const remoteProvider: TransportContextProvider = {
  getRoomHistory: (_channelId, opts) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getRoomHistory',
      params: (opts ?? {}) as Record<string, unknown>,
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getRoomHistory']>>>,
  getRecentThreads: (_channelId, opts) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getRecentThreads',
      params: (opts ?? {}) as Record<string, unknown>,
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getRecentThreads']>>>,
  getThreadHistory: (_channelId, threadId, opts) =>
    callDaemon(sockPath, {
      spawnId,
      method: 'getThreadHistory',
      params: { ...(opts ?? {}), threadId } as Record<string, unknown>,
    }) as Promise<Awaited<ReturnType<TransportContextProvider['getThreadHistory']>>>,
  getChannelMembers: () =>
    callDaemon(sockPath, { spawnId, method: 'getChannelMembers', params: {} }) as Promise<
      Awaited<ReturnType<TransportContextProvider['getChannelMembers']>>
    >,
  getChannelInfo: () =>
    callDaemon(sockPath, { spawnId, method: 'getChannelInfo', params: {} }) as Promise<
      Awaited<ReturnType<TransportContextProvider['getChannelInfo']>>
    >,
}

const server = buildContextMcpServer({ resolve: async () => remoteProvider })
await server.connect(new StdioServerTransport())
