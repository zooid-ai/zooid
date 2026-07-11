import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { AcpMount } from '@zooid/core'
import type { ZooidContextServerSpec } from './types.js'

/**
 * Resolve `dist/bin.js` via Node's runtime module resolver rather than
 * `import.meta.url`. tsup bundles this file into the CLI's own chunk, so
 * `import.meta.url` at runtime points to the CLI bundle — not this
 * package's dist. `createRequire` walks the runtime `node_modules` tree
 * instead and finds the package wherever it actually lives.
 */
function resolveDefaultBin(): string {
  const req = createRequire(import.meta.url)
  // Resolve via the dedicated `./bin` export → `./dist/bin.js`. Avoids the
  // exports-restriction surprise of importing `./package.json`.
  return req.resolve('@zooid/context-mcp/bin')
}

let cachedDefaultBin: string | null = null
function getDefaultBin(): string {
  if (!cachedDefaultBin) cachedDefaultBin = resolveDefaultBin()
  return cachedDefaultBin
}

/**
 * Fixed container-side paths for the containerized MCP spec. The daemon
 * bind-mounts the host `dist/` here (ro) and the daemon socket here (rw) so
 * opencode can spawn the zooid-context MCP subprocess inside its own container.
 */
export const CONTEXT_CONTAINER_BIN_DIR = '/zooid/context-mcp'
export const CONTEXT_CONTAINER_BIN = `${CONTEXT_CONTAINER_BIN_DIR}/bin.js`
export const CONTEXT_CONTAINER_SOCK = '/zooid/context.sock'

/**
 * The two bind-mounts a containerized, context-enabled agent needs. The bin dir
 * is read-only (self-contained bundle); the socket is read-write (the MCP
 * subprocess connect()s to it). Host sources default to the resolved package
 * dist and the passed daemon socket path.
 */
export function contextContainerMounts(opts: {
  sockPath: string
  binPath?: string
}): AcpMount[] {
  const binFile = opts.binPath ?? getDefaultBin()
  return [
    { path: dirname(binFile), target: CONTEXT_CONTAINER_BIN_DIR, mode: 'ro' },
    { path: opts.sockPath, target: CONTEXT_CONTAINER_SOCK, mode: 'rw' },
  ]
}

export function buildContextServerSpec(opts: {
  spawnId: string
  sockPath: string
  binPath?: string
  /**
   * When set, emit a spec that resolves INSIDE the agent container: bare `node`
   * (image PATH), the bind-mounted bin path, and the bind-mounted socket path.
   * The host `sockPath`/`binPath` still feed `contextContainerMounts`, but do
   * not appear in the emitted command. Absent → host-runtime spec (unchanged).
   */
  containerize?: boolean
}): ZooidContextServerSpec {
  if (opts.containerize) {
    return {
      name: 'zooid-context',
      command: 'node',
      args: [CONTEXT_CONTAINER_BIN, '--spawn-id', opts.spawnId],
      env: [{ name: 'ZOOID_DAEMON_SOCK', value: CONTEXT_CONTAINER_SOCK }],
    }
  }
  return {
    name: 'zooid-context',
    command: process.execPath,
    args: [opts.binPath ?? getDefaultBin(), '--spawn-id', opts.spawnId],
    env: [{ name: 'ZOOID_DAEMON_SOCK', value: opts.sockPath }],
  }
}
