import { LocalAcpRuntime } from '@zooid/runtime-local'
import { DockerAcpRuntime } from '@zooid/runtime-docker'
import {
  AcpAgentRegistry,
  type AcpRuntime,
  type ApprovalCorrelator,
  type TapEvent,
  type WorkforceConfig,
} from '@zooid/core'

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
 * Per-agent `container.env` is passed through to each `AcpClient`'s spawn
 * spec verbatim (interpolation happens at parse time in `@zooid/core`).
 * The image is resolved as `agent.container?.image ?? cfg.container?.image`.
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
  const env: Record<string, Record<string, string>> = {}
  const image: Record<string, string | undefined> = {}
  for (const [name, agent] of Object.entries(cfg.agents)) {
    env[name] = agent.container?.env ?? {}
    image[name] = agent.container?.image ?? cfg.container?.image
  }
  return new AcpAgentRegistry({
    runtime,
    agents: cfg.agents,
    env,
    image,
    approvals: opts.approvals,
    onTap: opts.onTap,
    agentsDir: opts.agentsDir,
  })
}

function defaultRuntimeFor(cfg: WorkforceConfig): AcpRuntime {
  if (cfg.runtime === 'local') return new LocalAcpRuntime()
  if (cfg.runtime === 'docker') {
    return new DockerAcpRuntime({ defaultImage: cfg.container?.image, engine: 'docker' })
  }
  if (cfg.runtime === 'podman') {
    return new DockerAcpRuntime({ defaultImage: cfg.container?.image, engine: 'podman' })
  }
  throw new Error(`unsupported runtime: ${cfg.runtime}`)
}
