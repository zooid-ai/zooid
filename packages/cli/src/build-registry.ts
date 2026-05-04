import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import {
  AcpAgentRegistry,
  type AcpRuntime,
  type BuddConfig,
} from '@zooid/core'
import { resolveForwardEnv } from './forward-env.js'

export interface BuildAcpRegistryOptions {
  /** Override the runtime selection (tests). */
  runtime?: AcpRuntime
}

/**
 * Build an `AcpAgentRegistry` from a parsed daemon config.
 *
 *   - `runtime: local`   → `LocalAcpRuntime`
 *   - `runtime: docker`  → `DockerAcpRuntime` (engine: docker)
 *   - `runtime: podman`  → `DockerAcpRuntime` (engine: podman)
 *
 * Per-agent `docker.forward_env` is resolved against `process.env` and
 * threaded into the registry's `forwardEnv` so each `AcpClient` gets the
 * right vars in its spawn spec.
 */
export function buildAcpRegistry(
  cfg: BuddConfig,
  opts: BuildAcpRegistryOptions = {},
): AcpAgentRegistry {
  for (const [name, agent] of Object.entries(cfg.agents)) {
    if (!agent.acp) {
      throw new Error(`agents.${name}: missing acp block (parser should have caught this)`)
    }
  }

  const runtime = opts.runtime ?? defaultRuntimeFor(cfg)
  const forwardEnv: Record<string, Record<string, string>> = {}
  for (const [name, agent] of Object.entries(cfg.agents)) {
    forwardEnv[name] = resolveForwardEnv(agent.docker?.forward_env)
  }
  return new AcpAgentRegistry({
    runtime,
    agents: cfg.agents,
    forwardEnv,
  })
}

function defaultRuntimeFor(cfg: BuddConfig): AcpRuntime {
  if (cfg.runtime === 'local') return new LocalAcpRuntime()
  if (cfg.runtime === 'docker') {
    return new DockerAcpRuntime({ defaultImage: cfg.docker?.image, engine: 'docker' })
  }
  if (cfg.runtime === 'podman') {
    return new DockerAcpRuntime({ defaultImage: cfg.docker?.image, engine: 'podman' })
  }
  throw new Error(`unsupported runtime: ${cfg.runtime}`)
}
