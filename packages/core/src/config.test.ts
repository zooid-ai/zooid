import { describe, it, expect } from 'vitest'
import { loadWorkforceConfig, mergeCliFlags } from './config.js'
import type { WorkforceConfig } from './types.js'

const HTTP_TRANSPORT = `
transports:
  http-local:
    type: http
    port: 8080
`

const QA_AGENTS = `
agents:
  qa:
    transport: http-local
    workdir: ./qa
    acp:
      preset: claude
`

describe('loadWorkforceConfig', () => {
  it('parses a minimal workforce.yaml', () => {
    const config = loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}${QA_AGENTS}`)
    expect(config).toEqual({
      runtime: 'local',
      transports: {
        'http-local': { type: 'http', port: 8080 },
      },
      agents: {
        qa: {
          name: 'qa',
          transport: 'http-local',
          workdir: './qa',
          hooks: {},
          acp: { preset: 'claude' },
          approval_timeout_ms: 0,
        },
      },
      hooks: {},
    })
  })

  it('parses workforce-wide hooks', () => {
    const config = loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
hooks:
  pre_turn: "git pull"
  post_turn: "git push"
${QA_AGENTS.trimStart()}`)
    expect(config.hooks.pre_turn).toBe('git pull')
    expect(config.hooks.post_turn).toBe('git push')
  })

  it('http transport defaults port to 8080', () => {
    const config = loadWorkforceConfig(`
runtime: local
transports:
  http-local:
    type: http
${QA_AGENTS}`)
    expect(config.transports['http-local']).toEqual({ type: 'http', port: 8080 })
  })

  it('default runtime flips to docker', () => {
    const config = loadWorkforceConfig(`${HTTP_TRANSPORT}${QA_AGENTS}`)
    expect(config.runtime).toBe('docker')
  })

  it('default image is ghcr.io/zooid-ai/zooid-agent-base:latest when runtime is docker', () => {
    const config = loadWorkforceConfig(`runtime: docker${HTTP_TRANSPORT}${QA_AGENTS}`)
    expect(config.docker?.image).toBe('ghcr.io/zooid-ai/zooid-agent-base:latest')
  })

  it('parses docker.image override', () => {
    const config = loadWorkforceConfig(`
runtime: docker
${HTTP_TRANSPORT.trimStart()}
docker:
  image: ghcr.io/zooid-ai/zooid-agent-base:1.2.3
agents:
  qa:
    transport: http-local
    workdir: ./qa
    acp:
      preset: claude
`)
    expect(config.docker?.image).toBe('ghcr.io/zooid-ai/zooid-agent-base:1.2.3')
  })

  it('docker block is undefined when runtime is local', () => {
    const config = loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
docker:
  image: whatever
agents:
  qa:
    transport: http-local
    workdir: ./qa
    acp:
      preset: claude
`)
    expect(config.docker).toBeUndefined()
  })

  it('rejects http transport with non-integer port', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
transports:
  http-local:
    type: http
    port: "eighty"
${QA_AGENTS}`),
    ).toThrow(/transports\.http-local\.port must be an integer/)
  })

  it('rejects malformed yaml', () => {
    expect(() => loadWorkforceConfig(`runtime: local\n  bad: indent`)).toThrow()
  })

  it('rejects top-level transport: (legacy shape)', () => {
    expect(() =>
      loadWorkforceConfig(`
transport: http
runtime: local
${QA_AGENTS}`),
    ).toThrow(/top-level "transport:" is no longer supported/)
  })

  it('rejects top-level matrix: (legacy shape)', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
matrix:
  homeserver: http://localhost:8448
${HTTP_TRANSPORT}${QA_AGENTS}`),
    ).toThrow(/top-level "matrix:" is no longer supported/)
  })
})

describe('loadWorkforceConfig — agents map', () => {
  it('parses multiple agents with per-agent workdir, hooks, and acp blocks', () => {
    const config = loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    transport: http-local
    workdir: ./workspaces/qa
    acp:
      preset: claude
    hooks:
      pre_turn: ./hooks/qa-pre.sh
  product:
    transport: http-local
    workdir: ./workspaces/product
    acp:
      preset: codex
`)
    expect(Object.keys(config.agents).sort()).toEqual(['product', 'qa'])
    expect(config.agents.qa!.acp).toEqual({ preset: 'claude' })
    expect(config.agents.qa!.hooks.pre_turn).toBe('./hooks/qa-pre.sh')
    expect(config.agents.product!.acp).toEqual({ preset: 'codex' })
    expect(config.agents.product!.hooks).toEqual({})
  })

  it('merges workforce-wide hooks into each agent, per-agent overrides win', () => {
    const config = loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
hooks:
  pre_turn: daemon-pre
  post_turn: daemon-post
agents:
  qa:
    transport: http-local
    workdir: ./qa
    acp: { preset: claude }
    hooks:
      pre_turn: qa-pre
  product:
    transport: http-local
    workdir: ./product
    acp: { preset: codex }
`)
    expect(config.agents.qa!.hooks).toEqual({
      pre_turn: 'qa-pre',
      post_turn: 'daemon-post',
    })
    expect(config.agents.product!.hooks).toEqual({
      pre_turn: 'daemon-pre',
      post_turn: 'daemon-post',
    })
  })

  it('null at agent-level disables a workforce-wide hook', () => {
    const config = loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
hooks:
  pre_turn: daemon-pre
agents:
  qa:
    transport: http-local
    workdir: ./qa
    acp: { preset: claude }
    hooks:
      pre_turn: ~
`)
    expect(config.agents.qa!.hooks.pre_turn).toBeUndefined()
  })

  it('rejects missing agents key', () => {
    expect(() =>
      loadWorkforceConfig(`runtime: local${HTTP_TRANSPORT}`),
    ).toThrow(/agents: is required/i)
  })

  it('rejects empty agents: map', () => {
    expect(() =>
      loadWorkforceConfig(`runtime: local${HTTP_TRANSPORT}\nagents: {}`),
    ).toThrow(/agents: must have at least one entry/i)
  })

  it('rejects top-level workdir (flat form removed)', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
workdir: ./
${HTTP_TRANSPORT}${QA_AGENTS}`),
    ).toThrow(/top-level workdir is not supported/i)
  })

  it('rejects agents entry missing workdir', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    transport: http-local
    acp: { preset: claude }
`),
    ).toThrow(/agents\.qa\.workdir is required/i)
  })

  it('rejects bad agent names', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  Qa:
    transport: http-local
    workdir: ./qa
    acp: { preset: claude }
`),
    ).toThrow(/agents\.Qa: name must match/i)
  })
})

describe('loadWorkforceConfig — per-agent docker block', () => {
  it('parses per-agent docker.image', () => {
    const config = loadWorkforceConfig(`
runtime: docker
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    transport: http-local
    workdir: ./qa
    acp: { preset: claude }
  ship:
    transport: http-local
    workdir: ./ship
    acp: { preset: codex }
    docker:
      image: ghcr.io/zooid-ai/zooid-agent-base:custom
`)
    expect(config.agents.qa!.docker?.image).toBeUndefined()
    expect(config.agents.ship!.docker?.image).toBe(
      'ghcr.io/zooid-ai/zooid-agent-base:custom',
    )
  })

  it('rejects agents.*.docker when runtime is not docker', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    transport: http-local
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
runtime: docker
${HTTP_TRANSPORT.trimStart()}
agents:
`

  it('accepts plain pass-through entries', () => {
    const cfg = loadWorkforceConfig(`${base}
  qa:
    transport: http-local
    workdir: .
    acp: { preset: claude }
    docker:
      forward_env:
        - HTTPS_PROXY
        - JIRA_URL
`)
    expect(cfg.agents.qa!.docker?.forward_env).toEqual(['HTTPS_PROXY', 'JIRA_URL'])
  })

  it('accepts rename entries (HOST:CONTAINER)', () => {
    const cfg = loadWorkforceConfig(`${base}
  qa:
    transport: http-local
    workdir: .
    acp: { preset: claude }
    docker:
      forward_env:
        - CORP_JIRA_TOKEN:JIRA_TOKEN
`)
    expect(cfg.agents.qa!.docker?.forward_env).toEqual(['CORP_JIRA_TOKEN:JIRA_TOKEN'])
  })

  it('rejects ":FOO" (empty host name)', () => {
    expect(() =>
      loadWorkforceConfig(`${base}
  qa:
    transport: http-local
    workdir: .
    acp: { preset: claude }
    docker:
      forward_env: [":FOO"]
`),
    ).toThrow(/empty host or container name/i)
  })

  it('rejects "FOO:" (empty container name)', () => {
    expect(() =>
      loadWorkforceConfig(`${base}
  qa:
    transport: http-local
    workdir: .
    acp: { preset: claude }
    docker:
      forward_env: ["FOO:"]
`),
    ).toThrow(/empty host or container name/i)
  })
})

describe('mergeCliFlags', () => {
  function baseConfig(overrides: Partial<WorkforceConfig> = {}): WorkforceConfig {
    return {
      runtime: 'local',
      transports: { 'http-local': { type: 'http', port: 8080 } },
      agents: {
        qa: {
          name: 'qa',
          transport: 'http-local',
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

  it('absent CLI flags leave YAML values intact', () => {
    const merged = mergeCliFlags(baseConfig(), {})
    expect(merged.runtime).toBe('local')
    expect(merged.transports['http-local']).toEqual({ type: 'http', port: 8080 })
  })

  it('preserves agents map through merge', () => {
    const merged = mergeCliFlags(baseConfig(), { runtime: 'docker' })
    expect(merged.agents.qa!.workdir).toBe('./qa')
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
})

const MATRIX_TRANSPORT = `
transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-secret
    hs_token: hs-secret
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
`

describe('loadWorkforceConfig (matrix transport)', () => {
  it('parses a matrix transport with per-agent matrix fields', () => {
    const config = loadWorkforceConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  architect:
    transport: matrix-local
    workdir: ./architect
    matrix_user_id: '@architect:localhost'
    rooms:
      - '!r1:localhost'
    trigger: mention
    acp:
      preset: claude
`)
    const t = config.transports['matrix-local']!
    expect(t.type).toBe('matrix')
    if (t.type === 'matrix') {
      expect(t.homeserver).toBe('http://localhost:8448')
      expect(t.user_namespace).toBe('@.*:localhost')
    }
    expect(config.agents.architect!.matrix_user_id).toBe('@architect:localhost')
    expect(config.agents.architect!.rooms).toEqual(['!r1:localhost'])
    expect(config.agents.architect!.trigger).toBe('mention')
  })

  it('defaults trigger to "mention" when omitted', () => {
    const config = loadWorkforceConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  architect:
    transport: matrix-local
    workdir: ./architect
    matrix_user_id: '@architect:localhost'
    rooms:
      - '!r1:localhost'
    acp:
      preset: claude
`)
    expect(config.agents.architect!.trigger).toBe('mention')
  })

  it('rejects per-agent matrix_user_id when transport is type: http', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    transport: http-local
    workdir: ./qa
    matrix_user_id: '@qa:localhost'
    acp:
      preset: claude
`),
    ).toThrow(/matrix_user_id is only valid when transport is type: matrix/)
  })

  it('rejects bad matrix_user_id format', () => {
    expect(() =>
      loadWorkforceConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  architect:
    transport: matrix-local
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
