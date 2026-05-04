import { describe, it, expect } from 'vitest'
import { loadConfig } from './config.js'

const baseYaml = `
transport: http
port: 8080
runtime: local
agents:
`.trimStart()

describe('agents.<name>.acp', () => {
  it('parses preset form', () => {
    const cfg = loadConfig(`${baseYaml}  triage:
    workdir: .
    acp:
      preset: claude
`)
    expect(cfg.agents.triage.acp).toEqual({ preset: 'claude' })
  })

  it('parses explicit form, defaulting args to []', () => {
    const cfg = loadConfig(`${baseYaml}  triage:
    workdir: .
    acp:
      command: opencode
`)
    expect(cfg.agents.triage.acp).toEqual({ command: 'opencode', args: [] })
  })

  it('parses explicit form with args', () => {
    const cfg = loadConfig(`${baseYaml}  triage:
    workdir: .
    acp:
      command: opencode
      args: [acp, --flag]
`)
    expect(cfg.agents.triage.acp).toEqual({
      command: 'opencode',
      args: ['acp', '--flag'],
    })
  })

  it('rejects both preset and command together', () => {
    expect(() =>
      loadConfig(`${baseYaml}  triage:
    workdir: .
    acp:
      preset: claude
      command: overridden
`),
    ).toThrow(/agents\.triage\.acp:.*either.*preset.*or.*command/i)
  })

  it('rejects empty acp block', () => {
    expect(() =>
      loadConfig(`${baseYaml}  triage:
    workdir: .
    acp: {}
`),
    ).toThrow(/agents\.triage\.acp:.*preset.*or.*command/i)
  })

  it('rejects unknown preset', () => {
    expect(() =>
      loadConfig(`${baseYaml}  triage:
    workdir: .
    acp:
      preset: made-up
`),
    ).toThrow(/agents\.triage\.acp\.preset.*made-up/i)
  })

  it('requires acp on every agent (no implicit default adapter)', () => {
    expect(() =>
      loadConfig(`${baseYaml}  triage:
    workdir: .
`),
    ).toThrow(/agents\.triage:.*acp/i)
  })
})

describe('legacy adapter: is rejected', () => {
  it('rejects daemon.yaml that uses adapter:', () => {
    expect(() =>
      loadConfig(`${baseYaml}  triage:
    workdir: .
    adapter: claude
    acp:
      preset: claude
`),
    ).toThrow(/agents\.triage:.*adapter.*no longer supported.*acp/i)
  })

  it('rejects the object form too', () => {
    expect(() =>
      loadConfig(`${baseYaml}  triage:
    workdir: .
    adapter: { type: claude }
    acp:
      preset: claude
`),
    ).toThrow(/agents\.triage:.*adapter.*no longer supported.*acp/i)
  })
})
