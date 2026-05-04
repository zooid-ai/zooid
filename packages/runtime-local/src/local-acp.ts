import { spawn, type ChildProcess } from 'node:child_process'
import type { AcpRuntime, AcpSpawnSpec } from '@zooid/core'

/**
 * LocalAcpRuntime spawns the ACP shim process directly on the host. No
 * container, no isolation. `image` and `mounts` on the spec are ignored.
 */
export class LocalAcpRuntime implements AcpRuntime {
  spawn(spec: AcpSpawnSpec): ChildProcess {
    return spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(spec.env ?? {}) },
      cwd: spec.cwd,
    })
  }
}
