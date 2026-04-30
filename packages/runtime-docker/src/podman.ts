import { homedir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentAdapter, Runtime, SpawnConfig } from '@zooid/budd-core'
import { buildDockerArgs } from './docker.js'
import { resolveEnvPassthrough } from './env.js'

export type PodmanRuntimeOptions = {
  image: string
  workdir: string
  adapter: AgentAdapter
  forwardEnv?: string[]
  processEnv?: Record<string, string | undefined>
}

/**
 * PodmanRuntime spawns agent containers via `podman run` on a bare-metal Linux
 * host (EC2, Fly, Hetzner). No workaround flags needed — overlay storage,
 * cgroups, and network namespaces all work natively when Podman runs on the host.
 *
 * For local dev use DockerRuntime (`runtime: docker`) with Docker Desktop.
 */
export class PodmanRuntime implements Runtime {
  readonly containerized = true

  constructor(private opts: PodmanRuntimeOptions) {}

  get image(): string {
    return this.opts.image
  }

  buildArgv(config: SpawnConfig): string[] {
    const processEnv = this.opts.processEnv ?? process.env
    const adapterEnv = resolveEnvPassthrough(
      this.opts.adapter,
      this.opts.forwardEnv,
      processEnv,
    )
    const synthetic: Array<[string, string]> = Object.entries(config.env ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, v as string])
    const merged = new Map<string, string>()
    for (const [k, v] of adapterEnv) merged.set(k, v)
    for (const [k, v] of synthetic) merged.set(k, v)
    const envPassthrough = [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))

    const [run, ...rest] = buildDockerArgs({
      image: this.opts.image,
      command: config.command,
      args: config.args,
      workdir: this.opts.workdir,
      envPassthrough,
      hostHome: homedir(),
      containerHome: '/root',
      workspaceReadOnly: config.workspaceReadOnly,
      workspaceReadOnlyDisable: config.workspaceReadOnlyDisable,
      homeReadOnly: config.homeReadOnly,
      sessionStateDir: config.sessionStateDir,
      extraMounts: config.extraMounts,
    })

    return [run!, ...rest]
  }

  spawn(config: SpawnConfig): ChildProcess {
    return spawn('podman', this.buildArgv(config), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}
