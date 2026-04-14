import { describe, it, expect } from 'vitest'
import { loadConfig, mergeCliFlags } from './config.js'
import type { BuddConfig } from './types.js'

const QA_AGENT_YAML = `
agents:
  qa:
    workdir: ./qa
`

describe('loadConfig', () => {
  it('parses a minimal daemon.yaml', () => {
    const config = loadConfig(`
transport: http
port: 8080
runtime: local
agents:
  qa:
    workdir: ./qa
`)
    expect(config).toEqual({
      transport: 'http',
      port: 8080,
      runtime: 'local',
      agents: {
        qa: { name: 'qa', workdir: './qa', hooks: {} },
      },
      hooks: {},
    })
  })

  it('parses daemon-wide hooks', () => {
    const config = loadConfig(`
transport: http
runtime: local
hooks:
  pre_turn: "git pull"
  post_turn: "git push"
agents:
  qa:
    workdir: ./qa
`)
    expect(config.hooks.pre_turn).toBe('git pull')
    expect(config.hooks.post_turn).toBe('git push')
  })

  it('defaults port to 8080', () => {
    const config = loadConfig(`transport: http\nruntime: local\n${QA_AGENT_YAML}`)
    expect(config.port).toBe(8080)
  })

  it('default runtime flips to docker', () => {
    const config = loadConfig(`transport: http\n${QA_AGENT_YAML}`)
    expect(config.runtime).toBe('docker')
  })

  it('default image is budd/claude-code:latest when runtime is docker', () => {
    const config = loadConfig(`transport: http\nruntime: docker\n${QA_AGENT_YAML}`)
    expect(config.docker?.image).toBe('budd/claude-code:latest')
  })

  it('accepts runtime: docker', () => {
    const config = loadConfig(`transport: http\nruntime: docker\n${QA_AGENT_YAML}`)
    expect(config.runtime).toBe('docker')
    expect(config.docker).toBeDefined()
  })

  it('parses docker.image', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker:
  image: budd/claude-code:1.2.3
agents:
  qa:
    workdir: ./qa
`)
    expect(config.docker?.image).toBe('budd/claude-code:1.2.3')
  })

  it('docker block is undefined when runtime is local', () => {
    const config = loadConfig(`
transport: http
runtime: local
docker:
  image: whatever
agents:
  qa:
    workdir: ./qa
`)
    expect(config.docker).toBeUndefined()
  })

  it('parses docker.home_mounts', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker:
  home_mounts:
    - path: .claude
      mode: rw
    - path: .codex/sessions
      mode: ro
agents:
  qa:
    workdir: ./qa
`)
    expect(config.docker?.home_mounts).toEqual([
      { path: '.claude', mode: 'rw' },
      { path: '.codex/sessions', mode: 'ro' },
    ])
  })

  it('rejects invalid home_mounts mode', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: docker
docker:
  home_mounts:
    - path: .claude
      mode: exec
agents:
  qa:
    workdir: ./qa
`),
    ).toThrow(/home_mounts\[\]\.mode must be "ro" or "rw"/)
  })

  it('rejects empty home_mounts path', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: docker
docker:
  home_mounts:
    - path: ""
      mode: rw
agents:
  qa:
    workdir: ./qa
`),
    ).toThrow(/home_mounts\[\]\.path must be a non-empty string/)
  })

  it('rejects unknown transport', () => {
    expect(() => loadConfig(`transport: slack`)).toThrow(
      /transport must be "http"/,
    )
  })

  it('rejects non-integer port', () => {
    expect(() =>
      loadConfig(`transport: http\nport: "eighty"\n${QA_AGENT_YAML}`),
    ).toThrow(/port must be an integer/)
  })

  it('rejects malformed yaml', () => {
    expect(() => loadConfig(`transport: http\n  bad: indent`)).toThrow()
  })
})

describe('loadConfig — agents map', () => {
  it('parses agents: map with per-agent workdir and hooks', () => {
    const config = loadConfig(`
transport: http
runtime: local
agents:
  qa:
    workdir: ./workspaces/qa
    hooks:
      pre_turn: ./hooks/qa-pre.sh
  product:
    workdir: ./workspaces/product
`)
    expect(Object.keys(config.agents).sort()).toEqual(['product', 'qa'])
    expect(config.agents.qa.name).toBe('qa')
    expect(config.agents.qa.workdir).toBe('./workspaces/qa')
    expect(config.agents.qa.hooks.pre_turn).toBe('./hooks/qa-pre.sh')
    expect(config.agents.product.workdir).toBe('./workspaces/product')
    expect(config.agents.product.hooks).toEqual({})
  })

  it('merges daemon-wide hooks into each agent, per-agent overrides win', () => {
    const config = loadConfig(`
transport: http
runtime: local
hooks:
  pre_turn: daemon-pre
  post_turn: daemon-post
agents:
  qa:
    workdir: ./qa
    hooks:
      pre_turn: qa-pre
  product:
    workdir: ./product
`)
    expect(config.agents.qa.hooks).toEqual({
      pre_turn: 'qa-pre',
      post_turn: 'daemon-post',
    })
    expect(config.agents.product.hooks).toEqual({
      pre_turn: 'daemon-pre',
      post_turn: 'daemon-post',
    })
  })

  it('null at agent-level disables a daemon-wide hook', () => {
    const config = loadConfig(`
transport: http
runtime: local
hooks:
  pre_turn: daemon-pre
agents:
  qa:
    workdir: ./qa
    hooks:
      pre_turn: ~
`)
    expect(config.agents.qa.hooks.pre_turn).toBeUndefined()
  })

  it('rejects missing agents key', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
`),
    ).toThrow(/agents: is required/i)
  })

  it('rejects empty agents: map', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents: {}
`),
    ).toThrow(/agents: must have at least one entry/i)
  })

  it('rejects top-level workdir (flat form removed)', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
workdir: ./
agents:
  qa:
    workdir: ./qa
`),
    ).toThrow(/top-level workdir is not supported.*agents/i)
  })

  it('rejects top-level workdir even when agents absent', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
workdir: ./
`),
    ).toThrow(/top-level workdir is not supported/i)
  })

  it('rejects agents entry missing workdir', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  qa:
    hooks:
      pre_turn: x
`),
    ).toThrow(/agents\.qa\.workdir is required/i)
  })

  it('rejects bad agent names', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  Qa:
    workdir: ./qa
`),
    ).toThrow(/agents\.Qa: name must match/i)
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  "9qa":
    workdir: ./qa
`),
    ).toThrow(/name must match/i)
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  "":
    workdir: ./qa
`),
    ).toThrow(/name must match/i)
  })
})

describe('mergeCliFlags', () => {
  function baseConfig(overrides: Partial<BuddConfig> = {}): BuddConfig {
    return {
      transport: 'http',
      port: 8080,
      runtime: 'local',
      agents: {
        qa: { name: 'qa', workdir: './qa', hooks: {} },
      },
      hooks: {},
      ...overrides,
    }
  }

  it('CLI port overrides YAML port', () => {
    expect(mergeCliFlags(baseConfig(), { port: 9090 }).port).toBe(9090)
  })

  it('absent CLI flags leave YAML values intact', () => {
    const merged = mergeCliFlags(baseConfig({ port: 7070 }), {})
    expect(merged.port).toBe(7070)
  })

  it('preserves agents map through merge', () => {
    const merged = mergeCliFlags(baseConfig(), { port: 9999 })
    expect(merged.agents.qa.workdir).toBe('./qa')
  })

  it('accepts --runtime docker from CLI flags', () => {
    const merged = mergeCliFlags(baseConfig(), { runtime: 'docker' })
    expect(merged.runtime).toBe('docker')
    expect(merged.docker?.image).toBe('budd/claude-code:latest')
  })

  it('CLI --image overrides docker.image', () => {
    const dockerBase = baseConfig({
      runtime: 'docker',
      docker: { image: 'budd/claude-code:1.0.0' },
    })
    const merged = mergeCliFlags(dockerBase, { image: 'custom:2.0' })
    expect(merged.docker?.image).toBe('custom:2.0')
  })

  it('preserves home_mounts from base config through merge', () => {
    const dockerBase = baseConfig({
      runtime: 'docker',
      docker: {
        image: 'budd/claude-code:latest',
        home_mounts: [{ path: '.claude', mode: 'rw' as const }],
      },
    })
    const merged = mergeCliFlags(dockerBase, {})
    expect(merged.docker?.home_mounts).toEqual([{ path: '.claude', mode: 'rw' }])
  })

  it('rejects unknown --runtime values from CLI flags', () => {
    expect(() => mergeCliFlags(baseConfig(), { runtime: 'firecracker' })).toThrow(
      /runtime must be "local" or "docker"/,
    )
  })

  it('rejects --transport slack from CLI flags', () => {
    expect(() => mergeCliFlags(baseConfig(), { transport: 'slack' })).toThrow(
      /transport must be "http"/,
    )
  })
})
