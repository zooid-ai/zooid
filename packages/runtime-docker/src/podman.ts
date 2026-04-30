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
 * PodmanRuntime spawns agent containers using `podman run` instead of
 * `docker run`. The CLI flags are identical to DockerRuntime — Podman's
 * CLI is Docker-compatible for the subset budd uses.
 *
 * Advantages over DockerRuntime (DinD) for EC2 / rootless deployments:
 *   - No inner daemon to start; each session forks a fresh `podman run`.
 *   - No rootlesskit user-namespace dance; Podman handles isolation itself.
 *   - No --privileged required on the host container.
 *
 * Use with `runtime: podman` in daemon.yaml and the budd-runtime-podman image.
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

    return buildDockerArgs({
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
  }

  spawn(config: SpawnConfig): ChildProcess {
    return spawn('podman', this.buildArgv(config), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}
