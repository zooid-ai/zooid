import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  buildContextServerSpec,
  contextContainerMounts,
  CONTEXT_CONTAINER_BIN,
  CONTEXT_CONTAINER_BIN_DIR,
  CONTEXT_CONTAINER_SOCK,
} from './factory.js'

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

describe('buildContextServerSpec — containerize', () => {
  it('emits an in-container command/paths when containerize is set', () => {
    const spec = buildContextServerSpec({
      spawnId: 'sid-1',
      // host paths are irrelevant to the emitted command in container mode;
      // they only feed the bind-mounts (see contextContainerMounts).
      sockPath: '/home/ubuntu/hq/data/run/context.sock',
      binPath: '/usr/lib/node_modules/zooid/node_modules/@zooid/context-mcp/dist/bin.js',
      containerize: true,
    })
    expect(spec.name).toBe('zooid-context')
    // bare `node`, resolved via the agent image PATH — NOT the host execPath.
    expect(spec.command).toBe('node')
    expect(spec.args[0]).toBe(CONTEXT_CONTAINER_BIN) // '/zooid/context-mcp/bin.js'
    expect(spec.args).toContain('--spawn-id')
    expect(spec.args).toContain('sid-1')
    // env points at the container-side socket target, not the host path.
    expect(spec.env).toEqual([{ name: 'ZOOID_DAEMON_SOCK', value: CONTEXT_CONTAINER_SOCK }])
  })

  it('leaves the host-runtime spec unchanged when containerize is absent', () => {
    const spec = buildContextServerSpec({
      spawnId: 'sid-2',
      sockPath: '/run/zooid/daemon.sock',
      binPath: '/host/bin.js',
    })
    expect(spec.command).toBe(process.execPath)
    expect(spec.args[0]).toBe('/host/bin.js')
    expect(spec.env).toEqual([{ name: 'ZOOID_DAEMON_SOCK', value: '/run/zooid/daemon.sock' }])
  })
})

describe('contextContainerMounts', () => {
  it('returns the bin dir (ro) and the socket (rw) with container targets', () => {
    const mounts = contextContainerMounts({
      sockPath: '/home/ubuntu/hq/data/run/context.sock',
      binPath: '/opt/zooid/context-mcp/dist/bin.js',
    })
    expect(mounts).toEqual([
      { path: '/opt/zooid/context-mcp/dist', target: CONTEXT_CONTAINER_BIN_DIR, mode: 'ro' },
      { path: '/home/ubuntu/hq/data/run/context.sock', target: CONTEXT_CONTAINER_SOCK, mode: 'rw' },
    ])
  })

  it('defaults the bin dir to the resolved package dist on disk', () => {
    const mounts = contextContainerMounts({ sockPath: '/tmp/x.sock' })
    const binMount = mounts.find((m) => m.target === CONTEXT_CONTAINER_BIN_DIR)!
    expect(binMount.path).toMatch(/context-mcp[/\\]dist$/)
    expect(existsSync(binMount.path)).toBe(true)
    // the mounted dir must actually contain the bin we reference in-container.
    expect(existsSync(`${binMount.path}/bin.js`)).toBe(true)
    expect(dirname(`${binMount.path}/bin.js`)).toBe(binMount.path)
  })
})
