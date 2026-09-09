import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

const head = `
runtime: local
transports:
  matrix:
    type: matrix
    homeserver: http://localhost:8448
    as_token: t
    hs_token: h
    user_namespace: '@.*:example.org'
agents:
  product:
    acp: { preset: opencode }
    matrix:
      rooms: ["#product:example.org"]
  architect:
    acp: { preset: opencode }
    matrix:
      rooms: ["#dev:example.org"]
`

const flat = `${head}
triggers:
  triage:
    webhook:
      provider: github
      secret: "s"
    as: "@hook:example.org"
    room: "#product:example.org"
    mention: product
    match: 'event == "issues" && body.action == "opened"'
    text: 'Triage \${body.repository.full_name}#\${body.issue.number}.'
`

const plural = `${head}
triggers:
  github:
    webhook:
      provider: github
      secret: "s"
    as: "@hook:example.org"
    messages:
      - room: "#product:example.org"
        mention: product
        match: 'event == "issues" && body.action == "opened"'
        text: 'Triage it.'
      - room: "#dev:example.org"
        mention: architect
        match: 'event == "pull_request" && body.action == "closed"'
        text: 'Reconcile it.'
`

describe('flat form', () => {
  it('desugars into a single-entry messages list', () => {
    const t = loadZooidConfig(flat).triggers.triage
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0].room).toBe('#product:example.org')
    expect(t.messages[0].mention).toBe('product')
    expect(t.messages[0].match).toBe('event == "issues" && body.action == "opened"')
  })

  // Nothing downstream may branch on which spelling was used.
  it('leaves no flat room/mention/text on the parsed trigger', () => {
    const t = loadZooidConfig(flat).triggers.triage as Record<string, unknown>
    expect(t.room).toBeUndefined()
    expect(t.mention).toBeUndefined()
    expect(t.text).toBeUndefined()
  })
})

describe('messages form', () => {
  it('parses several messages', () => {
    const t = loadZooidConfig(plural).triggers.github
    expect(t.messages.map((m) => m.mention)).toEqual(['product', 'architect'])
  })

  it('exposes every declared room, so the bot pool can join them at start', () => {
    const t = loadZooidConfig(plural).triggers.github
    expect(t.messages.map((m) => m.room)).toEqual(['#product:example.org', '#dev:example.org'])
  })

  it('validates each message the same way the flat form is validated', () => {
    expect(() => loadZooidConfig(plural.replace('mention: architect', 'mention: nobody'))).toThrow(
      /triggers\.github\.messages\[1\]\.mention: unknown agent "nobody"/,
    )
  })

  it('rejects an empty messages list', () => {
    expect(() => loadZooidConfig(`${head}
triggers:
  github:
    webhook: { provider: github, secret: "s" }
    as: "@hook:example.org"
    messages: []
`)).toThrow(/triggers\.github\.messages: must not be empty/)
  })
})

describe('mutual exclusion and validation', () => {
  it('rejects flat keys together with messages, rather than picking one silently', () => {
    expect(() => loadZooidConfig(plural.replace('    messages:', '    room: "#product:example.org"\n    messages:'))).toThrow(
      /triggers\.github: specify either room:\/mention:\/text: or messages:, not both/,
    )
  })

  it('rejects match: on a schedule trigger — there is no payload to evaluate', () => {
    expect(() => loadZooidConfig(`${head}
triggers:
  weekly:
    schedule: "0 6 * * 1"
    as: "@cron:example.org"
    room: "#dev:example.org"
    mention: architect
    match: 'true'
    text: 'go'
`)).toThrow(/triggers\.weekly\.match: only applies to a webhook: trigger/)
  })

  it('allows messages: on a schedule trigger — one cron, several agents', () => {
    const cfg = loadZooidConfig(`${head}
triggers:
  weekly:
    schedule: "0 6 * * 1"
    as: "@cron:example.org"
    messages:
      - { room: "#product:example.org", mention: product, text: 'a' }
      - { room: "#dev:example.org", mention: architect, text: 'b' }
`)
    expect(cfg.triggers.weekly.messages).toHaveLength(2)
  })

  // A typo must fail the daemon at boot, not silently never match.
  it('rejects a malformed match expression at config load', () => {
    expect(() => loadZooidConfig(flat.replace("match: 'event == \"issues\" && body.action == \"opened\"'", "match: 'body.action =='"))).toThrow(
      /triggers\.triage\.messages\[0\]\.match: /,
    )
  })

  it('no longer accepts event:', () => {
    expect(() => loadZooidConfig(flat.replace('      secret: "s"', '      event: issues\n      secret: "s"'))).toThrow(
      /triggers\.triage\.webhook\.event: no longer supported — use match:/,
    )
  })
})
