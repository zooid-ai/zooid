import { resolve } from 'node:path'
import {
  SessionRunner,
  type AgentAdapter,
  type AgentAdapterFactory,
  type BuddConfig,
  type DockerConfig,
  type ExtraMount,
  type Runtime,
  type SessionRunnerOptions,
} from '@zooid/budd-core'
import { LocalRuntime } from '@zooid/budd-runtime-local'
import { DockerRuntime, PodmanRuntime } from '@zooid/budd-runtime-docker'
import { claudeAdapter } from '@zooid/budd-adapter-claude'
import { codexAdapter } from '@zooid/budd-adapter-codex'

/**
 * Built-in adapter factories. Trivial adapters (claude, codex) ignore options
 * and return their singleton. Parameterized adapters (opencode, future) build
 * a per-instance adapter from the options block.
 */
export const BUILTIN_ADAPTERS: Record<string, AgentAdapterFactory> = {
  claude: () => claudeAdapter,
  codex: () => codexAdapter,
}

const DEFAULT_ADAPTER_NAME = 'claude'

export interface BuildRunnersOptions {
  /** Test-only PATH prefix, threaded through to each SessionRunner. */
  pathPrefix?: string
  overridePath?: string
  adapterEnv?: Record<string, string>
  /** Base directory used to resolve relative `docker.mounts.extra[].path`
   *  entries. Defaults to `process.cwd()`. */
  configDir?: string
  /** Override the registered adapter factories. Tests only. */
  adapters?: Record<string, AgentAdapterFactory>
}

/**
 * Build one SessionRunner per agent in the config. When `runtime: docker`,
 * each runner gets its own `DockerRuntime` with the per-agent image (falling
 * back to daemon-wide `docker.image`); that's what lets a single daemon host
 * mixed Claude/Codex personas that talk to each other over Zooid channels.
 * For `runtime: local`, a single shared `LocalRuntime` is reused.
 */
export function buildRunnersFromConfig(
  config: BuddConfig,
  opts: BuildRunnersOptions = {},
): Record<string, SessionRunner> {
  const adapters = opts.adapters ?? BUILTIN_ADAPTERS
  const configDir = opts.configDir ?? process.cwd()
  const runners: Record<string, SessionRunner> = {}

  // Local runtime is shared across agents — it has no per-agent state.
  // Docker runtime is per-agent (different image, different workdir mount).
  const sharedLocal = config.runtime === 'local' ? new LocalRuntime() : null

  for (const [name, agent] of Object.entries(config.agents)) {
    const ref = agent.adapter ?? { type: DEFAULT_ADAPTER_NAME }
    const factory = adapters[ref.type]
    if (!factory) {
      throw new Error(
        `agents.${name}.adapter "${ref.type}" not registered (known: ${Object.keys(adapters).join(', ')})`,
      )
    }
    let adapter: AgentAdapter
    try {
      adapter = factory(ref.options ?? {})
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`agents.${name}.adapter.options: ${msg}`)
    }

    // Resolve the agent's workdir to an absolute path. Docker bind-mount
    // sources must be absolute (a relative `.` is interpreted as a volume
    // name), and the SessionRunner's cwd is used for hook execution and
    // adapter file lookups — also needs to be absolute for deterministic
    // behaviour regardless of where budd was launched from.
    const absWorkdir = resolve(configDir, agent.workdir)

    let runtime: Runtime
    if (config.runtime === 'docker' || config.runtime === 'podman') {
      const image = agent.docker?.image ?? config.docker?.image
      if (!image) {
        throw new Error(
          `agents.${name}: image is required when runtime: ${config.runtime} (set agents.${name}.docker.image or top-level docker.image)`,
        )
      }
      const runtimeOpts = { image, workdir: absWorkdir, adapter, forwardEnv: agent.docker?.forward_env }
      runtime = config.runtime === 'podman'
        ? new PodmanRuntime(runtimeOpts)
        : new DockerRuntime(runtimeOpts)
    } else {
      runtime = sharedLocal!
    }

    const rawExtras = agent.docker?.mounts?.extra ?? []
    const extraMounts: ExtraMount[] = rawExtras.map((m) => ({
      ...m,
      path: resolve(configDir, m.path),
    }))
    const workspaceReadOnlyDisable = agent.docker?.mounts?.workspace_readonly_disable

    const runnerOpts: SessionRunnerOptions = {
      runtime,
      adapter,
      hooks: agent.hooks,
      cwd: absWorkdir,
    }
    if (opts.pathPrefix !== undefined) runnerOpts.pathPrefix = opts.pathPrefix
    if (opts.overridePath !== undefined) runnerOpts.overridePath = opts.overridePath
    if (opts.adapterEnv !== undefined) runnerOpts.adapterEnv = opts.adapterEnv
    if (extraMounts.length > 0) runnerOpts.extraMounts = extraMounts
    if (workspaceReadOnlyDisable)
      runnerOpts.workspaceReadOnlyDisable = workspaceReadOnlyDisable

    runners[name] = new SessionRunner(runnerOpts)
  }
  return runners
}

export { SessionRunner, LocalRuntime, DockerRuntime, PodmanRuntime, claudeAdapter, codexAdapter }
export type { DockerConfig }
