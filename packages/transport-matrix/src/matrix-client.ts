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

export interface SetTypingInput {
  roomId: string
  asUserId: string
  typing: boolean
  /** ms — homeserver expects re-PUTs before this expires. Ignored when typing=false. */
  timeoutMs?: number
}

export interface SetPresenceInput {
  asUserId: string
  presence: 'online' | 'unavailable' | 'offline'
  statusMsg?: string
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

  async resolveAlias(alias: string): Promise<string | null> {
    const r = await this.fetch(
      `${this.homeserver}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { headers: { Authorization: `Bearer ${this.asToken}` } },
    )
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`resolveAlias(${alias}) failed: ${r.status}`)
    const j = (await r.json()) as { room_id: string }
    return j.room_id
  }

  async createRoom(opts: {
    roomAliasName: string
    invite: string[]
    senderUserId: string
    preset?: 'public_chat' | 'private_chat' | 'trusted_private_chat'
  }): Promise<string> {
    const r = await this.fetch(
      `${this.homeserver}/_matrix/client/v3/createRoom?user_id=${encodeURIComponent(opts.senderUserId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.asToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          room_alias_name: opts.roomAliasName,
          invite: opts.invite,
          preset: opts.preset ?? 'public_chat',
        }),
      },
    )
    if (!r.ok) {
      const body = await r.text()
      throw new Error(`createRoom(${opts.roomAliasName}) failed: ${r.status} ${body}`)
    }
    const j = (await r.json()) as { room_id: string }
    return j.room_id
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

  async setTyping(input: SetTypingInput): Promise<void> {
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}` +
      `/typing/${encodeURIComponent(input.asUserId)}` +
      `?user_id=${encodeURIComponent(input.asUserId)}`
    const body: Record<string, unknown> = { typing: input.typing }
    if (input.typing && input.timeoutMs !== undefined) body.timeout = input.timeoutMs
    const r = await this.fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.asToken}` },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`setTyping(${input.roomId}, ${input.asUserId}) failed: ${r.status}`)
  }

  async setPresence(input: SetPresenceInput): Promise<void> {
    const url =
      `${this.homeserver}/_matrix/client/v3/presence/${encodeURIComponent(input.asUserId)}/status` +
      `?user_id=${encodeURIComponent(input.asUserId)}`
    const body: Record<string, unknown> = { presence: input.presence }
    if (input.statusMsg !== undefined) body.status_msg = input.statusMsg
    const r = await this.fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.asToken}` },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`setPresence(${input.asUserId}) failed: ${r.status}`)
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
