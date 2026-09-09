import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

const base = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
agents:
  architect:
    acp: { preset: opencode }
    matrix:
      rooms: ["#ops:example.org"]
`

const baseTwoAgents = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
agents:
  architect:
    acp: { preset: opencode }
    matrix:
      rooms: ["#ops:example.org"]
  product-manager:
    acp: { preset: opencode }
    matrix:
      rooms: ["#ops:example.org"]
`

const baseWithHttpAgent = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
  http-local:
    type: http
    port: 8080
agents:
  architect:
    acp: { preset: opencode }
    matrix:
      rooms: ["#ops:example.org"]
  worker:
    acp: { preset: opencode }
    http: {}
`

const withTriggers = (block: string) => `${base}\ntriggers:\n${block}`

const ok = `
  image-currency:
    schedule: "0 6 * * 1"
    as: "@cron:example.org"
    room: "#ops:example.org"
    mention: architect
    text: "Check the pinned agent CLI versions."
`

describe('triggers: config', () => {
  it('is optional — a config with no triggers loads and yields an empty map', () => {
    expect(loadZooidConfig(base).triggers).toEqual({})
  })

  it('parses a schedule trigger', () => {
    const t = loadZooidConfig(withTriggers(ok)).triggers['image-currency']
    expect(t).toEqual({
      schedule: '0 6 * * 1',
      as: '@cron:example.org',
      messages: [
        { room: '#ops:example.org', mention: 'architect', text: 'Check the pinned agent CLI versions.' },
      ],
    })
  })

  it('accepts a room id as well as an alias', () => {
    const cfg = loadZooidConfig(withTriggers(ok.replace('"#ops:example.org"', '"!abc:example.org"')))
    expect(cfg.triggers['image-currency'].messages[0].room).toBe('!abc:example.org')
  })

  it('rejects run: — the emitter tier was dropped, and a stale config must fail loudly', () => {
    expect(() =>
      loadZooidConfig(withTriggers(`${ok}    run: "echo hi"\n`)),
    ).toThrow(/triggers\.image-currency\.run: is not supported/)
  })

  it('rejects a mention that names no configured agent', () => {
    expect(() =>
      loadZooidConfig(withTriggers(ok.replace('mention: architect', 'mention: nobody'))),
    ).toThrow(/triggers\.image-currency\.messages\[0\]\.mention: unknown agent "nobody"/)
  })

  it('rejects an invalid cron expression at load time, not at first fire', () => {
    expect(() =>
      loadZooidConfig(withTriggers(ok.replace('"0 6 * * 1"', '"not a cron"'))),
    ).toThrow(/triggers\.image-currency\.schedule/)
  })

  it('expands a bare localpart in as: to a full MXID via the sole matrix transport', () => {
    const cfg = loadZooidConfig(withTriggers(ok.replace('"@cron:example.org"', '"cron"')))
    expect(cfg.triggers['image-currency'].as).toBe('@cron:example.org')
  })

  it('expands a short-form @localpart in as: the same way', () => {
    const cfg = loadZooidConfig(withTriggers(ok.replace('"@cron:example.org"', '"@cron"')))
    expect(cfg.triggers['image-currency'].as).toBe('@cron:example.org')
  })

  it('rejects an as: with invalid localpart characters', () => {
    expect(() =>
      loadZooidConfig(withTriggers(ok.replace('"@cron:example.org"', '"Not Valid!"'))),
    ).toThrow(/triggers\.image-currency\.as: must be a full MXID/)
  })

  it("rejects an as: that resolves to the mentioned agent's own MXID — a self-post never routes back", () => {
    const block = ok.replace('"@cron:example.org"', '"architect"')
    expect(() => loadZooidConfig(withTriggers(block))).toThrow(
      /triggers\.image-currency\.as: must not equal the mentioned agent/,
    )
  })

  it("allows as: to impersonate a different agent's own identity — cron-as-a-role", () => {
    const block = ok.replace('"@cron:example.org"', '"product-manager"')
    const cfg = loadZooidConfig(`${baseTwoAgents}\ntriggers:\n${block}`)
    expect(cfg.triggers['image-currency'].as).toBe('@product-manager:example.org')
  })

  it('rejects mention: of an agent with no matrix: binding', () => {
    const block = ok.replace('mention: architect', 'mention: worker')
    expect(() => loadZooidConfig(`${baseWithHttpAgent}\ntriggers:\n${block}`)).toThrow(
      /triggers\.image-currency\.messages\[0\]\.mention: agent "worker" has no matrix: binding/,
    )
  })

  it('requires as, room, mention and text', () => {
    const indexed = new Set(['room', 'mention', 'text'])
    for (const field of ['as', 'room', 'mention', 'text']) {
      const block = ok
        .split('\n')
        .filter((l) => !l.trim().startsWith(`${field}:`))
        .join('\n')
      const label = indexed.has(field)
        ? `triggers\\.image-currency\\.messages\\[0\\]\\.${field}`
        : `triggers\\.image-currency\\.${field}`
      expect(() => loadZooidConfig(withTriggers(block))).toThrow(new RegExp(label))
    }
  })

  it('rejects a trigger with no schedule', () => {
    const block = ok.split('\n').filter((l) => !l.trim().startsWith('schedule:')).join('\n')
    expect(() => loadZooidConfig(withTriggers(block))).toThrow(
      /triggers\.image-currency: must specify schedule:/,
    )
  })
})
