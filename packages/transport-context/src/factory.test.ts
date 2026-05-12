import { describe, it, expect } from 'vitest'
import { buildContextServerSpec } from './factory.js'

describe('buildContextServerSpec', () => {
  it('produces the ACP mcpServers entry the daemon passes to session/new', () => {
    const spec = buildContextServerSpec({
      spawnId: '11111111-1111-4111-8111-111111111111',
      sockPath: '/run/zooid/abc.sock',
      binPath: '/usr/local/lib/zooid/zooid-context-mcp.js',
    })
    expect(spec.name).toBe('zooid-context')
    expect(spec.command).toBe(process.execPath)
    expect(spec.args[0]).toBe('/usr/local/lib/zooid/zooid-context-mcp.js')
    expect(spec.args).toContain('--spawn-id')
    expect(spec.args).toContain('11111111-1111-4111-8111-111111111111')
    expect(spec.env).toEqual([{ name: 'ZOOID_DAEMON_SOCK', value: '/run/zooid/abc.sock' }])
  })
})
