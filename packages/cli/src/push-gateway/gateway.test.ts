import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()
class WebPushError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message)
  }
}
vi.mock('web-push', () => ({
  default: { sendNotification, WebPushError },
  sendNotification,
  WebPushError,
}))

const { pushGateway } = await import('./gateway.js')

const KEYS = { publicKey: 'pub', privateKey: 'priv' }

function device(over: Record<string, unknown> = {}) {
  return {
    app_id: 'dev.zooid.web',
    pushkey: 'BPk_device_one',
    data: { endpoint: 'https://fcm.example/one', auth: 'auth1' },
    ...over,
  }
}

function notification(devices: unknown[]) {
  return {
    notification: {
      event_id: '$e:example.org',
      room_id: '!r:example.org',
      room_name: 'general',
      sender_display_name: 'Alice',
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'hello' },
      counts: { unread: 1 },
      devices,
    },
  }
}

async function notify(body: unknown) {
  const app = pushGateway({ keys: KEYS, subject: 'mailto:ops@example.org' })
  return app.request('/_matrix/push/v1/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  sendNotification.mockReset()
  sendNotification.mockResolvedValue({ statusCode: 201 })
})

describe('pushGateway', () => {
  it('encrypts to the device subscription reassembled from pushkey + data', async () => {
    const res = await notify(notification([device()]))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rejected: [] })

    const [subscription, payload, options] = sendNotification.mock.calls[0]!
    expect(subscription).toEqual({
      endpoint: 'https://fcm.example/one',
      keys: { p256dh: 'BPk_device_one', auth: 'auth1' },
    })
    expect(JSON.parse(payload as string).room_name).toBe('general')
    expect((options as { vapidDetails: unknown }).vapidDetails).toEqual({
      subject: 'mailto:ops@example.org',
      publicKey: 'pub',
      privateKey: 'priv',
    })
  })

  it('fans out to every matching device', async () => {
    await notify(
      notification([
        device(),
        device({ pushkey: 'BPk_two', data: { endpoint: 'https://fcm.example/two', auth: 'a2' } }),
      ]),
    )
    expect(sendNotification).toHaveBeenCalledTimes(2)
  })

  it('skips a foreign app_id silently — never rejects it', async () => {
    const res = await notify(notification([device({ app_id: 'im.vector.app.ios' })]))
    expect(sendNotification).not.toHaveBeenCalled()
    // Rejecting would make the homeserver permanently delete another client's pusher.
    expect(await res.json()).toEqual({ rejected: [] })
  })

  it('rejects a pushkey on 410 Gone so the homeserver garbage-collects it', async () => {
    sendNotification.mockRejectedValueOnce(new WebPushError('gone', 410))
    const res = await notify(notification([device()]))
    expect(await res.json()).toEqual({ rejected: ['BPk_device_one'] })
  })

  it('rejects a pushkey on 404 too', async () => {
    sendNotification.mockRejectedValueOnce(new WebPushError('not found', 404))
    expect(await (await notify(notification([device()]))).json()).toEqual({
      rejected: ['BPk_device_one'],
    })
  })

  it('does NOT reject on a transient 429 or 5xx', async () => {
    sendNotification.mockRejectedValueOnce(new WebPushError('slow down', 429))
    expect(await (await notify(notification([device()]))).json()).toEqual({ rejected: [] })

    sendNotification.mockRejectedValueOnce(new WebPushError('bad gateway', 502))
    expect(await (await notify(notification([device()]))).json()).toEqual({ rejected: [] })
  })

  it('does not let one dead device stop delivery to a live one', async () => {
    sendNotification
      .mockRejectedValueOnce(new WebPushError('gone', 410))
      .mockResolvedValueOnce({ statusCode: 201 })
    const res = await notify(
      notification([
        device(),
        device({ pushkey: 'BPk_two', data: { endpoint: 'https://fcm.example/two', auth: 'a2' } }),
      ]),
    )
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect(await res.json()).toEqual({ rejected: ['BPk_device_one'] })
  })

  it('skips a device missing endpoint or auth without rejecting it', async () => {
    const res = await notify(notification([device({ data: { endpoint: 'https://x' } })]))
    expect(sendNotification).not.toHaveBeenCalled()
    expect(await res.json()).toEqual({ rejected: [] })
  })

  it('400s on a malformed body instead of throwing', async () => {
    expect((await notify({ nope: true })).status).toBe(400)
  })
})
