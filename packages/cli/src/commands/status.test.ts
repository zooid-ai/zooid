import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectStatus } from './status.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-status-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const yaml = [
  'transports:',
  '  m:',
  '    type: matrix',
  '    homeserver: http://localhost:8448',
  '    as_token: as-x',
  '    hs_token: hs-x',
  '    sender_localpart: zooid',
  '    user_namespace: "@.*:localhost"',
  '    port: 9099',
  'agents:',
  '  assistant:',
  '    transport: m',
  '    matrix_user_id: "@assistant:localhost"',
  '    rooms: ["!general:localhost"]',
  '    trigger: mention',
  '    workdir: .',
  '    acp: { preset: claude }',
].join('\n')

describe('collectStatus', () => {
  it('reports tuwunel up + daemon up + agents listed', async () => {
    writeFileSync(join(dir, 'workforce.yaml'), yaml)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/_matrix/client/versions')) {
          return new Response(JSON.stringify({ versions: ['v1.13'] }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      }),
    )
    const s = await collectStatus({ cwd: dir, tuwunelUrl: 'http://localhost:8448' })
    expect(s.tuwunel).toEqual({ status: 'up', url: 'http://localhost:8448' })
    expect(s.daemon).toEqual({ status: 'up', url: 'http://localhost:9099' })
    expect(s.agents).toEqual([
      { name: 'assistant', userId: '@assistant:localhost', trigger: 'mention' },
    ])
  })

  it('reports daemon down when the AS callback port refuses the connection', async () => {
    writeFileSync(join(dir, 'workforce.yaml'), yaml)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/_matrix/client/versions')) {
          return new Response(JSON.stringify({ versions: ['v1.13'] }), { status: 200 })
        }
        throw new Error('ECONNREFUSED')
      }),
    )
    const s = await collectStatus({ cwd: dir, tuwunelUrl: 'http://localhost:8448' })
    expect(s.tuwunel.status).toBe('up')
    if ('status' in s.daemon) expect(s.daemon.status).toBe('down')
    else throw new Error('expected daemon to have status field')
  })
})
