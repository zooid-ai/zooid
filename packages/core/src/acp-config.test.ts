import { describe, it, expect } from 'vitest'
import { loadZooidConfig } from './config.js'

const baseYaml = `
runtime: local
transports:
  http-local:
    type: http
    port: 8080
agents:
`.trimStart()

describe('agents.<name>.acp', () => {
  it('parses preset form', () => {
    const cfg = loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp:
      preset: claude
`)
    expect(cfg.agents.triage!.acp).toEqual({ preset: 'claude' })
  })

  it('parses explicit form, defaulting args to []', () => {
    const cfg = loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp:
      command: opencode
`)
    expect(cfg.agents.triage!.acp).toEqual({ command: 'opencode', args: [] })
  })

  it('parses explicit form with args', () => {
    const cfg = loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp:
      command: opencode
      args: [acp, --flag]
`)
    expect(cfg.agents.triage!.acp).toEqual({
      command: 'opencode',
      args: ['acp', '--flag'],
    })
  })

  it('rejects both preset and command together', () => {
    expect(() =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp:
      preset: claude
      command: overridden
`),
    ).toThrow(/agents\.triage\.acp:.*either.*preset.*or.*command/i)
  })

  it('rejects empty acp block', () => {
    expect(() =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp: {}
`),
    ).toThrow(/agents\.triage\.acp:.*preset.*or.*command/i)
  })

  it('rejects unknown preset', () => {
    expect(() =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp:
      preset: made-up
`),
    ).toThrow(/agents\.triage\.acp\.preset.*made-up/i)
  })

  it('requires acp on every agent (no implicit default adapter)', () => {
    expect(() =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
`),
    ).toThrow(/agents\.triage:.*acp/i)
  })
})

describe('agents.<name>.approval_timeout', () => {
  it('defaults to 0 (no timeout) when unset', () => {
    const cfg = loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp: { preset: claude }
`)
    expect(cfg.agents.triage!.approval_timeout_ms).toBe(0)
  })

  it('parses h/m/s suffix duration strings', () => {
    const mk = (v: string) =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp: { preset: claude }
    approval_timeout: ${v}
`).agents.triage!.approval_timeout_ms

    expect(mk('30s')).toBe(30_000)
    expect(mk('15m')).toBe(15 * 60_000)
    expect(mk('2h')).toBe(2 * 60 * 60_000)
    expect(mk('24h')).toBe(24 * 60 * 60_000)
  })

  it('accepts 0 as "no timeout"', () => {
    const cfg = loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp: { preset: claude }
    approval_timeout: 0
`)
    expect(cfg.agents.triage!.approval_timeout_ms).toBe(0)
  })

  it('rejects malformed durations with a clear error', () => {
    expect(() =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    acp: { preset: claude }
    approval_timeout: forever
`),
    ).toThrow(/agents\.triage\.approval_timeout/i)
  })
})

describe('legacy adapter: is rejected', () => {
  it('rejects zooid.yaml that uses adapter:', () => {
    expect(() =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    adapter: claude
    acp:
      preset: claude
`),
    ).toThrow(/agents\.triage:.*adapter.*no longer supported.*acp/i)
  })

  it('rejects the object form too', () => {
    expect(() =>
      loadZooidConfig(`${baseYaml}  triage:
    http: { transport: http-local }
    workdir: .
    adapter: { type: claude }
    acp:
      preset: claude
`),
    ).toThrow(/agents\.triage:.*adapter.*no longer supported.*acp/i)
  })
})
