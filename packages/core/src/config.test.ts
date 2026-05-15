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

  it('rejects agents entry missing workdir', () => {
    expect(() =>
      loadZooidConfig(`
runtime: local
${HTTP_TRANSPORT.trimStart()}
agents:
  qa:
    acp: { preset: claude }
    http: { transport: http-local }
`),
    ).toThrow(/agents\.qa\.workdir is required/i)
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
