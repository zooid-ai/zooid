import { describe, it, expect } from 'vitest'
import { loadConfig, mergeCliFlags } from './config.js'
import type { ZooidConfig } from './types.js'

const QA_AGENTS = `
agents:
  qa:
    workdir: ./qa
    acp:
      preset: claude
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
    acp:
      preset: claude
`)
    expect(config).toEqual({
      transport: 'http',
      port: 8080,
      runtime: 'local',
      agents: {
        qa: {
          name: 'qa',
          workdir: './qa',
          hooks: {},
          acp: { preset: 'claude' },
          approval_timeout_ms: 0,
        },
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
${QA_AGENTS.trimStart()}`)
    expect(config.hooks.pre_turn).toBe('git pull')
    expect(config.hooks.post_turn).toBe('git push')
  })

  it('defaults port to 8080', () => {
    const config = loadConfig(`transport: http\nruntime: local${QA_AGENTS}`)
    expect(config.port).toBe(8080)
  })

  it('default runtime flips to docker', () => {
    const config = loadConfig(`transport: http${QA_AGENTS}`)
    expect(config.runtime).toBe('docker')
  })

  it('default image is ghcr.io/zooid-ai/zooid-agent-base:latest when runtime is docker', () => {
    const config = loadConfig(`transport: http\nruntime: docker${QA_AGENTS}`)
    expect(config.docker?.image).toBe('ghcr.io/zooid-ai/zooid-agent-base:latest')
  })

  it('parses docker.image override', () => {
    const config = loadConfig(`
transport: http
runtime: docker
docker:
  image: ghcr.io/zooid-ai/zooid-agent-base:1.2.3
agents:
  qa:
    workdir: ./qa
    acp:
      preset: claude
`)
    expect(config.docker?.image).toBe('ghcr.io/zooid-ai/zooid-agent-base:1.2.3')
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
    acp:
      preset: claude
`)
    expect(config.docker).toBeUndefined()
  })

  it('rejects unknown transport', () => {
    expect(() => loadConfig(`transport: slack`)).toThrow(/transport must be "http"/)
  })

  it('rejects non-integer port', () => {
    expect(() =>
      loadConfig(`transport: http\nport: "eighty"${QA_AGENTS}`),
    ).toThrow(/port must be an integer/)
  })

  it('rejects malformed yaml', () => {
    expect(() => loadConfig(`transport: http\n  bad: indent`)).toThrow()
  })
})

describe('loadConfig — agents map', () => {
  it('parses multiple agents with per-agent workdir, hooks, and acp blocks', () => {
    const config = loadConfig(`
transport: http
runtime: local
agents:
  qa:
    workdir: ./workspaces/qa
    acp:
      preset: claude
    hooks:
      pre_turn: ./hooks/qa-pre.sh
  product:
    workdir: ./workspaces/product
    acp:
      preset: codex
`)
    expect(Object.keys(config.agents).sort()).toEqual(['product', 'qa'])
    expect(config.agents.qa.acp).toEqual({ preset: 'claude' })
    expect(config.agents.qa.hooks.pre_turn).toBe('./hooks/qa-pre.sh')
    expect(config.agents.product.acp).toEqual({ preset: 'codex' })
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
    acp: { preset: claude }
    hooks:
      pre_turn: qa-pre
  product:
    workdir: ./product
    acp: { preset: codex }
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
    acp: { preset: claude }
    hooks:
      pre_turn: ~
`)
    expect(config.agents.qa.hooks.pre_turn).toBeUndefined()
  })

  it('rejects missing agents key', () => {
    expect(() => loadConfig(`transport: http\nruntime: local`)).toThrow(
      /agents: is required/i,
    )
  })

  it('rejects empty agents: map', () => {
    expect(() =>
      loadConfig(`transport: http\nruntime: local\nagents: {}`),
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
    acp: { preset: claude }
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
    acp: { preset: claude }
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
    acp: { preset: claude }
`),
    ).toThrow(/agents\.Qa: name must match/i)
  })
})

describe('loadConfig — per-agent docker block', () => {
  it('parses per-agent docker.image', () => {
    const config = loadConfig(`
transport: http
runtime: docker
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
  ship:
    workdir: ./ship
    acp: { preset: codex }
    docker:
      image: ghcr.io/zooid-ai/zooid-agent-base:custom
`)
    expect(config.agents.qa.docker?.image).toBeUndefined()
    expect(config.agents.ship.docker?.image).toBe(
      'ghcr.io/zooid-ai/zooid-agent-base:custom',
    )
  })

  it('rejects agents.*.docker when runtime is not docker', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    docker:
      image: x
`),
    ).toThrow(/docker.*only.*when runtime.*docker/i)
  })
})

describe('parseAgentDocker — forward_env', () => {
  const base = `
transport: http
runtime: docker
agents:
`

  it('accepts plain pass-through entries', () => {
    const cfg = loadConfig(`${base}
  qa:
    workdir: .
    acp: { preset: claude }
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
    acp: { preset: claude }
    docker:
      forward_env:
        - CORP_JIRA_TOKEN:JIRA_TOKEN
`)
    expect(cfg.agents.qa.docker?.forward_env).toEqual(['CORP_JIRA_TOKEN:JIRA_TOKEN'])
  })

  it('rejects ":FOO" (empty host name)', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    acp: { preset: claude }
    docker:
      forward_env: [":FOO"]
`),
    ).toThrow(/empty host or container name/i)
  })

  it('rejects "FOO:" (empty container name)', () => {
    expect(() =>
      loadConfig(`${base}
  qa:
    workdir: .
    acp: { preset: claude }
    docker:
      forward_env: ["FOO:"]
`),
    ).toThrow(/empty host or container name/i)
  })
})

describe('mergeCliFlags', () => {
  function baseConfig(overrides: Partial<ZooidConfig> = {}): ZooidConfig {
    return {
      transport: 'http',
      port: 8080,
      runtime: 'local',
      agents: {
        qa: {
          name: 'qa',
          workdir: './qa',
          hooks: {},
          acp: { preset: 'claude' },
          approval_timeout_ms: 0,
        },
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

  it('accepts --runtime docker from CLI flags, sets default image', () => {
    const merged = mergeCliFlags(baseConfig(), { runtime: 'docker' })
    expect(merged.runtime).toBe('docker')
    expect(merged.docker?.image).toBe('ghcr.io/zooid-ai/zooid-agent-base:latest')
  })

  it('CLI --image overrides docker.image', () => {
    const dockerBase = baseConfig({
      runtime: 'docker',
      docker: { image: 'ghcr.io/zooid-ai/zooid-agent-base:1.0.0' },
    })
    const merged = mergeCliFlags(dockerBase, { image: 'custom:2.0' })
    expect(merged.docker?.image).toBe('custom:2.0')
  })

  it('rejects unknown --runtime values from CLI flags', () => {
    expect(() => mergeCliFlags(baseConfig(), { runtime: 'firecracker' })).toThrow(
      /runtime must be "local", "docker", or "podman"/,
    )
  })

  it('rejects --transport slack from CLI flags', () => {
    expect(() => mergeCliFlags(baseConfig(), { transport: 'slack' })).toThrow(
      /transport must be "http" or "matrix"/,
    )
  })
})

const MATRIX_BLOCK = `
matrix:
  homeserver: http://localhost:8448
  as_token: as-secret
  hs_token: hs-secret
  sender_localpart: zooid
  user_namespace: '@.*:localhost'
`

describe('loadConfig (matrix transport)', () => {
  it('parses transport: matrix with the matrix block and per-agent matrix fields', () => {
    const config = loadConfig(`
transport: matrix
runtime: local
${MATRIX_BLOCK.trimStart()}
agents:
  architect:
    workdir: ./architect
    matrix_user_id: '@architect:localhost'
    rooms:
      - '!r1:localhost'
    trigger: mention
    acp:
      preset: claude
`)
    expect(config.transport).toBe('matrix')
    expect(config.matrix?.homeserver).toBe('http://localhost:8448')
    expect(config.matrix?.user_namespace).toBe('@.*:localhost')
    expect(config.agents.architect.matrix_user_id).toBe('@architect:localhost')
    expect(config.agents.architect.rooms).toEqual(['!r1:localhost'])
    expect(config.agents.architect.trigger).toBe('mention')
  })

  it('defaults trigger to "mention" when omitted', () => {
    const config = loadConfig(`
transport: matrix
runtime: local
${MATRIX_BLOCK.trimStart()}
agents:
  architect:
    workdir: ./architect
    matrix_user_id: '@architect:localhost'
    rooms:
      - '!r1:localhost'
    acp:
      preset: claude
`)
    expect(config.agents.architect.trigger).toBe('mention')
  })

  it('rejects matrix block when transport is http', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
${MATRIX_BLOCK.trimStart()}
agents:
  qa:
    workdir: ./qa
    acp:
      preset: claude
`),
    ).toThrow(/matrix: block is only valid when transport: matrix/)
  })

  it('rejects per-agent matrix_user_id when transport is http', () => {
    expect(() =>
      loadConfig(`
transport: http
runtime: local
agents:
  qa:
    workdir: ./qa
    matrix_user_id: '@qa:localhost'
    acp:
      preset: claude
`),
    ).toThrow(/matrix_user_id is only valid when transport: matrix/)
  })

  it('requires the matrix block when transport: matrix', () => {
    expect(() =>
      loadConfig(`
transport: matrix
runtime: local
agents:
  architect:
    workdir: ./architect
    matrix_user_id: '@architect:localhost'
    rooms:
      - '!r1:localhost'
    acp:
      preset: claude
`),
    ).toThrow(/matrix: block is required when transport: matrix/)
  })

  it('requires per-agent matrix_user_id and rooms when transport: matrix', () => {
    expect(() =>
      loadConfig(`
transport: matrix
runtime: local
${MATRIX_BLOCK.trimStart()}
agents:
  architect:
    workdir: ./architect
    acp:
      preset: claude
`),
    ).toThrow(/matrix_user_id is required/)
  })

  it('rejects bad matrix_user_id format', () => {
    expect(() =>
      loadConfig(`
transport: matrix
runtime: local
${MATRIX_BLOCK.trimStart()}
agents:
  architect:
    workdir: ./architect
    matrix_user_id: 'not-a-matrix-id'
    rooms:
      - '!r1:localhost'
    acp:
      preset: claude
`),
    ).toThrow(/matrix_user_id must look like @localpart:server/)
  })
})

