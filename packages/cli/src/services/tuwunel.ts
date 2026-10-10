import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Paths } from '../bootstrap/paths.js'

const execFileAsync = promisify(execFile)

export interface TuwunelOpts {
  name: string
  image?: string
  hostPort: number
  paths: Paths
  engine: 'docker' | 'podman'
}

const DEFAULT_IMAGE = 'ghcr.io/matrix-construct/tuwunel:v1.9.3'

export function buildRunArgs(opts: TuwunelOpts): string[] {
  const image = opts.image ?? DEFAULT_IMAGE
  return [
    'run',
    '--rm',
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

// Enough of the engine's stderr to carry its error message without holding a
// foregrounded container's whole log in memory.
const STDERR_TAIL_BYTES = 4096

/** The foregrounded `<engine> run` process ended (or never spawned). */
class EngineExitError extends Error {}

export class TuwunelService {
  private child: ChildProcess | null = null
  // Resolves (never rejects) with the error describing why the foregrounded
  // `<engine> run` process ended. `--rm` + foreground means it should live as
  // long as Tuwunel does, so any exit before we are done is a failed start.
  private childExit: Promise<EngineExitError> | null = null
  constructor(private readonly opts: TuwunelOpts) {}

  /**
   * Make the container name free before `start()`. A stale non-running
   * container (e.g. `Created`, left by an interrupted run) is removed. A
   * running one may belong to another live dev session, so it is never touched:
   * fail with a clear message instead.
   */
  async prepare(): Promise<void> {
    const { engine, name } = this.opts
    const state = await this.inspectState()
    if (!state) return
    if (state.status === 'running' || state.status === 'restarting') {
      throw new Error(
        `A container named "${name}" is already running (another \`zooid dev\` session?). ` +
          `Stop it first (\`${engine} stop ${name}\`) or use a different workspace.`,
      )
    }
    await execEngine(engine, ['rm', name])
  }

  start(): ChildProcess {
    const child = spawn(this.opts.engine, buildRunArgs(this.opts), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let stderr = ''
    child.stderr?.on('data', (b) => {
      stderr = (stderr + String(b)).slice(-STDERR_TAIL_BYTES)
    })
    const engine = this.opts.engine
    this.childExit = new Promise<EngineExitError>((resolve) => {
      child.once('error', (err) => {
        resolve(new EngineExitError(`Failed to spawn \`${engine} run\`: ${err.message}`))
      })
      child.once('exit', (code, signal) => {
        const how = code !== null ? `exit=${code}` : `signal=${signal}`
        const detail = stderr.trim()
        resolve(
          new EngineExitError(
            `\`${engine} run\` exited before Tuwunel was healthy (${how})` +
              (detail ? `:\n${detail}` : ''),
          ),
        )
      })
    })
    return child
  }

  async stop(): Promise<void> {
    // Foregrounded container: kill the engine process; --rm cleans up after.
    if (this.child && this.child.exitCode === null) {
      const child = this.child
      child.kill('SIGTERM')
      // Bounded: `docker stop` below is the real cleanup and is a no-op if the
      // container is already gone, so a wedged engine process must not be able
      // to hang shutdown forever. Measured ~450ms for a healthy Tuwunel.
      await new Promise<void>((resolve) => {
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          finish()
        }, 5000)
        child.once('exit', finish)
      })
    }
    this.child = null
    // Defensive: the parent may have died while the container was running, in
    // which case --rm doesn't fire. `<engine> stop` is a no-op if it's already
    // gone (errors are swallowed).
    await execEngine(this.opts.engine, ['stop', this.opts.name]).catch(() => {})
  }

  async waitHealthy(opts: { url: string; timeoutMs: number }): Promise<void> {
    // Two-phase wait: first the container has to transition from `created` to
    // `running` (Docker Desktop on macOS can take 30–90s on first-run bind-mount
    // setup), then Tuwunel has to open its DB and start serving HTTP. Polling
    // only HTTP loses both signals: a long create looks identical to a long
    // boot, and a crashed container looks identical to a slow one.
    if (!this.childExit) {
      throw new Error('TuwunelService.waitHealthy() called before start()')
    }
    const childExit = this.childExit
    // Race anything we wait on against the engine process ending, so a failed
    // `run` (name conflict, bad mount, missing image) surfaces at once instead
    // of looking like a slow start until the deadline.
    const orExit = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        childExit.then((err) => {
          throw err
        }),
      ])
    const sleep = (): Promise<void> =>
      orExit(new Promise<void>((resolve) => setTimeout(resolve, 500)))
    const deadline = Date.now() + opts.timeoutMs

    // Phase 1: wait for the container to be running. Surface the actual
    // docker error if it transitions to `exited` instead — that's the
    // case where today we just hang for 60s and say "did not become healthy"
    // with no clue what really broke.
    while (Date.now() < deadline) {
      const state = await orExit(this.inspectState().catch(() => null))
      if (state?.status === 'running') break
      if (state?.status === 'exited') {
        throw new Error(
          `Tuwunel container exited before serving HTTP ` +
            `(exit=${state.exitCode}${state.error ? `, error=${state.error}` : ''}). ` +
            `Check the engine logs (\`${this.opts.engine} logs ${this.opts.name}\`).`,
        )
      }
      await sleep()
    }

    // Phase 2: container is running (or we ran out of time). Poll the HTTP
    // endpoint until either it answers or the deadline passes.
    while (Date.now() < deadline) {
      try {
        const r = await orExit(fetch(`${opts.url}/_matrix/client/versions`))
        if (r.ok) return
      } catch (err) {
        if (err instanceof EngineExitError) throw err
        // not yet
      }
      await sleep()
    }

    // Last-ditch diagnostic before throwing the generic timeout — surface the
    // current container state so the user knows whether to blame slow start,
    // slow boot, or a misconfiguration.
    const finalState = await this.inspectState().catch(() => null)
    const detail = finalState
      ? ` (container status=${finalState.status}${
          finalState.exitCode !== undefined ? `, exit=${finalState.exitCode}` : ''
        })`
      : ''
    throw new Error(
      `Tuwunel did not become healthy at ${opts.url} in ${opts.timeoutMs}ms${detail}`,
    )
  }

  /**
   * Read the engine's view of the container. Returns null if the container
   * isn't known to the engine (e.g. before spawn completed or after `--rm`).
   */
  private async inspectState(): Promise<{
    status: string
    exitCode?: number
    error?: string
  } | null> {
    try {
      const { stdout } = await execFileAsync(this.opts.engine, [
        'inspect',
        this.opts.name,
        '--format',
        '{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}',
      ])
      const [status, exitCodeRaw, error] = stdout.trim().split('|')
      const exitCode = exitCodeRaw && exitCodeRaw !== '<no value>' ? Number(exitCodeRaw) : undefined
      return {
        status: status ?? 'unknown',
        ...(Number.isFinite(exitCode) ? { exitCode: exitCode as number } : {}),
        ...(error ? { error } : {}),
      }
    } catch {
      return null
    }
  }
}

function execEngine(engine: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, { stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', (b) => (stderr += String(b)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${engine} ${args.join(' ')} failed: ${stderr.trim()}`))
    })
    child.on('error', reject)
  })
}
