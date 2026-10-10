import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialExpiredError, type CodexAuth } from './codex-auth.js'
import { startCredentialProxy, type CredentialProxyHandle } from './proxy.js'

let dir: string
let socketPath: string
let upstream: Server
let upstreamUrl: string
let seen: { method?: string; url?: string; headers?: IncomingHttpHeaders; body?: Buffer } = {}
let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
let proxy: CredentialProxyHandle | undefined
let logs: string[]

const auth = (): CodexAuth & { current: ReturnType<typeof vi.fn> } => ({
  current: vi.fn(async () => ({ access: 'REAL', accountId: 'acct-1' })),
})

beforeEach(async () => {
  dir = mkdtempSync('/tmp/zp-')
  socketPath = join(dir, 'p.sock')
  seen = {}
  logs = []
  handler = (_req, res) => res.end('ok')
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
      handler(req, res)
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterEach(async () => {
  await proxy?.close()
  proxy = undefined
  upstream.closeAllConnections()
  await new Promise((r) => upstream.close(r))
  rmSync(dir, { recursive: true, force: true })
})

async function start(a: CodexAuth = auth()) {
  proxy = await startCredentialProxy({
    socketPath,
    upstream: upstreamUrl,
    allowPaths: ['/backend-api/codex/'],
    auth: a,
    agent: 'smoke',
    log: (l) => logs.push(l),
  })
  return a
}

interface Res {
  status: number
  headers: IncomingHttpHeaders
  body: string
  chunks: Array<{ at: number; data: string }>
}

function send(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, (res) => {
      const chunks: Res['chunks'] = []
      res.on('data', (d) => chunks.push({ at: Date.now(), data: String(d) }))
      res.on('end', () =>
        resolve({ status: res.statusCode!, headers: res.headers, body: chunks.map((c) => c.data).join(''), chunks }),
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('startCredentialProxy', () => {
  it('swaps in the real credential and forwards everything else unchanged', async () => {
    await start()
    const body = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0xff])
    const r = await send(
      'POST',
      '/backend-api/codex/responses',
      {
        authorization: 'Bearer PLACEHOLDER',
        'chatgpt-account-id': 'zooid-placeholder',
        originator: 'pi',
        'content-encoding': 'zstd',
      },
      body,
    )
    expect(r.status).toBe(200)
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/backend-api/codex/responses')
    expect(seen.headers!.authorization).toBe('Bearer REAL')
    expect(seen.headers!['chatgpt-account-id']).toBe('acct-1')
    expect(seen.headers!.originator).toBe('pi')
    expect(seen.headers!['content-encoding']).toBe('zstd')
    expect(seen.headers!.host).toBe(new URL(upstreamUrl).host)
    expect(seen.body!.equals(body)).toBe(true)
  })

  it('streams SSE rather than buffering it', async () => {
    let wroteSecondAt = 0
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
      setTimeout(() => {
        wroteSecondAt = Date.now()
        res.end('data: 2\n\n')
      }, 200)
    }
    await start()
    const r = await send('POST', '/backend-api/codex/responses')
    expect(r.body).toBe('data: 1\n\ndata: 2\n\n')
    expect(r.chunks[0]!.data).toBe('data: 1\n\n')
    expect(r.chunks[0]!.at).toBeLessThan(wroteSecondAt)
  })

  it('passes upstream status and headers back', async () => {
    handler = (_req, res) => {
      res.writeHead(429, { 'retry-after': '3' })
      res.end()
    }
    await start()
    const r = await send('POST', '/backend-api/codex/responses')
    expect(r.status).toBe(429)
    expect(r.headers['retry-after']).toBe('3')
  })

  it('refuses a path outside the allow list without touching auth or upstream', async () => {
    const a = await start()
    const r = await send('GET', '/backend-api/me')
    expect(r.status).toBe(403)
    expect(JSON.parse(r.body)).toEqual({
      error: { message: 'zooid credential proxy: GET /backend-api/me is not forwarded' },
    })
    expect(a.current).not.toHaveBeenCalled()
    expect(seen.url).toBeUndefined()
  })

  it('refuses a traversal out of an allowed prefix', async () => {
    await start()
    const r = await send('POST', '/backend-api/codex/../me')
    expect(r.status).toBe(403)
    expect(seen.url).toBeUndefined()
  })

  it('an expired login is a 401 naming the fix, and upstream is not hit', async () => {
    await start({ current: vi.fn(async () => Promise.reject(new CredentialExpiredError('X'))) })
    const r = await send('POST', '/backend-api/codex/responses')
    expect(r.status).toBe(401)
    expect(JSON.parse(r.body)).toEqual({ error: { message: 'zooid credential proxy: X' } })
    expect(seen.url).toBeUndefined()
  })

  it('an unreachable upstream is a 502', async () => {
    await start()
    upstream.closeAllConnections()
    await new Promise((r) => upstream.close(r))
    const r = await send('POST', '/backend-api/codex/responses')
    expect(r.status).toBe(502)
    expect(JSON.parse(r.body)).toEqual({
      error: { message: `zooid credential proxy: upstream ${upstreamUrl} unreachable` },
    })
    upstream.listen(0) // so afterEach's close has something to close
  })

  it('replaces a stale socket file and makes the socket owner-only', async () => {
    writeFileSync(socketPath, 'stale')
    await start()
    expect(statSync(socketPath).isSocket()).toBe(true)
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('logs one line per request and never a credential', async () => {
    await start()
    await send('POST', '/backend-api/codex/responses', { authorization: 'Bearer PLACEHOLDER' })
    const lines = logs.filter((l) => l.startsWith('[cred-proxy]'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[cred-proxy\] smoke POST \/backend-api\/codex\/responses → 200 \(\d+ms\)$/)
    expect(logs.join('\n')).not.toMatch(/REAL|acct-1/)
  })

  it('close removes the socket and stops accepting', async () => {
    await start()
    await proxy!.close()
    proxy = undefined
    expect(existsSync(socketPath)).toBe(false)
    await expect(send('GET', '/backend-api/codex/x')).rejects.toThrow()
  })
})
