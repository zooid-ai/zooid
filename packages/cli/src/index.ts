import {
  SessionRunner,
  type Runtime,
  type SessionRunnerOptions,
} from '@zooid/agentd-core'
import { LocalRuntime } from '@zooid/agentd-runtime-local'
import { DockerRuntime } from '@zooid/agentd-runtime-docker'
import { claudeAdapter } from '@zooid/agentd-adapter-claude'

/**
 * Default set of agent adapters bundled with the CLI. The order is the
 * detection order — first match wins (claude > codex > opencode > ...).
 */
export const BUILTIN_ADAPTERS = [claudeAdapter]

export interface DefaultRuntimeChoice {
  runtime: 'local' | 'docker'
  /** Required when `runtime === 'docker'`. */
  image?: string
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
    if (!choice.image) {
      throw new Error('docker runtime requires an image')
    }
    return new DockerRuntime({
      image: choice.image,
      workdir: choice.workdir ?? process.cwd(),
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

export { SessionRunner, LocalRuntime, DockerRuntime, claudeAdapter }
