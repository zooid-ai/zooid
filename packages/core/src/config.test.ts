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

  it('rejects daemon-wide docker.home_mounts with a migration pointer', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: docker
docker:
  image: budd/claude-code:latest
  home_mounts:
    - { path: .claude/projects, mode: rw }
agents:
  qa:
    workdir: ./qa
`),
    ).toThrow(/docker\.home_mounts is removed/i)
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

describe('loadConfig — per-agent adapter + docker block', () => {
  it('parses per-agent adapter', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
  qa:
    workdir: ./qa
  ship:
    workdir: ./ship
    adapter: codex
    docker:
      image: budd/codex:latest
`)
    expect(config.agents.qa.adapter).toBeUndefined()
    expect(config.agents.ship.adapter).toEqual({ type: 'codex' })
    expect(config.agents.qa.docker?.image).toBeUndefined()
    expect(config.agents.ship.docker?.image).toBe('budd/codex:latest')
  })

  it('parses per-agent docker.mounts.extra', () => {
    const config = loadConfig(`
transport: http
runtime: docker
agents:
  qa:
    workdir: ./qa
    docker:
      mounts:
        extra:
          - path: ./shared-docs
            target: /workspace/docs
            mode: ro
          - path: /abs/cache
            target: /cache
            mode: rw
`)
    expect(config.agents.qa.docker?.mounts?.extra).toEqual([
      { path: './shared-docs', target: '/workspace/docs', mode: 'ro' },
      { path: '/abs/cache', target: '/cache', mode: 'rw' },
    ])
  })

  it('parses per-agent docker.mounts.workspace_readonly_disable', () => {
    const config = loadConfig(`
transport: http
runtime: docker
agents:
  qa:
    workdir: ./qa
    docker:
      mounts:
        workspace_readonly_disable: [CLAUDE.md]
`)
    expect(config.agents.qa.docker?.mounts?.workspace_readonly_disable).toEqual([
      'CLAUDE.md',
    ])
  })

  it('rejects mounts.extra with missing target', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: docker
agents:
  qa:
    workdir: ./qa
    docker:
      mounts:
        extra:
          - path: ./docs
            mode: ro
`),
    ).toThrow(/extra\[\]\.target is required/i)
  })

  it('rejects mounts.extra with invalid mode', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: docker
agents:
  qa:
    workdir: ./qa
    docker:
      mounts:
        extra:
          - path: ./docs
            target: /docs
            mode: exec
`),
    ).toThrow(/extra\[\]\.mode must be "ro" or "rw"/i)
  })

  it('rejects agents.*.docker when runtime is not docker', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  qa:
    workdir: ./qa
    docker:
      image: budd/claude-code:latest
`),
    ).toThrow(/docker.*only.*when runtime.*docker/i)
  })

  it('parser accepts any adapter name string (validation is in buildRunnersFromConfig)', () => {
    const config = loadConfig(`
transport: http
runtime: docker
agents:
  qa:
    workdir: ./qa
    adapter: opencode
`)
    expect(config.agents.qa.adapter).toEqual({ type: 'opencode' })
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

describe('parseAgents — adapter: AgentAdapterRef', () => {
  const base = `
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
`

  it('accepts string shorthand and normalizes to object form', () => {
    const cfg = loadConfig(`${base}
  qa:
    workdir: .
    adapter: claude
`)
    expect(cfg.agents.qa.adapter).toEqual({ type: 'claude' })
  })

  it('accepts object form verbatim with options passthrough', () => {
    const cfg = loadConfig(`${base}
  review:
    workdir: .
    adapter:
      type: opencode
      options:
        model: anthropic/claude-sonnet-4-6
`)
    expect(cfg.agents.review.adapter).toEqual({
      type: 'opencode',
      options: { model: 'anthropic/claude-sonnet-4-6' },
    })
  })

  it('accepts object form without options', () => {
    const cfg = loadConfig(`${base}
  qa:
    workdir: .
    adapter:
      type: claude
`)
    expect(cfg.agents.qa.adapter).toEqual({ type: 'claude' })
  })

  it('rejects object form with no type, naming the agent key', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    adapter:
      options: { model: foo/bar }
`),
    ).toThrow(/agents\.qa\.adapter\.type is required/i)
  })

  it('rejects non-string non-object adapter', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    adapter: 42
`),
    ).toThrow(/agents\.qa\.adapter must be a string or a mapping/i)
  })

  it('rejects empty-string shorthand', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    adapter: ""
`),
    ).toThrow(/agents\.qa\.adapter/i)
  })
})

describe('parseAgentDocker — forward_env', () => {
  const base = `
transport: http
runtime: docker
docker: { image: budd/claude-code:latest }
agents:
`

  it('accepts plain pass-through entries', () => {
    const cfg = loadConfig(`${base}
  qa:
    workdir: .
    docker:
      forward_env:
        - HTTPS_PROXY
        - JIRA_URL
`)
    expect(cfg.agents.qa.docker?.forward_env).toEqual(['HTTPS_PROXY', 'JIRA_URL'])
  })

  it('accepts rename entries (HOST:CONTAINER)', () => {
    const cfg = loadConfig(`${base}
  qa:
    workdir: .
    docker:
      forward_env:
        - CORP_JIRA_TOKEN:JIRA_TOKEN
`)
    expect(cfg.agents.qa.docker?.forward_env).toEqual(['CORP_JIRA_TOKEN:JIRA_TOKEN'])
  })

  it('rejects non-string entries', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    docker:
      forward_env:
        - 42
`),
    ).toThrow(/agents\.qa\.docker\.forward_env\[\] must be a non-empty string/i)
  })

  it('rejects empty-string entries', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    docker:
      forward_env: [""]
`),
    ).toThrow(/agents\.qa\.docker\.forward_env\[\] must be a non-empty string/i)
  })

  it('rejects ":FOO" (empty host name)', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    docker:
      forward_env: [":FOO"]
`),
    ).toThrow(/agents\.qa\.docker\.forward_env\[\] has empty host or container name/i)
  })

  it('rejects "FOO:" (empty container name)', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    docker:
      forward_env: ["FOO:"]
`),
    ).toThrow(/agents\.qa\.docker\.forward_env\[\] has empty host or container name/i)
  })

  it('rejects forward_env when runtime !== docker', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  qa:
    workdir: .
    docker:
      forward_env: [FOO]
`),
    ).toThrow(/agents\.qa\.docker is only valid when runtime: docker/i)
  })

  it('rejects forward_env not being an array', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    docker:
      forward_env: "FOO"
`),
    ).toThrow(/agents\.qa\.docker\.forward_env must be an array of strings/i)
  })
})
