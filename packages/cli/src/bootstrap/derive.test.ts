import { describe, expect, it } from 'vitest'
import type { MatrixTransportConfig } from '@zooid/core'
import { deriveHomeserverShape } from './derive.js'

const base: MatrixTransportConfig = {
  type: 'matrix',
  homeserver: 'http://localhost:8448',
  as_token: 'as-x',
  hs_token: 'hs-x',
  sender_localpart: 'zooid',
  user_namespace: '@.*:localhost',
}

describe('deriveHomeserverShape', () => {
  it('extracts host, port, and server_name from a localhost workforce.yaml', () => {
    const shape = deriveHomeserverShape(base, [
      '@assistant:localhost',
      '@monitor:localhost',
    ])
    expect(shape).toEqual({
      host: 'localhost',
      port: 8448,
      serverName: 'localhost',
    })
  })

  it('honors a non-default port in the homeserver URL', () => {
    const shape = deriveHomeserverShape(
      { ...base, homeserver: 'http://localhost:9000' },
      ['@assistant:localhost'],
    )
    expect(shape.port).toBe(9000)
  })

  it('extracts a non-localhost server_name when the user_namespace targets a domain', () => {
    const shape = deriveHomeserverShape(
      {
        ...base,
        homeserver: 'http://localhost:8448',
        user_namespace: '@.*:matrix.dev',
      },
      ['@assistant:matrix.dev'],
    )
    expect(shape.serverName).toBe('matrix.dev')
  })

  it('refuses to start when an agent matrix_user_id does not end with the derived server_name', () => {
    expect(() =>
      deriveHomeserverShape(base, ['@assistant:other.example']),
    ).toThrow(/server_name mismatch/i)
  })

  it('refuses to start when user_namespace regex is not the simple @.*:server form', () => {
    expect(() =>
      deriveHomeserverShape(
        { ...base, user_namespace: '@(alice|bob):localhost' },
        ['@assistant:localhost'],
      ),
    ).toThrow(/user_namespace/i)
  })

  it('defaults port to 80/443 when homeserver URL omits an explicit port', () => {
    expect(
      deriveHomeserverShape({ ...base, homeserver: 'http://hs.example', user_namespace: '@.*:hs.example' }, [
        '@assistant:hs.example',
      ]).port,
    ).toBe(80)
    expect(
      deriveHomeserverShape({ ...base, homeserver: 'https://hs.example', user_namespace: '@.*:hs.example' }, [
        '@assistant:hs.example',
      ]).port,
    ).toBe(443)
  })
})
