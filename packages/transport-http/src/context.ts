import type { TransportContextProvider } from '@zooid/core'

/**
 * HTTP transport owns no durable conversation context in MVP. Returning null
 * tells the daemon to omit `zooid-context` from `session/new mcpServers` so
 * the shim never surfaces tools that would return nothing. See [ZOD046] for
 * the follow-on that would change this.
 */
export function getContextProvider(): TransportContextProvider | null {
  return null
}
