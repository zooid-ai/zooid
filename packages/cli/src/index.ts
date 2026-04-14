import {
  SessionRunner,
  type BuddConfig,
  type Runtime,
  type SessionRunnerOptions,
  type DockerConfig,
  type HomeMount,
} from '@zooid/budd-core'
import { LocalRuntime } from '@zooid/budd-runtime-local'
import { DockerRuntime } from '@zooid/budd-runtime-docker'
import { claudeAdapter } from '@zooid/budd-adapter-claude'
import { codexAdapter } from '@zooid/budd-adapter-codex'

/**
 * Default set of agent adapters bundled with the CLI. The order is the
 * detection order — first match wins (claude > codex > opencode > ...).
 */
export const BUILTIN_ADAPTERS = [claudeAdapter, codexAdapter]

export interface DefaultRuntimeChoice {
  runtime: 'local' | 'docker'
  /** Docker-specific config. Required when `runtime === 'docker'`. */
  docker?: DockerConfig
  /** Host directory mounted at /workspace inside the container. */
  workdir?: string
}

/**
 * Build a Runtime instance for the given config. Centralised here so the
 * bin entry, integration tests, and any future embedder all share one
 * wiring path.
 */
export function buildRuntime(choice: DefaultRuntimeChoice): Runtime {
  if (choice.runtime === 'docker') {
    const docker = choice.docker
    if (!docker) {
      throw new Error('docker runtime requires a docker config block')
    }
    return new DockerRuntime({
      image: docker.image,
      workdir: choice.workdir ?? process.cwd(),
      homeMountsOverride: docker.home_mounts,
    })
  }
  return new LocalRuntime()
}

export interface BuildRunnersOptions {
  /** Test-only PATH prefix, threaded through to each SessionRunner. */
  pathPrefix?: string
  overridePath?: string
  adapterEnv?: Record<string, string>
}

/**
 * Build one SessionRunner per agent in the config. Runtime + image + adapter
 * set are shared daemon-wide; per-agent workdir and hooks are wired into
 * each runner. Used by the bin entry and by integration tests.
 */
export function buildRunnersFromConfig(
  config: BuddConfig,
  opts: BuildRunnersOptions = {},
): Record<string, SessionRunner> {
  const runners: Record<string, SessionRunner> = {}
  for (const [name, agent] of Object.entries(config.agents)) {
    const runtime = buildRuntime({
      runtime: config.runtime,
      docker: config.docker,
      workdir: agent.workdir,
    })
    const runnerOpts: SessionRunnerOptions = {
      runtime,
      adapters: BUILTIN_ADAPTERS,
      hooks: agent.hooks,
      cwd: agent.workdir,
    }
    if (opts.pathPrefix !== undefined) runnerOpts.pathPrefix = opts.pathPrefix
    if (opts.overridePath !== undefined) runnerOpts.overridePath = opts.overridePath
    if (opts.adapterEnv !== undefined) runnerOpts.adapterEnv = opts.adapterEnv
    runners[name] = new SessionRunner(runnerOpts)
  }
  return runners
}

export { SessionRunner, LocalRuntime, DockerRuntime, claudeAdapter, codexAdapter }
export type { HomeMount, DockerConfig }
