import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentAdapter, ExtraMount, Runtime, SpawnConfig } from '@zooid/budd-core'
import { resolveEnvPassthrough } from './env.js'

export interface DockerRuntimeOptions {
  /** Image to run, e.g. `ghcr.io/zooid-ai/budd-agent-claude-code:latest`. */
  image: string
  /** Host directory to mount at /workspace inside the container. */
  workdir: string
  /**
   * Adapter is needed at construction time so we can resolve its
   * envPassthrough at spawn time; runner and runtime share the adapter.
   */
  adapter: AgentAdapter
  /** User-declared forward_env from daemon.yaml. */
  forwardEnv?: string[]
  /** Override for tests. Defaults to process.env. */
  processEnv?: Record<string, string | undefined>
}

export interface BuildDockerArgsInput {
  image: string
  command: string
  args: string[]
  /** Host workdir; mounted RW at /workspace. */
  workdir: string
  /** Pre-resolved env entries to expose as `-e KEY=VALUE`, in order. */
  envPassthrough: Array<[string, string]>
  hostHome: string
  containerHome: string
  workspaceReadOnly?: string[]
  workspaceReadOnlyDisable?: string[]
  homeReadOnly?: string[]
  sessionStateDir?: string
  extraMounts?: ExtraMount[]
}

/**
 * Build the argv for `docker run ...`. Pure w.r.t. its inputs except for
 * one documented side effect: `mkdirSync` on the host `sessionStateDir`
 * before the bind mount, since Docker creates missing bind-mount sources
 * as root-owned dirs which the container user may not be able to write to.
 *
 * Ordering contract (later `-v` flags override earlier ones on nested paths):
 *   run --rm -i, workspace RW, workspace RO, home RO, sessionState RW,
 *   extras, env, --entrypoint <command>, image, args
 */
export function buildDockerArgs(input: BuildDockerArgsInput): string[] {
  const argv: string[] = ['run', '--rm', '-i']

  // 1. Workspace RW.
  argv.push('-v', `${input.workdir}:/workspace`)
  argv.push('-w', '/workspace')

  // 2. Workspace RO carveouts (skip disabled; skip non-existent).
  const disabled = new Set(input.workspaceReadOnlyDisable ?? [])
  for (const rel of input.workspaceReadOnly ?? []) {
    if (disabled.has(rel)) continue
    const src = join(input.workdir, rel)
    if (!existsSync(src)) continue
    argv.push('-v', `${src}:/workspace/${rel}:ro`)
  }

  // 3. Home RO files (skip non-existent).
  for (const rel of input.homeReadOnly ?? []) {
    const src = join(input.hostHome, rel)
    if (!existsSync(src)) continue
    argv.push('-v', `${src}:${input.containerHome}/${rel}:ro`)
  }

  // 4. Session-state dir — pre-create on host, mount RW.
  if (input.sessionStateDir) {
    const src = join(input.hostHome, input.sessionStateDir)
    mkdirSync(src, { recursive: true })
    argv.push('-v', `${src}:${input.containerHome}/${input.sessionStateDir}:rw`)
  }

  // 5. Extra user-declared mounts.
  for (const extra of input.extraMounts ?? []) {
    argv.push('-v', `${extra.path}:${extra.target}:${extra.mode}`)
  }

  // 6. Env passthrough — pre-resolved by caller, emitted in order.
  for (const [key, value] of input.envPassthrough) {
    argv.push('-e', `${key}=${value}`)
  }

  // Override any image ENTRYPOINT so the adapter's command runs directly.
  argv.push('--entrypoint', input.command)
  argv.push(input.image)
  argv.push(...input.args)
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
 *   - The configured workdir mounted at /workspace (RW)
 *   - Adapter-declared workspaceReadOnly carveouts layered on top (RO)
 *   - Adapter-declared homeReadOnly files under $HOME (RO)
 *   - Adapter-declared sessionStateDir under $HOME (RW)
 *   - Per-agent extraMounts from daemon.yaml
 *   - Adapter-declared envPassthrough + per-agent forward_env (deny-listed
 *     for BUDD_*) forwarded via `-e`
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

  /** Exposed for test introspection — buildRunnersFromConfig tests assert
   *  that per-agent images land on the per-agent runtime. */
  get image(): string {
    return this.opts.image
  }

  /**
   * Build the docker argv for a given SpawnConfig. Composes
   * `resolveEnvPassthrough(adapter, forwardEnv, processEnv)` with the
   * synthetic per-call vars in `config.env` (SESSION_ID, MESSAGE_TEXT,
   * WORKDIR — set by SessionRunner / hooks), then hands off to
   * buildDockerArgs.
   *
   * Per-call config.env vars are appended verbatim — they're owned by the
   * runner, not user-controlled, so the BUDD_* deny list doesn't apply
   * (and SessionRunner never sets BUDD_*).
   */
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
    // Synthetic vars override adapter vars on collision (last wins).
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
    return spawn('docker', this.buildArgv(config), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}
