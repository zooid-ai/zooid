import type { MatrixTransportConfig } from '@zooid/core'

export interface HomeserverShape {
  host: string
  port: number
  serverName: string
}

// Matches @.*:server (flat) or @slug\..*:server (slug-scoped exclusive namespace)
const NAMESPACE_RE = /^@(?:\.\*|[a-z0-9-]+\\\.\.\*):([A-Za-z0-9.-]+)$/

export function deriveHomeserverShape(
  matrix: MatrixTransportConfig,
  agentUserIds: readonly string[],
): HomeserverShape {
  const url = new URL(matrix.homeserver)
  const host = url.hostname
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80

  const m = NAMESPACE_RE.exec(matrix.user_namespace)
  if (!m) {
    throw new Error(
      `user_namespace ${matrix.user_namespace!}: expected '@.*:<server_name>' or '@<slug>\\\..*:<server_name>'`,
    )
  }
  const serverName = m[1]!

  for (const userId of agentUserIds) {
    if (!userId.endsWith(`:${serverName}`)) {
      throw new Error(
        `server_name mismatch: agent ${userId} does not end with :${serverName}`,
      )
    }
  }

  return { host, port, serverName }
}
