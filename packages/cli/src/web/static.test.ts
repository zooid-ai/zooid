import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { webStatic } from './static.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-web-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id=root></div>')
  writeFileSync(join(dir, 'assets', 'main.js'), 'console.log("ui")')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('webStatic', () => {
  it('serves index.html at /', async () => {
    const app = webStatic({ webRoot: dir, homeserverUrl: 'http://localhost:8448' })
    const r = await app.request('/')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('id=root')
  })

  it('serves static assets', async () => {
    const app = webStatic({ webRoot: dir, homeserverUrl: 'http://localhost:8448' })
    const r = await app.request('/assets/main.js')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('console.log("ui")')
  })

  it('synthesizes /config.json with the homeserver URL', async () => {
    const app = webStatic({ webRoot: dir, homeserverUrl: 'http://localhost:8448' })
    const r = await app.request('/config.json')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
    expect(await r.json()).toEqual({ homeserver_url: 'http://localhost:8448' })
  })

  it('falls back to index.html for unknown routes (SPA history)', async () => {
    const app = webStatic({ webRoot: dir, homeserverUrl: 'http://localhost:8448' })
    const r = await app.request('/room/!abc:localhost')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('id=root')
  })

  it('returns 404 for a missing asset', async () => {
    const app = webStatic({ webRoot: dir, homeserverUrl: 'http://localhost:8448' })
    const r = await app.request('/assets/nope.js')
    expect(r.status).toBe(404)
  })
})
