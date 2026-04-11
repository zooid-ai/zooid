import { spawn, type ChildProcess } from 'node:child_process'
import type { Runtime, SpawnConfig } from '@zooid/agentd-core'

/**
 * Default env allowlist for the Docker runtime. Only these host env vars
 * are forwarded into the container. Anything else stays on the host —
 * the whole point of running the agent inside Docker is sandboxing, so
 * we never `--env-file` the entire process.env in.
 *
 * Includes:
 *   - API keys for supported agent CLIs (Anthropic, Codex)
 *   - Per-session vars set by SessionRunner / hooks (SESSION_ID,
 *     MESSAGE_TEXT, WORKDIR)
 *   - STUB_* vars used by the e2e test stub image so tests can drive
 *     the stub `claude` binary's exit code and behaviour. These have
 *     no effect with the real production image.
 */
export const DEFAULT_DOCKER_ENV_ALLOWLIST: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CODEX_API_KEY',
  'SESSION_ID',
  'MESSAGE_TEXT',
  'WORKDIR',
  // Test-only stub controls
  'STUB_EXIT_CODE',
  'STUB_STDERR',
]

export interface DockerRuntimeOptions {
  /** Image to run, e.g. `zooid/agentd-claude:latest`. */
  image: string
  /** Host directory to mount at /workspace inside the container. */
  workdir: string
  /**
   * Env vars to forward from the host into the container. Defaults to
   * `DEFAULT_DOCKER_ENV_ALLOWLIST`. Pass an empty array to fall back to
   * the default; pass an explicit list to override.
   */
  envAllowlist?: readonly string[]
}

export interface BuildDockerArgsInput {
  image: string
  command: string
  args: string[]
  workdir: string
  envAllowlist: readonly string[]
  hostEnv: Record<string, string | undefined>
}

/**
 * Build the argv for `docker run ...`. Pure function — no side effects,
 * easy to unit test.
 */
export function buildDockerArgs(input: BuildDockerArgsInput): string[] {
  const argv: string[] = ['run', '--rm', '-i']

  // Mount the host workdir into /workspace.
  argv.push('-v', `${input.workdir}:/workspace`)
  argv.push('-w', '/workspace')

  // Env passthrough — allowlist only, skip undefined values.
  for (const key of input.envAllowlist) {
    const value = input.hostEnv[key]
    if (value === undefined) continue
    argv.push('-e', `${key}=${value}`)
  }

  argv.push(input.image)
  argv.push(input.command, ...input.args)
  return argv
}

/**
 * Map a `docker run` exit code to a structured result. 125/126/127 are
 * docker-side failures (daemon error, command not executable, command
 * not found) and get a human-readable `reason`. Anything else is treated
 * as the agent's own exit code and passed through unchanged.
 */
export function mapDockerExitCode(
  code: number,
): { exit_code: number; reason?: string } {
  switch (code) {
    case 125:
      return { exit_code: 125, reason: 'docker failed to start container' }
    case 126:
      return { exit_code: 126, reason: 'container command not executable' }
    case 127:
      return { exit_code: 127, reason: 'container command not found' }
    default:
      return { exit_code: code }
  }
}

/**
 * DockerRuntime spawns the agent CLI inside a container instead of on
 * the host. Implements the Runtime interface so it can be swapped in
 * for LocalRuntime in the SessionRunner. The container gets:
 *
 *   - The configured workdir mounted at /workspace
 *   - Only allowlisted host env vars forwarded via `-e`
 *   - `--rm` so the container disappears on exit
 *   - `-i` so stdin is wired up (chunkers in SessionRunner read stdout)
 */
export class DockerRuntime implements Runtime {
  /**
   * Tells SessionRunner to skip the host PATH check for the adapter
   * binary — the agent lives inside the image, not on the host.
   */
  readonly containerized = true

  constructor(private opts: DockerRuntimeOptions) {}

  spawn(config: SpawnConfig): ChildProcess {
    const allowlist =
      this.opts.envAllowlist && this.opts.envAllowlist.length > 0
        ? this.opts.envAllowlist
        : DEFAULT_DOCKER_ENV_ALLOWLIST
    const argv = buildDockerArgs({
      image: this.opts.image,
      command: config.command,
      args: config.args,
      workdir: this.opts.workdir,
      envAllowlist: allowlist,
      hostEnv: { ...process.env, ...(config.env ?? {}) },
    })
    return spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  }
}
