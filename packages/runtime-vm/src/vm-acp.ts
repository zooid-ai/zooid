import { spawn, type ChildProcess } from 'node:child_process'
import type { AcpRuntime, AcpSpawnSpec } from '@zooid/core'
import { SMOLVM_BIN, VM_GUEST_WORKDIR } from './vm-machine.js'

export interface VmAcpRuntimeOptions {
  /** The agent's machine. It must already be running: see ensureVmMachine. */
  machine: string
  bin?: string
}

// cwd and env go through sh + env(1) so the argv stays one shape whatever
// smolvm's exec flags do. Values travel as argv, never interpolated into the script.
const EXEC_SCRIPT = 'cd "$1" && shift && exec env "$@"'

/**
 * VmAcpRuntime execs the ACP shim inside the agent's microVM and hands back
 * the exec stream as the child's stdio, the way DockerAcpRuntime hands back
 * `docker run -i`. Killing the host `smolvm` process kills the guest process.
 *
 * argv shape: `smolvm machine exec -i --name <machine> -- sh -c <script> zooid-acp <cwd> [K=V…] cmd [args…]`
 *
 * `image` and `mounts` on the spec are ignored: both are fixed when the
 * machine is created.
 */
export class VmAcpRuntime implements AcpRuntime {
  readonly machine: string
  constructor(private readonly opts: VmAcpRuntimeOptions) {
    this.machine = opts.machine
  }

  buildArgv(spec: AcpSpawnSpec): string[] {
    const env = Object.entries(spec.env ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
    return [
      'machine', 'exec', '-i', '--name', this.machine, '--',
      'sh', '-c', EXEC_SCRIPT, 'zooid-acp', spec.cwd ?? VM_GUEST_WORKDIR,
      ...env, spec.command, ...spec.args,
    ]
  }

  spawn(spec: AcpSpawnSpec): ChildProcess {
    return spawn(this.opts.bin ?? SMOLVM_BIN, this.buildArgv(spec), {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
}
