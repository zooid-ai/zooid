import { describe, expect, it } from 'vitest'
import { findMatrixTransport, findTransport } from './config.js'
import type { WorkforceConfig } from './types.js'

const cfg: WorkforceConfig = {
  runtime: 'docker',
  transports: {
    'matrix-local': {
      type: 'matrix',
      homeserver: 'http://localhost:8448',
      as_token: 'as-x',
      hs_token: 'hs-x',
      sender_localpart: 'zooid',
      user_namespace: '@.*:localhost',
    },
  },
  agents: {},
  hooks: {},
}

describe('findTransport / findMatrixTransport', () => {
  it('findTransport returns the named transport', () => {
    expect(findTransport(cfg, 'matrix-local')?.type).toBe('matrix')
  })

  it('findTransport returns undefined for unknown names', () => {
    expect(findTransport(cfg, 'ghost')).toBeUndefined()
  })

  it('findMatrixTransport returns the (single) matrix transport', () => {
    const t = findMatrixTransport(cfg)
    expect(t?.transport.type).toBe('matrix')
    expect(t?.name).toBe('matrix-local')
  })

  it('findMatrixTransport returns null when none exists', () => {
    const httpOnly: WorkforceConfig = {
      ...cfg,
      transports: { 'http-only': { type: 'http', port: 8080 } },
    }
    expect(findMatrixTransport(httpOnly)).toBeNull()
  })

  it('findMatrixTransport throws when more than one matrix transport exists', () => {
    const dual: WorkforceConfig = {
      ...cfg,
      transports: {
        a: cfg.transports['matrix-local']!,
        b: cfg.transports['matrix-local']!,
      },
    }
    expect(() => findMatrixTransport(dual)).toThrow(/multiple matrix transports/i)
  })
})
