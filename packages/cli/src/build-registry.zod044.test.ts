import { describe, it, expect } from 'vitest'
import { buildAcpRegistry } from './build-registry.js'
import type { ZooidConfig } from '@zooid/core'

const baseTransports = {
  m1: {
    type: 'matrix' as const,
    homeserver: 'http://localhost:8448',
    as_token: 't',
    hs_token: 'h',
    sender_localpart: 'z',
    user_namespace: '@.*:localhost',
  },
}

function mkCfg(over: Partial<ZooidConfig['agents']['alice']> = {}): ZooidConfig {
  return {
    runtime: 'docker',
    transports: baseTransports,
    agents: {
      alice: {
        name: 'alice',
        workdir: './agents/alice',
        hooks: {},
        acp: { preset: 'claude' },
        approval_timeout_ms: 0,
        matrix: {
          transport: 'm1',
          user_id: '@alice:localhost',
          rooms: [{ alias: '!r:localhost' }],
          trigger: 'mention',
        },
        ...over,
      },
    },
    hooks: {},
  } as ZooidConfig
}

describe('buildAcpRegistry — mounts (ZOD044)', () => {
  it('auto-injects the workspace mount with id "workspace"', () => {
    const cfg = mkCfg()
    const reg = buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      daemonHome: '/home/zooid',
    })
    const mounts = reg.resolveSpawnMounts('alice')
    const ws = mounts.find((m) => m.target === '/workspace')
    expect(ws).toMatchObject({
      path: '/example/agents/alice',
      target: '/workspace',
      mode: 'rw',
    })
  })

  it('overrides cwd to /workspace when workspace mount is active', () => {
    const cfg = mkCfg()
    const reg = buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      daemonHome: '/home/zooid',
    })
    expect(reg.resolveSpawnCwd('alice')).toBe('/workspace')
  })

  it('disable_mounts: [workspace] skips auto-mount and passes workdir through to cwd', () => {
    const cfg = mkCfg({
      workdir: '/baked/workspace',
      container: { disable_mounts: ['workspace'] },
    })
    const reg = buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      daemonHome: '/home/zooid',
    })
    const mounts = reg.resolveSpawnMounts('alice')
    expect(mounts.find((m) => m.target === '/workspace')).toBeUndefined()
    expect(reg.resolveSpawnCwd('alice')).toBe('/baked/workspace')
  })

  it('layers preset mounts after workspace, filtered by disable_mounts', () => {
    const cfg = mkCfg({ container: { disable_mounts: ['home'] } })
    const reg = buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      daemonHome: '/home/zooid',
    })
    const mounts = reg.resolveSpawnMounts('alice')
    // claude declares one `home` mount; with home disabled, only workspace remains.
    const targets = mounts.map((m) => m.target)
    expect(targets).toContain('/workspace')
    expect(targets).not.toContain('/root/.claude')
  })

  it('preset `home` mount points at the daemon user host home, not <dataDir>/agents/<name>', () => {
    const cfg = mkCfg()
    const reg = buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      daemonHome: '/home/zooid',
    })
    const mounts = reg.resolveSpawnMounts('alice')
    const home = mounts.find((m) => m.target === '/root/.claude')
    expect(home).toBeDefined()
    expect(home!.path).toBe('/home/zooid/.claude')
    expect(home!.path).not.toContain('/data/agents/alice')
  })

  it('user-declared mounts append after preset mounts', () => {
    const cfg = mkCfg({
      container: {
        mounts: [{ host: '/srv/shared', target: '/shared', mode: 'rw' }],
      },
    })
    const reg = buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      daemonHome: '/home/zooid',
    })
    const mounts = reg.resolveSpawnMounts('alice')
    expect(mounts[mounts.length - 1]).toMatchObject({
      path: '/srv/shared',
      target: '/shared',
    })
  })

  it('throws on unknown disable_mounts id', () => {
    const cfg = mkCfg({ container: { disable_mounts: ['nope'] } })
    expect(() =>
      buildAcpRegistry(cfg, {
        configDir: '/example',
        dataDir: '/data',
        daemonHome: '/home/zooid',
      }),
    ).toThrow(/disable_mounts.*unknown id.*"nope"/i)
  })

  it('runtime: local — no mounts emitted, cwd is workdir verbatim', () => {
    const cfg = mkCfg()
    cfg.runtime = 'local'
    const reg = buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      daemonHome: '/home/zooid',
    })
    expect(reg.resolveSpawnMounts('alice')).toEqual([])
    expect(reg.resolveSpawnCwd('alice')).toBe('./agents/alice')
  })
})

describe('buildAcpRegistry — image resolution (ZOD044)', () => {
  it('uses agent.container.image when set (highest precedence)', () => {
    const cfg = mkCfg({ container: { image: 'agent-img:v1' } })
    cfg.container = { image: 'workforce-img:v1' }
    const reg = buildAcpRegistry(cfg, { configDir: '/example', dataDir: '/data' })
    expect(reg.resolveSpawnImage('alice')).toBe('agent-img:v1')
  })

  it('falls back to workforce-level container.image', () => {
    const cfg = mkCfg()
    cfg.container = { image: 'workforce-img:v1' }
    const reg = buildAcpRegistry(cfg, { configDir: '/example', dataDir: '/data' })
    expect(reg.resolveSpawnImage('alice')).toBe('workforce-img:v1')
  })

  it('falls back to preset.image (claude → ghcr default)', () => {
    const cfg = mkCfg() // preset: claude, no container.image anywhere
    const reg = buildAcpRegistry(cfg, { configDir: '/example', dataDir: '/data' })
    expect(reg.resolveSpawnImage('alice')).toBe('ghcr.io/zooid-ai/agent-claude-code:latest')
  })

  it('runtime: docker — throws when an agent has no resolvable image (preset has none)', () => {
    const cfg = mkCfg({ acp: { preset: 'cline' } })
    expect(() =>
      buildAcpRegistry(cfg, { configDir: '/example', dataDir: '/data' }),
    ).toThrow(/runtime: docker requires a container image[\s\S]*alice[\s\S]*cline/i)
  })

  it('runtime: podman — same startup error', () => {
    const cfg = mkCfg({ acp: { preset: 'gemini' } })
    cfg.runtime = 'podman'
    expect(() =>
      buildAcpRegistry(cfg, { configDir: '/example', dataDir: '/data' }),
    ).toThrow(/runtime: podman requires a container image/i)
  })

  it('runtime: local — never errors on missing image (image is unused)', () => {
    const cfg = mkCfg({ acp: { preset: 'cline' } })
    cfg.runtime = 'local'
    expect(() =>
      buildAcpRegistry(cfg, { configDir: '/example', dataDir: '/data' }),
    ).not.toThrow()
  })

  it('lists every unresolved agent in a single error', () => {
    const base = mkCfg()
    const cfg: ZooidConfig = {
      runtime: 'podman',
      transports: baseTransports,
      agents: {
        alice: { ...base.agents.alice!, acp: { preset: 'cline' } },
        bob: {
          ...base.agents.alice!,
          name: 'bob',
          acp: { preset: 'kiro' },
          matrix: {
            transport: 'm1',
            user_id: '@bob:localhost',
            rooms: [{ alias: '!r:localhost' }],
            trigger: 'mention',
          },
        },
      },
      hooks: {},
    } as ZooidConfig
    expect(() =>
      buildAcpRegistry(cfg, { configDir: '/example', dataDir: '/data' }),
    ).toThrow(/alice[\s\S]*cline[\s\S]*bob[\s\S]*kiro/)
  })
})

describe('buildAcpRegistry — startup discoverability (ZOD044)', () => {
  it('logs one resolved-image line per agent with provenance', () => {
    const lines: string[] = []
    const cfg = mkCfg()
    buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      log: (line) => lines.push(line),
    })
    expect(
      lines.some((l) =>
        /agent alice.*image=ghcr\.io\/zooid-ai\/agent-claude-code.*source=preset:claude/.test(l),
      ),
    ).toBe(true)
  })

  it('reports source=agent when the agent overrides the preset default', () => {
    const lines: string[] = []
    const cfg = mkCfg({ container: { image: 'custom:v3' } })
    buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      log: (line) => lines.push(line),
    })
    expect(lines.some((l) => /agent alice.*image=custom:v3.*source=agent/.test(l))).toBe(true)
  })

  it('reports source=workforce when only workforce container.image is set', () => {
    const lines: string[] = []
    const cfg = mkCfg()
    cfg.container = { image: 'wf:v1' }
    buildAcpRegistry(cfg, {
      configDir: '/example',
      dataDir: '/data',
      log: (line) => lines.push(line),
    })
    expect(lines.some((l) => /agent alice.*image=wf:v1.*source=workforce/.test(l))).toBe(true)
  })
})
