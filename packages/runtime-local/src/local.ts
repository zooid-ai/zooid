import { spawn, type ChildProcess } from 'node:child_process'
import type { Runtime, SpawnConfig } from '@zooid/budd-core'

/**
 * LocalRuntime spawns processes directly on the host. No isolation; the
 * agent has full access to the host filesystem and environment. Suitable
 * for development and trusted environments. The Docker runtime (epic 03)
 * provides a sandboxed alternative.
 */
export class LocalRuntime implements Runtime {
  spawn(config: SpawnConfig): ChildProcess {
    return spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}
