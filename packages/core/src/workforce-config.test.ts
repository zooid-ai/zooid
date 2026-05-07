import { describe, expect, it } from 'vitest'
import { loadWorkforceConfig } from './config.js'

const minimal = `
runtime: docker

transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'

agents:
  assistant:
    workdir: .
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@assistant:localhost'
      rooms: ['!general:localhost']
      trigger: mention
`

describe('loadWorkforceConfig — new shape', () => {
  it('parses a single-matrix-transport workforce', () => {
    const c = loadWorkforceConfig(minimal)
    expect(c.transports['matrix-local']).toMatchObject({
      type: 'matrix',
      homeserver: 'http://localhost:8448',
      as_token: 'as-x',
      hs_token: 'hs-x',
      sender_localpart: 'zooid',
      user_namespace: '@.*:localhost',
    })
    expect(c.agents.assistant!.matrix?.transport).toBe('matrix-local')
    expect(c.agents.assistant!.matrix?.user_id).toBe('@assistant:localhost')
  })

  it('runtime defaults to docker when omitted', () => {
    const yaml = `
transports:
  http-only:
    type: http
    port: 8080
agents:
  one:
    workdir: .
    acp: { preset: claude }
    http:
      transport: http-only
`
    expect(loadWorkforceConfig(yaml).runtime).toBe('docker')
  })

  it('errors when transports is empty', () => {
    expect(() =>
      loadWorkforceConfig(`
transports: {}
agents:
  a:
    workdir: .
    acp: { preset: claude }
    http:
      transport: x
`),
    ).toThrow(/transports.*at least one/i)
  })

  it("errors when an agent's transport reference doesn't exist", () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
agents:
  oops:
    workdir: .
    acp: { preset: claude }
    matrix:
      transport: ghost
      user_id: '@oops:localhost'
      rooms: ['!r:localhost']
`),
    ).toThrow(/agents\.oops\.matrix\.transport.*ghost.*not declared/i)
  })

  it('errors when a transport has an unknown type', () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  bad:
    type: smtp
agents:
  a:
    workdir: .
    acp: { preset: claude }
    http:
      transport: bad
`),
    ).toThrow(/transports\.bad\.type.*matrix.*http/i)
  })

  it('errors when a matrix-typed transport is referenced from an http: block', () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  m:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    sender_localpart: z
    user_namespace: '@.*:l'
agents:
  one:
    workdir: .
    acp: { preset: claude }
    http:
      transport: m
`),
    ).toThrow(/http.*references transport.*type: matrix/i)
  })

  it('errors when a matrix block omits user_id', () => {
    expect(() =>
      loadWorkforceConfig(`
transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
agents:
  oops:
    workdir: .
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      rooms: ['!r:localhost']
`),
    ).toThrow(/agents\.oops\.matrix\.user_id.*@localpart:server/i)
  })

  it('allows multiple transports of mixed types', () => {
    const yaml = `
transports:
  matrix-local:
    type: matrix
    homeserver: http://localhost:8448
    as_token: as-x
    hs_token: hs-x
    sender_localpart: zooid
    user_namespace: '@.*:localhost'
  http-direct:
    type: http
    port: 8080
agents:
  m:
    workdir: .
    acp: { preset: claude }
    matrix:
      transport: matrix-local
      user_id: '@m:localhost'
      rooms: ['!a:localhost']
  h:
    workdir: .
    acp: { preset: claude }
    http:
      transport: http-direct
`
    const c = loadWorkforceConfig(yaml)
    expect(Object.keys(c.transports)).toEqual(['matrix-local', 'http-direct'])
    expect(c.agents.m!.matrix?.transport).toBe('matrix-local')
    expect(c.agents.h!.http?.transport).toBe('http-direct')
  })
})
