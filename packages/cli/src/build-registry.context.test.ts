import { describe, it, expect, vi } from 'vitest'
import { buildAcpRegistry } from './build-registry.js'
import type { ZooidConfig } from '@zooid/core'
import {
  CONTEXT_CONTAINER_BIN,
  CONTEXT_CONTAINER_BIN_DIR,
  CONTEXT_CONTAINER_SOCK,
} from '@zooid/context-mcp'

const matrixCfg: ZooidConfig = {
  runtime: 'local',
  transports: {
    mx: {
      type: 'matrix',
      homeserver: 'https://hs',
      as_token: 'as',
      hs_token: 'hs',
      user_namespace: '@.*:hs',
      sender_localpart: '_zooid',
      space: 'dev',
      port: 0,
    },
  },
  agents: {
    architect: {
      name: 'architect',
      workdir: '/tmp',
      hooks: {},
      acp: { command: 'fake', args: [] },
      approval_timeout_ms: 0,
      matrix: {
        transport: 'mx',
        user_id: '@architect:hs',
        rooms: [{ alias: '!r:hs' }],
        trigger: 'mention',
      },
    },
  },
  hooks: {},
} as unknown as ZooidConfig

describe('buildAcpRegistry — context provider wiring', () => {
  it('attaches a Matrix-backed context provider to agents bound to a matrix transport', () => {
    const registry = buildAcpRegistry(matrixCfg, {
      approvals: { register: vi.fn(), on: vi.fn() } as never,
      contextSpawnRegistry: {} as never,
      daemonSockPath: '/tmp/zooid-test.sock',
    })
    expect(registry.hasContextSpawn('architect')).toBe(true)
  })

  it('does not attach a context provider to http-bound agents', () => {
    const httpCfg = structuredClone(matrixCfg)
    httpCfg.transports = {
      h: { type: 'http', port: 0 } as never,
    }
    httpCfg.agents.architect.matrix = undefined as never
    ;(httpCfg.agents.architect as { http?: unknown }).http = { transport: 'h' }
    const registry = buildAcpRegistry(httpCfg, {
      approvals: { register: vi.fn(), on: vi.fn() } as never,
      contextSpawnRegistry: {} as never,
      daemonSockPath: '/tmp/zooid-test.sock',
    })
    expect(registry.hasContextSpawn('architect')).toBe(false)
  })
})

describe('buildAcpRegistry — context provider in a container runtime', () => {
  function podmanCfg(): ZooidConfig {
    const cfg = structuredClone(matrixCfg)
    cfg.runtime = 'podman'
    // podman requires a resolvable image per agent (no preset here).
    ;(cfg.agents.architect as { container?: unknown }).container = { image: 'img:latest' }
    return cfg
  }

  const opts = {
    approvals: { register: vi.fn(), on: vi.fn() } as never,
    contextSpawnRegistry: { register: vi.fn(() => 'spawn-1') } as never,
    daemonSockPath: '/home/ubuntu/hq/data/run/context.sock',
    daemonHome: '/home/ubuntu',
  }

  it('adds the socket (rw) and bin (ro) bind-mounts to a context-enabled agent', () => {
    const registry = buildAcpRegistry(podmanCfg(), opts)
    const mounts = registry.resolveSpawnMounts('architect')
    const sock = mounts.find((m) => m.target === CONTEXT_CONTAINER_SOCK)
    const bin = mounts.find((m) => m.target === CONTEXT_CONTAINER_BIN_DIR)
    expect(sock).toMatchObject({ path: '/home/ubuntu/hq/data/run/context.sock', mode: 'rw' })
    expect(bin?.mode).toBe('ro')
    expect(bin?.path).toMatch(/context-mcp[/\\]dist$/)
  })

  it('threads a containerized mcpServers spec into the agent factory', async () => {
    const registry = buildAcpRegistry(podmanCfg(), opts)
    // opts is public readonly on the registry; the per-agent factory lives here.
    const factory = registry.opts.contextSpawns!.architect!
    const spec = await factory('!r:hs')
    expect(spec.command).toBe('node')
    expect(spec.args[0]).toBe(CONTEXT_CONTAINER_BIN)
    expect(spec.env).toContainEqual({ name: 'ZOOID_DAEMON_SOCK', value: CONTEXT_CONTAINER_SOCK })
  })

  it('leaves the local runtime host-shaped (no context mounts, host command)', async () => {
    // matrixCfg is runtime: local. No container mounts; factory stays host-shaped.
    const registry = buildAcpRegistry(matrixCfg, opts)
    const mounts = registry.resolveSpawnMounts('architect')
    expect(mounts.some((m) => m.target === CONTEXT_CONTAINER_SOCK)).toBe(false)
    const spec = await registry.opts.contextSpawns!.architect!('!r:hs')
    expect(spec.command).toBe(process.execPath)
  })
})
