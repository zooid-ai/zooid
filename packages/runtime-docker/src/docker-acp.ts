import { spawn, type ChildProcess } from 'node:child_process'
import type { AcpRuntime, AcpSpawnSpec } from '@zooid/core'

export interface DockerAcpRuntimeOptions {
  /** Default image when the spec doesn't specify one. */
  defaultImage?: string
  /** docker (default) or podman. */
  engine?: 'docker' | 'podman'
}

/**
 * DockerAcpRuntime spawns the ACP shim inside a container.
 *
 * argv shape: `<engine> run --rm -i [-w cwd] [-v ...] [-e ...] --entrypoint cmd image [args...]`
 *
 * The image comes from the spec (preferred) or the runtime's defaultImage.
 * If neither is set, spawn() throws.
 */
export class DockerAcpRuntime implements AcpRuntime {
  private readonly engine: 'docker' | 'podman'
  constructor(private readonly opts: DockerAcpRuntimeOptions = {}) {
    this.engine = opts.engine ?? 'docker'
  }

  buildArgv(spec: AcpSpawnSpec): string[] {
    const image = spec.image ?? this.opts.defaultImage
    if (!image) {
      throw new Error(
        'DockerAcpRuntime: no image set (provide DockerAcpRuntimeOptions.defaultImage or AcpSpawnSpec.image)',
      )
    }
    const argv: string[] = ['run', '--rm', '-i']
    if (spec.cwd) {
      argv.push('-w', spec.cwd)
    }
    for (const m of spec.mounts ?? []) {
      argv.push('-v', `${m.path}:${m.target}:${m.mode}`)
    }
    const envEntries = Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
    for (const [k, v] of envEntries) {
      argv.push('-e', `${k}=${v}`)
    }
    argv.push('--entrypoint', spec.command)
    argv.push(image)
    argv.push(...spec.args)
    return argv
  }

  spawn(spec: AcpSpawnSpec): ChildProcess {
    return spawn(this.engine, this.buildArgv(spec), {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
}
