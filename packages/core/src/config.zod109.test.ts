import { describe, it, expect } from 'vitest'
import { loadZooidConfig, mergeCliFlags } from './config.js'
import { resolveAgentRuntime, containerEngineOf } from './runtime-resolve.js'

const HTTP = `
transports:
  http-local:
    type: http
    port: 8080
`

// One agent block; `extra` is indented under the agent.
function agent(name: string, extra = ''): string {
  return `  ${name}:
    workdir: ./${name}
    acp: { command: node, args: [agent.mjs] }
    http: { transport: http-local }
${extra}`
}

function yaml(top: string, ...agents: string[]): string {
  return `${top}\n${HTTP.trimStart()}agents:\n${agents.join('')}`
}

describe('ZOD109: runtime resolves per agent', () => {
  it('an agent without runtime inherits the workforce value', () => {
    const cfg = loadZooidConfig(yaml('runtime: local', agent('lead')))
    expect(cfg.agents.lead!.runtime).toBeUndefined()
    expect(resolveAgentRuntime(cfg.agents.lead!, cfg)).toBe('local')
  })

  it('the workforce default stays docker when runtime is omitted', () => {
    const cfg = loadZooidConfig(yaml('', agent('lead', '    container: { image: img:1 }\n')))
    expect(resolveAgentRuntime(cfg.agents.lead!, cfg)).toBe('docker')
  })

  it('an agent runtime overrides the workforce value', () => {
    const cfg = loadZooidConfig(
      yaml('runtime: local', agent('lead'), agent('smoke', '    runtime: vm\n')),
    )
    expect(cfg.agents.smoke!.runtime).toBe('vm')
    expect(resolveAgentRuntime(cfg.agents.smoke!, cfg)).toBe('vm')
    expect(resolveAgentRuntime(cfg.agents.lead!, cfg)).toBe('local')
  })

  it('rejects an unknown agent runtime with the field path', () => {
    expect(() =>
      loadZooidConfig(yaml('runtime: local', agent('x', '    runtime: firecracker\n'))),
    ).toThrow(/agents\.x\.runtime must be "local", "docker", "podman", or "vm"/)
  })

  it('accepts runtime: vm at the workforce level', () => {
    const cfg = loadZooidConfig(yaml('runtime: vm', agent('smoke')))
    expect(resolveAgentRuntime(cfg.agents.smoke!, cfg)).toBe('vm')
  })
})

describe('ZOD109: vm block', () => {
  it('parses image, cpus, memory and disk', () => {
    const cfg = loadZooidConfig(
      yaml(
        'runtime: local',
        agent(
          'smoke',
          `    runtime: vm
    vm:
      image: node:22-alpine
      cpus: 4
      memory: 8GiB
      disk: 32GiB
`,
        ),
      ),
    )
    expect(cfg.agents.smoke!.vm).toEqual({
      image: 'node:22-alpine',
      cpus: 4,
      memory_mib: 8192,
      disk_gib: 32,
    })
  })

  it('accepts MiB for memory', () => {
    const cfg = loadZooidConfig(
      yaml('runtime: vm', agent('smoke', '    vm: { memory: 1536MiB }\n')),
    )
    expect(cfg.agents.smoke!.vm?.memory_mib).toBe(1536)
  })

  it('rejects a malformed size', () => {
    expect(() =>
      loadZooidConfig(yaml('runtime: vm', agent('smoke', '    vm: { memory: 8GB }\n'))),
    ).toThrow(/agents\.smoke\.vm\.memory/)
  })

  it('rejects a disk that is not whole GiB', () => {
    expect(() =>
      loadZooidConfig(yaml('runtime: vm', agent('smoke', '    vm: { disk: 1536MiB }\n'))),
    ).toThrow(/agents\.smoke\.vm\.disk/)
  })

  it('rejects a non-positive-integer cpus', () => {
    expect(() =>
      loadZooidConfig(yaml('runtime: vm', agent('smoke', '    vm: { cpus: 0 }\n'))),
    ).toThrow(/agents\.smoke\.vm\.cpus/)
  })

  it('rejects unknown vm fields (vm.git lands in cycle 2)', () => {
    expect(() =>
      loadZooidConfig(
        yaml('runtime: vm', agent('smoke', '    vm: { git: https://example.com/r.git }\n')),
      ),
    ).toThrow(/agents\.smoke\.vm\.git/)
  })

  it('rejects vm on an agent whose resolved runtime is not vm', () => {
    expect(() =>
      loadZooidConfig(yaml('runtime: local', agent('lead', '    vm: { image: x }\n'))),
    ).toThrow(/agents\.lead\.vm is only valid when the agent's runtime is 'vm'/)
  })
})

describe('ZOD109: container validity moves to the resolved runtime', () => {
  it('rejects any container block on a vm agent, mounts included', () => {
    expect(() =>
      loadZooidConfig(
        yaml(
          'runtime: local',
          agent('smoke', '    runtime: vm\n    container: { disable_mounts: [workspace] }\n'),
        ),
      ),
    ).toThrow(/agents\.smoke\.container is not valid when runtime is 'vm'/)
  })

  it('accepts container.image on a docker agent inside a local workforce', () => {
    const cfg = loadZooidConfig(
      yaml('runtime: local', agent('coder', '    runtime: docker\n    container: { image: img:1 }\n')),
    )
    expect(cfg.agents.coder!.container?.image).toBe('img:1')
  })

  it('keeps the local rule on a local agent inside a docker workforce', () => {
    // mounts / disable_mounts tolerated (ignored at compose time) …
    expect(() =>
      loadZooidConfig(
        yaml(
          'runtime: docker',
          agent('lead', '    runtime: local\n    container: { disable_mounts: [workspace] }\n'),
        ),
      ),
    ).not.toThrow()
    // … image still rejected, with ZOD043's message.
    expect(() =>
      loadZooidConfig(
        yaml('runtime: docker', agent('lead', '    runtime: local\n    container: { image: x }\n')),
      ),
    ).toThrow(/lead\.container\.image is only valid when runtime is 'docker' or 'podman'/)
  })

  it('accepts a workforce container block when any agent resolves to a container runtime', () => {
    const cfg = loadZooidConfig(
      yaml(
        'runtime: local\ncontainer: { image: base:1 }',
        agent('lead'),
        agent('coder', '    runtime: docker\n'),
      ),
    )
    expect(cfg.container?.image).toBe('base:1')
  })

  it('rejects a workforce container block when no agent resolves to a container runtime', () => {
    expect(() =>
      loadZooidConfig(
        yaml(
          'runtime: local\ncontainer: { image: base:1 }',
          agent('lead'),
          agent('smoke', '    runtime: vm\n'),
        ),
      ),
    ).toThrow(/container is only valid when runtime is 'docker' or 'podman'/)
  })

  it('rejects a workforce that mixes docker and podman agents', () => {
    expect(() =>
      loadZooidConfig(
        yaml(
          'runtime: docker\ncontainer: { image: base:1 }',
          agent('a'),
          agent('b', '    runtime: podman\n'),
        ),
      ),
    ).toThrow(/one container engine/)
  })

  it('containerEngineOf names the single engine, or undefined', () => {
    const mixed = loadZooidConfig(
      yaml('runtime: local', agent('lead'), agent('coder', '    runtime: podman\n    container: { image: i }\n')),
    )
    expect(containerEngineOf(mixed)).toBe('podman')
    const none = loadZooidConfig(yaml('runtime: local', agent('lead'), agent('s', '    runtime: vm\n')))
    expect(containerEngineOf(none)).toBeUndefined()
  })
})

describe('ZOD109: --runtime sets the workforce default only', () => {
  const base = () =>
    loadZooidConfig(
      yaml(
        'runtime: docker\ncontainer: { image: base:1 }',
        agent('lead'),
        agent('smoke', '    runtime: vm\n'),
        agent('coder', '    runtime: docker\n'),
      ),
    )

  it('moves inheriting agents and leaves overrides alone', () => {
    const merged = mergeCliFlags(base(), { runtime: 'local' })
    expect(resolveAgentRuntime(merged.agents.lead!, merged)).toBe('local')
    expect(resolveAgentRuntime(merged.agents.smoke!, merged)).toBe('vm')
    expect(resolveAgentRuntime(merged.agents.coder!, merged)).toBe('docker')
  })

  it('keeps the workforce container block while an agent still resolves to a container runtime', () => {
    const merged = mergeCliFlags(base(), { runtime: 'local' })
    expect(merged.container?.image).toBe('base:1')
  })

  it('accepts --runtime vm', () => {
    const merged = mergeCliFlags(base(), { runtime: 'vm' })
    expect(resolveAgentRuntime(merged.agents.lead!, merged)).toBe('vm')
  })
})
