import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ZooidContextServerSpec } from './types.js'

const DEFAULT_BIN = join(dirname(fileURLToPath(import.meta.url)), 'bin.js')

export function buildContextServerSpec(opts: {
  spawnId: string
  sockPath: string
  binPath?: string
}): ZooidContextServerSpec {
  return {
    name: 'zooid-context',
    command: process.execPath,
    args: [opts.binPath ?? DEFAULT_BIN, '--spawn-id', opts.spawnId],
    env: [{ name: 'ZOOID_DAEMON_SOCK', value: opts.sockPath }],
  }
}
