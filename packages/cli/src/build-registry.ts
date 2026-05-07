import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import {
  AcpAgentRegistry,
  type AcpRuntime,
  type ApprovalCorrelator,
  type TapEvent,
  type WorkforceConfig,
} from '@zooid/core'
import { resolveForwardEnv } from './forward-env.js'

export interface BuildAcpRegistryOptions {
  /** Override the runtime selection (tests). */
  runtime?: AcpRuntime
  /** When set, the registry's approval handler routes through this correlator. */
  approvals?: ApprovalCorrelator
  /** Observability tap forwarded to each AcpClient. */
  onTap?: (agentName: string, event: TapEvent) => void
  /**
   * Per-agent state root (`<dataRoot>/agents/`). When set, each AcpClient
   * persists its `(threadId → sessionId)` map under
   * `<agentsDir>/<agentName>/sessions.json` so threads survive daemon restarts.
   */
  agentsDir?: string
}

/**
 * Build an `AcpAgentRegistry` from a parsed workforce config.
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
  cfg: WorkforceConfig,
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
    approvals: opts.approvals,
    onTap: opts.onTap,
    agentsDir: opts.agentsDir,
  })
}

function defaultRuntimeFor(cfg: WorkforceConfig): AcpRuntime {
  if (cfg.runtime === 'local') return new LocalAcpRuntime()
  if (cfg.runtime === 'docker') {
    return new DockerAcpRuntime({ defaultImage: cfg.docker?.image, engine: 'docker' })
  }
  if (cfg.runtime === 'podman') {
    return new DockerAcpRuntime({ defaultImage: cfg.docker?.image, engine: 'podman' })
  }
  throw new Error(`unsupported runtime: ${cfg.runtime}`)
}
