import { describe, expect, it } from 'vitest'
import { loadZooidConfig } from './config.js'

function config(extra = '') {
  return loadZooidConfig(
    'runtime: local\n' +
      'transports:\n  local:\n    type: http\n    port: 8080\n' +
      'agents:\n  architect:\n    workdir: .\n' +
      '    acp: { preset: claude }\n    http: { transport: local }\n' +
      extra,
  )
}

describe('session_idle_timeout', () => {
  it('defaults to ten minutes per agent', () => {
    expect(config().agents.architect!.session_idle_timeout_ms).toBe(600_000)
  })

  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['0', 0],
  ])('parses %s', (raw, expected) => {
    expect(config('    session_idle_timeout: ' + raw + '\n').agents.architect!.session_idle_timeout_ms).toBe(expected)
  })

  it.each(['-1m', 'forever', '1d', '1.5m'])('rejects %s with an agent-scoped error', (raw) => {
    expect(() => config('    session_idle_timeout: ' + raw + '\n')).toThrow(
      /agents\.architect\.session_idle_timeout/,
    )
  })
})
