import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GUEST_FORWARDER_JS, buildForwarderArgv } from './guest-forwarder.js'

let dir: string
let sock: string
const children: ChildProcess[] = []
const servers: Server[] = []

beforeEach(() => {
  // Short on purpose: Unix socket paths over 103 bytes are truncated.
  dir = mkdtempSync('/tmp/zf-')
  sock = join(dir, 'f.sock')
})
afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
  rmSync(dir, { recursive: true, force: true })
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

function startForwarder(port: number): ChildProcess {
  const c = spawn(process.execPath, ['-e', GUEST_FORWARDER_JS, String(port), sock], { stdio: 'pipe' })
  children.push(c)
  return c
}

async function waitListening(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => {
      const s = connect(port, '127.0.0.1')
      s.on('connect', () => (s.destroy(), r(true)))
      s.on('error', () => r(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('forwarder never listened')
}

function echoServer(): Promise<void> {
  return new Promise((resolve) => {
    const s = createServer((c) => c.pipe(c)).listen(sock, () => resolve())
    servers.push(s)
  })
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(payload))
    let got = ''
    s.on('data', (d) => {
      got += String(d)
      if (got.length >= payload.length) (s.end(), resolve(got))
    })
    s.on('error', reject)
  })
}

describe('GUEST_FORWARDER_JS', () => {
  it('pipes a TCP connection to the Unix socket and back', async () => {
    await echoServer()
    const port = await freePort()
    startForwarder(port)
    await waitListening(port)
    expect(await roundTrip(port, 'ping')).toBe('ping')
  })

  it('carries an HTTP round trip', async () => {
    let seen = ''
    await new Promise<void>((resolve) => {
      const s = createHttpServer((req, res) => {
        seen = req.url ?? ''
        res.end('ok')
      }).listen(sock, () => resolve())
      servers.push(s as unknown as Server)
    })
    const port = await freePort()
    startForwarder(port)
    await waitListening(port)
    const r = await fetch(`http://127.0.0.1:${port}/x`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
    expect(seen).toBe('/x')
  })

  it('keeps concurrent connections apart', async () => {
    await echoServer()
    const port = await freePort()
    startForwarder(port)
    await waitListening(port)
    const [a, b] = await Promise.all([roundTrip(port, 'aaaa'), roundTrip(port, 'bbbbbb')])
    expect(a).toBe('aaaa')
    expect(b).toBe('bbbbbb')
  })

  it('a second instance on the same port exits 0', async () => {
    const port = await freePort()
    startForwarder(port)
    await waitListening(port)
    const second = startForwarder(port)
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('second forwarder did not exit')), 2000)
      second.on('exit', (c) => (clearTimeout(t), resolve(c)))
    })
    expect(code).toBe(0)
  })

  it('closes the client when the socket is missing, and keeps serving once it exists', async () => {
    const port = await freePort()
    startForwarder(port)
    await waitListening(port)
    await new Promise<void>((resolve) => {
      const s = connect(port, '127.0.0.1')
      s.on('close', () => resolve())
      s.on('error', () => {})
    })
    await echoServer()
    expect(await roundTrip(port, 'later')).toBe('later')
  })
})

describe('buildForwarderArgv', () => {
  it('detaches node -e with the script, port and socket', () => {
    const argv = buildForwarderArgv('m', 8787, '/run/zooid/model.sock')
    expect(argv).toEqual([
      'machine', 'exec', '-d', '--name', 'm', '--',
      'node', '-e', GUEST_FORWARDER_JS, '8787', '/run/zooid/model.sock',
    ])
    expect(argv[8]).toBe(GUEST_FORWARDER_JS)
  })
})
