import { spawn } from 'node:child_process'
import type { Paths } from '../bootstrap/paths.js'

export interface TuwunelOpts {
  name: string
  image?: string
  hostPort: number
  paths: Paths
  engine: 'docker' | 'podman'
}

const DEFAULT_IMAGE = 'ghcr.io/matrix-construct/tuwunel:latest'

export function buildRunArgs(opts: TuwunelOpts): string[] {
  const image = opts.image ?? DEFAULT_IMAGE
  return [
    'run',
    '--rm',
    '-d',
    '--name',
    opts.name,
    '-p',
    `${opts.hostPort}:8448`,
    '-v',
    `${opts.paths.dbDir}:/var/lib/tuwunel/db`,
    '-v',
    `${opts.paths.mediaDir}:/var/lib/tuwunel/media`,
    '-v',
    `${opts.paths.tuwunelTomlPath}:/etc/tuwunel/tuwunel.toml:ro`,
    '-v',
    `${opts.paths.registrationsDir}:/var/lib/tuwunel/registrations:ro`,
    '-e',
    'TUWUNEL_CONFIG=/etc/tuwunel/tuwunel.toml',
    image,
  ]
}

export class TuwunelService {
  constructor(private readonly opts: TuwunelOpts) {}

  async start(): Promise<void> {
    await this.exec(buildRunArgs(this.opts))
  }

  async stop(): Promise<void> {
    await this.exec(['stop', this.opts.name]).catch(() => {})
  }

  async waitHealthy(opts: { url: string; timeoutMs: number }): Promise<void> {
    const deadline = Date.now() + opts.timeoutMs
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${opts.url}/_matrix/client/versions`)
        if (r.ok) return
      } catch {
        // not yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(
      `Tuwunel did not become healthy at ${opts.url} in ${opts.timeoutMs}ms`,
    )
  }

  private exec(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.engine, args, { stdio: 'pipe' })
      let stderr = ''
      child.stderr.on('data', (b) => (stderr += String(b)))
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else
          reject(
            new Error(
              `${this.opts.engine} ${args.join(' ')} failed: ${stderr.trim()}`,
            ),
          )
      })
      child.on('error', reject)
    })
  }
}
