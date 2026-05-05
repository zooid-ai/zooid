import { randomUUID } from 'node:crypto'

export interface MatrixClientOptions {
  homeserver: string
  asToken: string
  fetch?: typeof globalThis.fetch
}

export interface SendMessageInput {
  roomId: string
  asUserId: string
  content: { msgtype: string; body: string; [k: string]: unknown }
  threadRoot?: string
}

export interface SendCustomEventInput {
  roomId: string
  asUserId: string
  eventType: string
  content: Record<string, unknown>
}

export class MatrixClient {
  private readonly homeserver: string
  private readonly asToken: string
  private readonly fetch: typeof globalThis.fetch

  constructor(opts: MatrixClientOptions) {
    this.homeserver = opts.homeserver.replace(/\/$/, '')
    this.asToken = opts.asToken
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  async registerBot(
    localpart: string,
  ): Promise<{ user_id: string; device_id: string } | undefined> {
    const r = await this.fetch(`${this.homeserver}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.asToken}` },
      body: JSON.stringify({ type: 'm.login.application_service', username: localpart }),
    })
    if (r.status === 200) return (await r.json()) as { user_id: string; device_id: string }
    if (r.status === 400) {
      const body = (await r.json()) as { errcode?: string }
      if (body.errcode === 'M_USER_IN_USE') return undefined
    }
    throw new Error(`registerBot(${localpart}) failed: ${r.status}`)
  }

  async joinRoom(roomIdOrAlias: string, asUserId: string): Promise<void> {
    const url =
      `${this.homeserver}/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}` +
      `?user_id=${encodeURIComponent(asUserId)}`
    const r = await this.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.asToken}` },
      body: '{}',
    })
    if (!r.ok) throw new Error(`joinRoom(${roomIdOrAlias}) failed: ${r.status}`)
  }

  async sendMessage(input: SendMessageInput): Promise<{ event_id: string }> {
    const content: Record<string, unknown> = { ...input.content }
    if (input.threadRoot) {
      content['m.relates_to'] = { rel_type: 'm.thread', event_id: input.threadRoot }
    }
    return this.sendEvent(input.roomId, input.asUserId, 'm.room.message', content)
  }

  async sendCustomEvent(input: SendCustomEventInput): Promise<{ event_id: string }> {
    return this.sendEvent(input.roomId, input.asUserId, input.eventType, input.content)
  }

  private async sendEvent(
    roomId: string,
    asUserId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<{ event_id: string }> {
    const txn = randomUUID()
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}` +
      `/send/${eventType}/${txn}?user_id=${encodeURIComponent(asUserId)}`
    const r = await this.fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.asToken}` },
      body: JSON.stringify(content),
    })
    if (!r.ok) throw new Error(`sendEvent(${eventType}) failed: ${r.status}`)
    return (await r.json()) as { event_id: string }
  }
}
