import type { AgentConfig, RuntimeKind, ZooidConfig } from './types.js'

/** agent `runtime:` > workforce `runtime:` (which already defaulted to docker). [ZOD109] */
export function resolveAgentRuntime(
  agent: Pick<AgentConfig, 'runtime'>,
  cfg: Pick<ZooidConfig, 'runtime'>,
): RuntimeKind {
  return agent.runtime ?? cfg.runtime
}

export function isContainerRuntime(kind: RuntimeKind): kind is 'docker' | 'podman' {
  return kind === 'docker' || kind === 'podman'
}

/** The one container engine a workforce uses, or undefined when no agent runs in a container. */
export function containerEngineOf(
  cfg: Pick<ZooidConfig, 'runtime' | 'agents'>,
): 'docker' | 'podman' | undefined {
  for (const agent of Object.values(cfg.agents)) {
    const kind = resolveAgentRuntime(agent, cfg)
    if (isContainerRuntime(kind)) return kind
  }
  return undefined
}
