import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 })
const generateVAPIDKeys = vi.fn(() => ({
  publicKey: 'B'.repeat(87),
  privateKey: 'p'.repeat(43),
}))
vi.mock('web-push', () => ({
  default: { sendNotification, generateVAPIDKeys, WebPushError: class extends Error {} },
  sendNotification,
  generateVAPIDKeys,
  WebPushError: class extends Error {},
}))

const { mountPushGateway } = await import('../src/push-gateway/index.js')
const { Hono } = await import('hono')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-vapid-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('push gateway mounted on the appservice app', () => {
  it('answers /notify without shadowing the appservice transaction route', async () => {
    const app = new Hono()
    app.put('/_matrix/app/v1/transactions/:txnId', (c) => c.json({ appservice: true }))
    mountPushGateway(app, { dataDir: dir, subject: 'mailto:o@example.org' })

    const txn = await app.request('/_matrix/app/v1/transactions/1', { method: 'PUT' })
    expect(await txn.json()).toEqual({ appservice: true })

    const notify = await app.request('/_matrix/push/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notification: {
          event_id: '$e',
          room_id: '!r:x',
          type: 'm.room.message',
          content: { msgtype: 'm.text', body: 'hi' },
          devices: [{ app_id: 'dev.zooid.web', pushkey: 'pk', data: { endpoint: 'https://p/1', auth: 'a' } }],
        },
      }),
    })
    expect(notify.status).toBe(200)
    expect(sendNotification).toHaveBeenCalled()
  })

  it('exposes the VAPID public key for zooid status to print', () => {
    const app = new Hono()
    const { publicKey } = mountPushGateway(app, { dataDir: dir, subject: 'mailto:o@example.org' })
    expect(publicKey.length).toBe(87)
  })
})
