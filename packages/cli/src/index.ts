import {
  SessionRunner,
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

/**
 * Construct a SessionRunner pre-wired with a runtime and the built-in
 * adapter set. Tests and the bin entry both go through this so the
 * wiring lives in one place.
 */
export function createDefaultSessionRunner(
  overrides: Partial<SessionRunnerOptions> & {
    runtimeChoice?: DefaultRuntimeChoice
  } = {},
): SessionRunner {
  const { runtimeChoice, ...rest } = overrides
  const runtime =
    rest.runtime ??
    buildRuntime(runtimeChoice ?? { runtime: 'local' })
  return new SessionRunner({
    runtime,
    adapters: rest.adapters ?? BUILTIN_ADAPTERS,
    hooks: rest.hooks ?? {},
    ...rest,
  })
}

export { SessionRunner, LocalRuntime, DockerRuntime, claudeAdapter, codexAdapter }
export type { HomeMount, DockerConfig }
