import { describe, it, expect } from 'vitest'
import { loadZooidConfig, mergeCliFlags } from './config.js'
import type { ZooidConfig } from './types.js'

const HTTP_TRANSPORT = `
transports:
  http-local:
    type: http
    port: 8080
`

const QA_AGENTS = `
agents:
  qa:
    workdir: ./qa
    acp:
      preset: claude
    http:
      transport: http-local
`

const MATRIX_TRANSPORT_FULL = `
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-tok
    hs_token: hs-tok
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
`

// Minimal matrix transport relying on every transport-side default (type from
// key, sender_localpart, user_namespace, tokens). Used by the agent-side
// tests that need a working matrix transport without restating defaults.
const MATRIX_TRANSPORT_MIN = `
transports:
  matrix:
    homeserver: http://localhost:8448
`

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = process.env[k]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('loadZooidConfig', () => {
  it('parses a minimal zooid.yaml', () => {
    const config = loadZooidConfig(`
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
          workdir: './qa',
          hooks: {},
          acp: { preset: 'claude' },
          approval_timeout_ms: 0,
          http: { transport: 'http-local' },
        },
      },
      hooks: {},
    })
  })

  it('parses workforce-wide hooks', () => {
    const config = loadZooidConfig(`
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
    const config = loadZooidConfig(`
runtime: local
transports:
  http-local:
    type: http
${QA_AGENTS}`)
    expect(config.transports['http-local']).toEqual({ type: 'http', port: 8080 })
  })

  it('default runtime flips to docker', () => {
    const config = loadZooidConfig(`${HTTP_TRANSPORT}${QA_AGENTS}`)
    expect(config.runtime).toBe('docker')
  })

  it('parses container.image override at workforce level', () => {
    const config = loadZooidConfig(`
runtime: docker
${HTTP_TRANSPORT.trimStart()}
container:
  image: ghcr.io/zooid-ai/zooid-agent-base:1.2.3
agents:
  qa:
    workdir: ./qa
    acp:
      preset: claude
    http:
      transport: http-local
`)
    expect(config.container?.image).toBe('ghcr.io/zooid-ai/zooid-agent-base:1.2.3')
  })

  it('container is undefined when omitted under runtime: docker', () => {
    const config = loadZooidConfig(`runtime: docker${HTTP_TRANSPORT}${QA_AGENTS}`)
    expect(config.container).toBeUndefined()
  })

  it('rejects http transport with non-integer port', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
transports:
  http-local:
    type: http
    port: "eighty"
${QA_AGENTS}`),
    ).toThrow(/transports\.http-local\.port must be an integer/)
  })

  it('rejects malformed yaml', () => {
    expect(() => loadZooidConfig(`runtime: local\n  bad: indent`)).toThrow()
  })

  it('rejects top-level transport: (legacy shape)', () => {
    expect(() =>
      loadZooidConfig(`
transport: http
runtime: local
${QA_AGENTS}`),
    ).toThrow(/top-level "transport:" is no longer supported/)
  })

  it('rejects top-level matrix: (legacy shape)', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
matrix:
  homeserver: http://localhost:8448
${HTTP_TRANSPORT}${QA_AGENTS}`),
    ).toThrow(/top-level "matrix:" is no longer supported/)
  })
})

describe('loadZooidConfig — agents map', () => {
  it('parses multiple agents with per-agent workdir, hooks, and acp blocks', () => {
    const config = loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: ./workspaces/qa
    acp:
      preset: claude
    http: { transport: http-local }
    hooks:
      pre_turn: ./hooks/qa-pre.sh
  product:
    workdir: ./workspaces/product
    acp:
      preset: codex
    http: { transport: http-local }
`)
    expect(Object.keys(config.agents).sort()).toEqual(['product', 'qa'])
    expect(config.agents.qa!.acp).toEqual({ preset: 'claude' })
    expect(config.agents.qa!.hooks.pre_turn).toBe('./hooks/qa-pre.sh')
    expect(config.agents.product!.acp).toEqual({ preset: 'codex' })
    expect(config.agents.product!.hooks).toEqual({})
  })

  it('merges workforce-wide hooks into each agent, per-agent overrides win', () => {
    const config = loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
hooks:
  pre_turn: daemon-pre
  post_turn: daemon-post
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    http: { transport: http-local }
    hooks:
      pre_turn: qa-pre
  product:
    workdir: ./product
    acp: { preset: codex }
    http: { transport: http-local }
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
    const config = loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
hooks:
  pre_turn: daemon-pre
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    http: { transport: http-local }
    hooks:
      pre_turn: ~
`)
    expect(config.agents.qa!.hooks.pre_turn).toBeUndefined()
  })

  it('rejects missing agents key', () => {
    expect(() =>
      loadZooidConfig(`runtime: local${HTTP_TRANSPORT}`),
    ).toThrow(/agents: is required/i)
  })

  it('rejects empty agents: map', () => {
    expect(() =>
      loadZooidConfig(`runtime: local${HTTP_TRANSPORT}\nagents: {}`),
    ).toThrow(/agents: must have at least one entry/i)
  })

  it('rejects top-level workdir (flat form removed)', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
workdir: ./
${HTTP_TRANSPORT}${QA_AGENTS}`),
    ).toThrow(/top-level workdir is not supported/i)
  })

  it('rejects bad agent names', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  Qa:
    workdir: ./qa
    acp: { preset: claude }
    http: { transport: http-local }
`),
    ).toThrow(/agents\.Qa: name must match/i)
  })
})

describe('loadZooidConfig — per-agent container block', () => {
  it('parses per-agent container.image', () => {
    const config = loadZooidConfig(`
runtime: docker
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    http: { transport: http-local }
  ship:
    workdir: ./ship
    acp: { preset: codex }
    http: { transport: http-local }
    container:
      image: ghcr.io/zooid-ai/zooid-agent-base:custom
`)
    expect(config.agents.qa!.container?.image).toBeUndefined()
    expect(config.agents.ship!.container?.image).toBe(
      'ghcr.io/zooid-ai/zooid-agent-base:custom',
    )
  })

  it('rejects agents.*.container when runtime is local', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    http: { transport: http-local }
    container:
      image: x
`),
    ).toThrow(/container.*only valid when runtime is 'docker' or 'podman'/i)
  })
})

describe('mergeCliFlags', () => {
  function baseConfig(overrides: Partial<ZooidConfig> = {}): ZooidConfig {
    return {
      runtime: 'local',
      transports: { 'http-local': { type: 'http', port: 8080 } },
      agents: {
        qa: {
          name: 'qa',
          workdir: './qa',
          hooks: {},
          acp: { preset: 'claude' },
          approval_timeout_ms: 0,
          http: { transport: 'http-local' },
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

  it('accepts --runtime docker from CLI flags (no auto-default image)', () => {
    const merged = mergeCliFlags(baseConfig(), { runtime: 'docker' })
    expect(merged.runtime).toBe('docker')
    expect(merged.container).toBeUndefined()
  })

  it('CLI --image overrides container.image', () => {
    const dockerBase = baseConfig({
      runtime: 'docker',
      container: { image: 'ghcr.io/zooid-ai/zooid-agent-base:1.0.0' },
    })
    const merged = mergeCliFlags(dockerBase, { image: 'custom:2.0' })
    expect(merged.container?.image).toBe('custom:2.0')
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

describe('loadZooidConfig (matrix transport)', () => {
  it('parses a matrix transport with a matrix: binding block', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  architect:
    workdir: ./architect
    acp:
      preset: claude
    matrix:
      transport: matrix-local
      user_id: '@architect:localhost'
      rooms:
        - '!r1:localhost'
      trigger: mention
`)
    const t = config.transports['matrix-local']!
    expect(t.type).toBe('matrix')
    if (t.type === 'matrix') {
      expect(t.homeserver).toBe('http://localhost:8448')
      expect(t.user_namespace).toBe('@.*:localhost')
    }
    expect(config.agents.architect!.matrix?.user_id).toBe('@architect:localhost')
    expect(config.agents.architect!.matrix?.rooms).toEqual(['!r1:localhost'])
    expect(config.agents.architect!.matrix?.trigger).toBe('mention')
  })

  it('defaults trigger to "mention" when omitted', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  architect:
    workdir: ./architect
    acp:
      preset: claude
    matrix:
      transport: matrix-local
      user_id: '@architect:localhost'
      rooms:
        - '!r1:localhost'
`)
    expect(config.agents.architect!.matrix?.trigger).toBe('mention')
  })

  it('rejects matrix block referencing http transport', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    matrix:
      transport: http-local
      user_id: '@qa:localhost'
      rooms: ['!r:localhost']
`),
    ).toThrow(/matrix.*references transport.*type: http/i)
  })

  it('rejects bad matrix.user_id format', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  architect:
    workdir: ./architect
    acp:
      preset: claude
    matrix:
      transport: matrix-local
      user_id: 'not-a-matrix-id'
      rooms:
        - '!r1:localhost'
`),
    ).toThrow(/matrix\.user_id must look like @localpart:server/)
  })

  it('accepts an optional display_name on a matrix binding', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      display_name: 'Docs Agent'
      rooms:
        - '!r1:localhost'
`)
    expect(config.agents.docs!.matrix?.display_name).toBe('Docs Agent')
  })

  it('trims surrounding whitespace from display_name', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      display_name: '   Docs Agent   '
      rooms:
        - '!r1:localhost'
`)
    expect(config.agents.docs!.matrix?.display_name).toBe('Docs Agent')
  })

  it('rejects empty display_name (after trim)', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      display_name: '   '
      rooms:
        - '!r1:localhost'
`),
    ).toThrow(/display_name.*non-empty/i)
  })

  it('rejects display_name longer than 256 characters', () => {
    const long = 'a'.repeat(257)
    expect(() =>
      loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      display_name: '${long}'
      rooms:
        - '!r1:localhost'
`),
    ).toThrow(/display_name.*256/)
  })

  it('rejects non-string display_name', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      display_name: 42
      rooms:
        - '!r1:localhost'
`),
    ).toThrow(/display_name.*string/i)
  })

  it('omits display_name from the parsed binding when absent', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      rooms:
        - '!r1:localhost'
`)
    expect(config.agents.docs!.matrix).toBeDefined()
    expect('display_name' in (config.agents.docs!.matrix as object)).toBe(false)
  })

  it('accepts an optional acp.model string', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    acp:
      preset: claude
      model: claude-sonnet-4-6
    matrix:
      rooms: ['#docs']
`)
    expect(config.agents.docs!.acp).toEqual({
      preset: 'claude',
      model: 'claude-sonnet-4-6',
    })
  })

  it('rejects acp.model when not a non-empty string', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    acp: { preset: claude, model: '' }
    matrix: { rooms: ['#docs'] }
`),
    ).toThrow(/acp\.model.*non-empty string/i)
  })

  it('omits model from the parsed acp block when absent', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    acp: { preset: claude }
    matrix: { rooms: ['#docs'] }
`)
    expect('model' in (config.agents.docs!.acp as object)).toBe(false)
  })
})

describe('loadZooidConfig (matrix transport — implicit server)', () => {
  it('expands @localpart user_id to fully-qualified mxid using server_name', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs'
      rooms:
        - '#welcome:localhost'
`)
    expect(config.agents.docs!.matrix?.user_id).toBe('@docs:localhost')
  })

  it('expands #alias rooms to fully-qualified aliases', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      rooms:
        - '#welcome'
        - '#docs'
`)
    expect(config.agents.docs!.matrix?.rooms).toEqual([
      '#welcome:localhost',
      '#docs:localhost',
    ])
  })

  it('expands !roomId rooms to fully-qualified room IDs', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      rooms:
        - '!abc'
`)
    expect(config.agents.docs!.matrix?.rooms).toEqual(['!abc:localhost'])
  })

  it('leaves fully-qualified user_id and rooms untouched (mixed forms in one binding)', () => {
    const config = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      rooms:
        - '#welcome'
        - '#docs:localhost'
        - '!r1:localhost'
`)
    expect(config.agents.docs!.matrix?.user_id).toBe('@docs:localhost')
    expect(config.agents.docs!.matrix?.rooms).toEqual([
      '#welcome:localhost',
      '#docs:localhost',
      '!r1:localhost',
    ])
  })

  it('rejects an invalid normalized user_id (catches bad localpart chars)', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@INVALID name'
      rooms:
        - '#welcome'
`),
    ).toThrow(/user_id must look like @localpart:server/)
  })

  it("rejects rooms[] entries that lack a leading # or !", () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./docs
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@docs:localhost'
      rooms:
        - 'welcome'
`),
    ).toThrow(/rooms\[\] must start with '#' or '!'/)
  })
})

describe('parseAgents workdir default', () => {
  it('defaults workdir to ./agents/<name> when omitted', () => {
    const cfg = loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    acp: { preset: claude }
    http:
      transport: http-local
`)
    expect(cfg.agents.qa.workdir).toBe('./agents/qa')
  })

  it('explicit workdir wins over the default', () => {
    const cfg = loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: ./custom/qa-dir
    acp: { preset: claude }
    http:
      transport: http-local
`)
    expect(cfg.agents.qa.workdir).toBe('./custom/qa-dir')
  })

  it('rejects empty-string workdir explicitly set', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: ''
    acp: { preset: claude }
    http:
      transport: http-local
`),
    ).toThrow(/agents\.qa\.workdir must be a non-empty string/)
  })

  it('rejects null workdir explicitly set', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: null
    acp: { preset: claude }
    http:
      transport: http-local
`),
    ).toThrow(/agents\.qa\.workdir must be a non-empty string/)
  })
})

describe('agent transport: inference', () => {
  it('infers transport when exactly one matrix transport exists', () => {
    const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_FULL.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      user_id: '@docs'
      rooms: ['#docs']
`)
    expect(cfg.agents.docs.matrix?.transport).toBe('matrix')
  })

  it('infers transport when exactly one http transport exists', () => {
    const cfg = loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    http: {}
`)
    expect(cfg.agents.qa.http?.transport).toBe('http-local')
  })

  it('explicit transport wins over the inferred one', () => {
    const cfg = loadZooidConfig(`
runtime: local
transports:
  primary:
    type: matrix
    homeserver: http://localhost:8448
    as_token: a
    hs_token: h
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
  secondary:
    type: matrix
    homeserver: http://localhost:8449
    as_token: a2
    hs_token: h2
    sender_localpart: zooid
    user_namespace: '@.*:other'
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      transport: secondary
      user_id: '@docs'
      rooms: ['#docs']
`)
    expect(cfg.agents.docs.matrix?.transport).toBe('secondary')
  })

  it('errors clearly when transport: omitted and multiple of the kind exist', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
transports:
  primary:
    type: matrix
    homeserver: http://localhost:8448
    as_token: a
    hs_token: h
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
  secondary:
    type: matrix
    homeserver: http://localhost:8449
    as_token: a2
    hs_token: h2
    sender_localpart: zooid
    user_namespace: '@.*:other'
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      user_id: '@docs'
      rooms: ['#docs']
`),
    ).toThrow(/agents\.docs\.matrix\.transport is required.*primary.*secondary/s)
  })

  it('errors when no transport of the kind exists at all', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      user_id: '@docs'
      rooms: ['#docs']
`),
    ).toThrow(/agents\.docs\.matrix: no transport of type matrix declared/)
  })
})

describe('agent user_id inference', () => {
  it('infers user_id as @<name>:<server_name> when omitted', () => {
    const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_FULL.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
    expect(cfg.agents.docs.matrix?.user_id).toBe('@docs:localhost')
  })

  it('short-form explicit user_id (@docs-bot) overrides and gets server appended', () => {
    const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_FULL.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      user_id: '@docs-bot'
      rooms: ['#docs']
`)
    expect(cfg.agents.docs.matrix?.user_id).toBe('@docs-bot:localhost')
  })

  it('fully-qualified explicit user_id overrides untouched', () => {
    const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_FULL.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      user_id: '@docs-bot:other.example'
      rooms: ['#docs']
`)
    expect(cfg.agents.docs.matrix?.user_id).toBe('@docs-bot:other.example')
  })
})

describe('transport type inference from key', () => {
  it('infers type: matrix when key is "matrix" and type is omitted', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-tok', MATRIX_HS_TOKEN: 'hs-tok' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_MIN.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        expect(cfg.transports.matrix.type).toBe('matrix')
      },
    )
  })

  it('infers type: http when key is "http" and type is omitted', () => {
    const cfg = loadZooidConfig(`
runtime: local
transports:
  http:
    port: 8081
agents:
  qa:
    workdir: ./qa
    acp: { preset: claude }
    http: {}
`)
    expect(cfg.transports.http).toEqual({ type: 'http', port: 8081 })
  })

  it('errors when key is unknown and type is omitted', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
transports:
  primary:
    homeserver: http://localhost:8448
${QA_AGENTS}`),
    ).toThrow(/transports\.primary\.type must be "matrix" or "http"/)
  })

  it('explicit type wins (operator names the transport "prod-matrix")', () => {
    const cfg = loadZooidConfig(`
runtime: local
transports:
  prod-matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: a
    hs_token: h
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      transport: prod-matrix
      rooms: ['#docs']
`)
    expect(cfg.transports['prod-matrix'].type).toBe('matrix')
  })
})

describe('matrix sender_localpart default', () => {
  it("defaults sender_localpart to 'zooid' when omitted", () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-tok', MATRIX_HS_TOKEN: 'hs-tok' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_MIN.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt.sender_localpart).toBe('zooid')
      },
    )
  })

  it('explicit sender_localpart wins', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-tok', MATRIX_HS_TOKEN: 'hs-tok' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
transports:
  matrix:
    homeserver: http://localhost:8448
    sender_localpart: appservice
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt.sender_localpart).toBe('appservice')
      },
    )
  })

  it('rejects explicit empty-string sender_localpart', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
transports:
  matrix:
    homeserver: http://localhost:8448
    sender_localpart: ''
${QA_AGENTS}`),
    ).toThrow(/transports\.matrix\.sender_localpart must be a non-empty string/)
  })
})

describe('matrix user_namespace derivation', () => {
  it('derives user_namespace from homeserver hostname', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-tok', MATRIX_HS_TOKEN: 'hs-tok' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
transports:
  matrix:
    homeserver: http://localhost:8448
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt.user_namespace).toBe('@.*:localhost')
      },
    )
  })

  it('derives user_namespace from a non-localhost homeserver', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-tok', MATRIX_HS_TOKEN: 'hs-tok' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
transports:
  matrix:
    homeserver: https://home.zoon.eco
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt.user_namespace).toBe('@.*:home.zoon.eco')
      },
    )
  })

  it('explicit user_namespace wins', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-tok', MATRIX_HS_TOKEN: 'hs-tok' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
transports:
  matrix:
    homeserver: http://localhost:8448
    user_namespace: '@docs-.*:localhost'
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt.user_namespace).toBe('@docs-.*:localhost')
      },
    )
  })
})

describe('matrix token env-var defaults', () => {
  it('fills as_token / hs_token from MATRIX_AS_TOKEN / MATRIX_HS_TOKEN when one matrix transport', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-from-env', MATRIX_HS_TOKEN: 'hs-from-env' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_MIN.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt.as_token).toBe('as-from-env')
        expect(mt.hs_token).toBe('hs-from-env')
      },
    )
  })

  it('explicit as_token / hs_token wins over env-var defaults', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'env-as', MATRIX_HS_TOKEN: 'env-hs' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local
transports:
  matrix:
    homeserver: http://localhost:8448
    as_token: explicit-as
    hs_token: explicit-hs
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt.as_token).toBe('explicit-as')
        expect(mt.hs_token).toBe('explicit-hs')
      },
    )
  })

  it('clear error when env var is unset and token was inferred', () => {
    withEnv({ MATRIX_AS_TOKEN: undefined, MATRIX_HS_TOKEN: undefined }, () => {
      expect(() =>
        loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_MIN.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      rooms: ['#docs']
`),
      ).toThrow(/MATRIX_AS_TOKEN/)
    })
  })

  it('errors when multiple matrix transports and tokens are omitted', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as', MATRIX_HS_TOKEN: 'hs' },
      () => {
        expect(() =>
          loadZooidConfig(`
runtime: local
transports:
  matrix:
    homeserver: http://localhost:8448
  matrix-staging:
    type: matrix
    homeserver: http://localhost:8449
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: claude }
    matrix:
      transport: matrix
      rooms: ['#docs']
`),
        ).toThrow(/explicitly.*more than one matrix transport/s)
      },
    )
  })
})

describe('canonical zooid.yaml example (§3.6)', () => {
  it('parses the minimal localhost-dev workforce', () => {
    withEnv(
      { MATRIX_AS_TOKEN: 'as-tok', MATRIX_HS_TOKEN: 'hs-tok' },
      () => {
        const cfg = loadZooidConfig(`
runtime: local

transports:
  matrix:
    homeserver: http://localhost:8448

agents:
  echo:
    acp:
      command: node
      args: ['--import', 'tsx', './echo-agent.ts']
    matrix:
      rooms: ['#welcome']

  docs:
    acp: { preset: opencode }
    matrix:
      display_name: 'Docs Agent'
      rooms: ['#docs']

  ux-consultant:
    acp: { preset: opencode }
    matrix:
      rooms: ['#ux-consultant']
`)
        const mt = cfg.transports.matrix
        if (mt.type !== 'matrix') throw new Error('not matrix')
        expect(mt).toMatchObject({
          type: 'matrix',
          homeserver: 'http://localhost:8448',
          as_token: 'as-tok',
          hs_token: 'hs-tok',
          sender_localpart: 'zooid',
          user_namespace: '@.*:localhost',
        })
        expect(cfg.agents.echo.workdir).toBe('./agents/echo')
        expect(cfg.agents.echo.matrix?.transport).toBe('matrix')
        expect(cfg.agents.echo.matrix?.user_id).toBe('@echo:localhost')
        expect(cfg.agents.echo.matrix?.rooms).toEqual(['#welcome:localhost'])

        expect(cfg.agents.docs.workdir).toBe('./agents/docs')
        expect(cfg.agents.docs.matrix?.user_id).toBe('@docs:localhost')
        expect(cfg.agents.docs.matrix?.display_name).toBe('Docs Agent')

        expect(cfg.agents['ux-consultant'].workdir).toBe('./agents/ux-consultant')
        expect(cfg.agents['ux-consultant'].matrix?.user_id).toBe(
          '@ux-consultant:localhost',
        )
      },
    )
  })
})

describe('backwards compat: long-form yaml continues to parse', () => {
  it('parses a fully-explicit zooid.yaml unchanged', () => {
    const cfg = loadZooidConfig(`
runtime: local
${MATRIX_TRANSPORT_FULL.trimStart()}
agents:
  docs:
    workdir: ./agents/docs
    acp: { preset: opencode }
    matrix:
      transport: matrix
      user_id: '@docs-agent'
      rooms: ['#docs']
      trigger: mention
`)
    expect(cfg.agents.docs.workdir).toBe('./agents/docs')
    expect(cfg.agents.docs.matrix?.transport).toBe('matrix')
    expect(cfg.agents.docs.matrix?.user_id).toBe('@docs-agent:localhost')
  })
})
