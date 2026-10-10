import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Node truncates longer Unix socket paths silently, and the guest then sees EPIPE.
const MAX_SOCKET_PATH_BYTES = 103

/**
 * Where a vm agent's credential proxy listens. Stable across daemon restarts,
 * because smolvm bakes the host path into the machine at create time. [ZOD128]
 */
export function credentialSocketPath(configDir: string, agent: string): string {
  const h = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  const path = join(tmpdir(), `zooid-cred-${h}`, `${agent}.sock`)
  const n = Buffer.byteLength(path)
  if (n > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `credential proxy socket path for ${agent} is ${n} bytes; Unix sockets allow ${MAX_SOCKET_PATH_BYTES}. Shorten the agent name or set TMPDIR`,
    )
  }
  return path
}
