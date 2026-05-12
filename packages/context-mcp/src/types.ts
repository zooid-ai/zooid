import type { TransportContextProvider, ThreadRef } from '@zooid/core'

/**
 * Daemon-internal record keyed by spawn-id. One per ACP session that has
 * a TransportContextProvider attached.
 */
export interface SpawnBinding {
  spawnId: string
  agentName: string
  threadRef: ThreadRef
  provider: TransportContextProvider
}

/** Shape we pass into ACP `session/new mcpServers[]`. */
export interface ZooidContextServerSpec {
  name: 'zooid-context'
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}
