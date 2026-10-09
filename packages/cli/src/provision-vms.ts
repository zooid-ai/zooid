import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAgentRuntime, type ZooidConfig } from '@zooid/core'
import {
  defaultVmExec,
  ensureVmMachine,
  stopVmMachine,
  vmMachineName,
  type VmExec,
} from '@zooid/runtime-vm'
import { resolveAgentImage } from './build-registry.js'

export interface ProvisionVmsOptions {
  cfg: ZooidConfig
  configDir: string
  /** `<dataRoot>/agents/`; each machine's settings hash lives at `<agentsDir>/<agent>/vm.json`. */
  agentsDir?: string
  exec?: VmExec
  log?: (line: string) => void
}

export interface VmsHandle {
  machines: string[]
  stop(): Promise<void>
}

/**
 * Bring every vm agent's machine up before the registry can spawn into it:
 * `AcpRuntime.spawn()` is synchronous, so it can only exec into a running
 * machine. Sequential on purpose — each boot is a VM. [ZOD109]
 */
export async function provisionVms(opts: ProvisionVmsOptions): Promise<VmsHandle> {
  const exec = opts.exec ?? defaultVmExec
  const log = opts.log ?? ((l: string) => console.log(l))
  const stateRoot = opts.agentsDir ?? join(tmpdir(), 'zooid-vm-state')
  const machines: string[] = []
  for (const [name, agent] of Object.entries(opts.cfg.agents)) {
    if (resolveAgentRuntime(agent, opts.cfg) !== 'vm') continue
    const image = resolveAgentImage(agent, opts.cfg).image
    if (!image) {
      throw new Error(`agents.${name}: runtime: vm requires an image (set agents.${name}.vm.image)`)
    }
    const machine = vmMachineName(name, opts.configDir)
    // Like the container workspace mount's `create: true`: smolvm needs the host dir to exist.
    const workdir = resolve(opts.configDir, agent.workdir)
    mkdirSync(workdir, { recursive: true })
    await ensureVmMachine({
      spec: {
        name: machine,
        image,
        workdir,
        cpus: agent.vm?.cpus,
        memoryMib: agent.vm?.memory_mib,
        diskGib: agent.vm?.disk_gib,
      },
      exec,
      stateFile: join(stateRoot, name, 'vm.json'),
      log,
    })
    machines.push(machine)
  }
  return {
    machines,
    async stop() {
      for (const m of machines) {
        await stopVmMachine(m, exec).catch((err) => log(`[vm] ${m}: stop failed: ${String(err)}`))
      }
    },
  }
}
