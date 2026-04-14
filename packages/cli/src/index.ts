import { resolve } from 'node:path'
import {
  SessionRunner,
  type AgentAdapter,
  type BuddConfig,
  type DockerConfig,
  type ExtraMount,
  type Runtime,
  type SessionRunnerOptions,
} from '@zooid/budd-core'
import { LocalRuntime } from '@zooid/budd-runtime-local'
import { DockerRuntime } from '@zooid/budd-runtime-docker'
import { claudeAdapter } from '@zooid/budd-adapter-claude'
import { codexAdapter } from '@zooid/budd-adapter-codex'

/**
 * Built-in agent adapters, keyed by their `name`. The first key is the
 * default adapter — when an agent in daemon.yaml omits `adapter:`, it
 * picks this one. Mixed-adapter daemons specify `adapter:` per agent.
 */
export const BUILTIN_ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
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
  /** Override the set of registered adapters. Tests only. */
  adapters?: Record<string, AgentAdapter>
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
    const adapterName = agent.adapter ?? DEFAULT_ADAPTER_NAME
    const adapter = adapters[adapterName]
    if (!adapter) {
      throw new Error(
        `agents.${name}.adapter "${adapterName}" not registered (known: ${Object.keys(adapters).join(', ')})`,
      )
    }

    let runtime: Runtime
    if (config.runtime === 'docker') {
      const image = agent.docker?.image ?? config.docker?.image
      if (!image) {
        throw new Error(
          `agents.${name}: image is required when runtime: docker (set agents.${name}.docker.image or top-level docker.image)`,
        )
      }
      runtime = new DockerRuntime({ image, workdir: agent.workdir })
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
      cwd: agent.workdir,
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

export { SessionRunner, LocalRuntime, DockerRuntime, claudeAdapter, codexAdapter }
export type { DockerConfig }
