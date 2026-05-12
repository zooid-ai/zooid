import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
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

  it('resolves the default bin via Node module resolution to a real path on disk', () => {
    // Pinned regression: tsup bundles this file into the CLI chunk, so the
    // earlier `import.meta.url`-based default broke at runtime (it resolved
    // to `<cli-dist>/bin.js`, not this package's dist). `createRequire` must
    // walk node_modules and return an actual file path.
    const spec = buildContextServerSpec({
      spawnId: 'sid',
      sockPath: '/tmp/x.sock',
    })
    expect(spec.args[0]).toMatch(/context-mcp[/\\]dist[/\\]bin\.js$/)
    expect(existsSync(spec.args[0])).toBe(true)
  })
})
