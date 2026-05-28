import { describe, it, expect, vi } from 'vitest'
import { buildAcpRegistry } from './build-registry.js'
import type { ZooidConfig } from '@zooid/core'

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
