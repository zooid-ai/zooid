import { createRequire } from 'node:module'
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

export function buildContextServerSpec(opts: {
  spawnId: string
  sockPath: string
  binPath?: string
}): ZooidContextServerSpec {
  return {
    name: 'zooid-context',
    command: process.execPath,
    args: [opts.binPath ?? getDefaultBin(), '--spawn-id', opts.spawnId],
    env: [{ name: 'ZOOID_DAEMON_SOCK', value: opts.sockPath }],
  }
}
