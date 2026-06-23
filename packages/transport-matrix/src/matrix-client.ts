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
    /** Optional `m.room.name`. When set, sent in the createRoom body so the
     *  room has a display name from the moment it exists. */
    name?: string
    /** When set, the room is created with a `restricted` join rule whose allow
     *  condition references this space room ID — i.e. joinable by space members
     *  only, rather than the whole homeserver. */
    restrictedToSpaceId?: string
    /** Explicit room version. Restricted join rules require v8+; omit to use the
     *  homeserver default (modern Tuwunel defaults to v10/v11). */
    roomVersion?: string
    /**
     * Seeds `m.room.power_levels.users` at creation via
     * `power_level_content_override.users`. The caller owns the full map —
     * typically the AS bot at 100, plus operator and any agents with
     * declared PLs. Empty/absent → no override (the preset's defaults apply).
     */
    userPowerLevels?: Record<string, number>
  }): Promise<string> {
    const body: Record<string, unknown> = {
      room_alias_name: opts.roomAliasName,
      invite: opts.invite,
      preset: opts.preset ?? 'public_chat',
    }
    if (opts.name !== undefined) body.name = opts.name
    if (opts.roomVersion !== undefined) body.room_version = opts.roomVersion
    if (opts.restrictedToSpaceId !== undefined) {
      body.initial_state = [
        {
          type: 'm.room.join_rules',
          state_key: '',
          content: {
            join_rule: 'restricted',
            allow: [{ type: 'm.room_membership', room_id: opts.restrictedToSpaceId }],
          },
        },
      ]
    }
    if (opts.userPowerLevels && Object.keys(opts.userPowerLevels).length > 0) {
      body.power_level_content_override = { users: opts.userPowerLevels }
    }
    const r = await this.fetch(
      `${this.homeserver}/_matrix/client/v3/createRoom?user_id=${encodeURIComponent(opts.senderUserId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.asToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    if (!r.ok) {
      const body = await r.text()
      throw new Error(`createRoom(${opts.roomAliasName}) failed: ${r.status} ${body}`)
    }
    const j = (await r.json()) as { room_id: string }
    return j.room_id
  }

  async createRoomRaw(opts: {
    asUserId: string
    body: Record<string, unknown>
  }): Promise<string> {
    const url = `${this.homeserver}/_matrix/client/v3/createRoom?user_id=${encodeURIComponent(opts.asUserId)}`
    const r = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.asToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts.body),
    })
    if (!r.ok) throw new Error(`createRoomRaw failed: ${r.status}`)
    const j = (await r.json()) as { room_id: string }
    return j.room_id
  }

  async sendStateEvent(opts: {
    roomId: string
    asUserId: string
    eventType: string
    stateKey?: string
    content: Record<string, unknown>
  }): Promise<{ event_id: string }> {
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}` +
      `/state/${encodeURIComponent(opts.eventType)}/${encodeURIComponent(opts.stateKey ?? '')}` +
      `?user_id=${encodeURIComponent(opts.asUserId)}`
    const r = await this.fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.asToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts.content),
    })
    if (!r.ok) throw new Error(`sendStateEvent ${opts.eventType} failed: ${r.status}`)
    return (await r.json()) as { event_id: string }
  }

  /**
   * Invite a user to a room. Sent as the inviter (`asUserId`) — that user
   * needs invite power in the room. Tolerates the "already in room /
   * already invited" responses idempotently so bootstrap can run on a
   * fresh AND a populated homeserver without branching.
   */
  async invite(opts: {
    roomId: string
    asUserId: string
    targetUserId: string
  }): Promise<void> {
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/invite` +
      `?user_id=${encodeURIComponent(opts.asUserId)}`
    const r = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.asToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ user_id: opts.targetUserId }),
    })
    if (r.ok) return
    if (r.status === 403) {
      // Tuwunel/Synapse use M_FORBIDDEN both for permission errors AND for
      // "already a member / already invited". Inspect the body so we only
      // swallow the idempotent case.
      //
      // Phrasings seen in the wild:
      //   - Synapse: "is already in the room", "is already invited"
      //   - Tuwunel: "cannot invite user that is joined or banned" (one
      //     string for both "joined" and "banned" — we can't tell which
      //     from the body; the bot-pool's outer try-catch surfaces a real
      //     ban via the subsequent joinRoom failure)
      //   - Generic: "X is already a member of the room"
      const body = await r.text()
      const idempotent =
        /already (in the room|invited|a member|joined)/i.test(body) ||
        /user that is joined/i.test(body)
      if (idempotent) return
      throw new Error(`invite(${opts.targetUserId}) failed: 403 ${body}`)
    }
    throw new Error(`invite(${opts.targetUserId}) failed: ${r.status}`)
  }

  async leaveRoom(
    roomId: string,
    asUserId: string,
    opts?: { reason?: string },
  ): Promise<void> {
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave` +
      `?user_id=${encodeURIComponent(asUserId)}`
    const r = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.asToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts?.reason ? { reason: opts.reason } : {}),
    })
    if (!r.ok) throw new Error(`leaveRoom(${roomId}, ${asUserId}) failed: ${r.status}`)
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

  async setDisplayName(asUserId: string, displayName: string): Promise<void> {
    const url =
      `${this.homeserver}/_matrix/client/v3/profile/${encodeURIComponent(asUserId)}/displayname` +
      `?user_id=${encodeURIComponent(asUserId)}`
    const r = await this.fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.asToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayname: displayName }),
    })
    if (!r.ok) throw new Error(`setDisplayName(${asUserId}) failed: ${r.status}`)
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

  /**
   * Fetch a single event from a room. Used to recover thread-root context
   * after a daemon restart wipes the in-memory threadStates cache.
   */
  async fetchEvent(
    roomId: string,
    eventId: string,
    asUserId: string,
  ): Promise<Record<string, unknown> | null> {
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}` +
      `/event/${encodeURIComponent(eventId)}` +
      `?user_id=${encodeURIComponent(asUserId)}`
    const r = await this.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.asToken}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`fetchEvent(${eventId}) failed: ${r.status}`)
    return (await r.json()) as Record<string, unknown>
  }

  /**
   * Fetch replies to a thread root via the relations endpoint, oldest-first.
   * Pass `limit` and `from` for pagination; `next_batch` echoes back when
   * there are more replies. Returns `{ chunk: [] }` when the root is unknown.
   */
  async fetchThreadRelations(opts: {
    roomId: string
    rootEventId: string
    asUserId: string
    limit?: number
    from?: string
  }): Promise<{ chunk: Array<Record<string, unknown>>; next_batch?: string }> {
    const params = new URLSearchParams({
      dir: 'f',
      limit: String(opts.limit ?? 100),
      user_id: opts.asUserId,
    })
    if (opts.from) params.set('from', opts.from)
    const url =
      `${this.homeserver}/_matrix/client/v1/rooms/${encodeURIComponent(opts.roomId)}` +
      `/relations/${encodeURIComponent(opts.rootEventId)}/m.thread?${params.toString()}`
    const r = await this.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.asToken}` },
    })
    if (r.status === 404) return { chunk: [] }
    if (!r.ok) throw new Error(`fetchThreadRelations(${opts.rootEventId}) failed: ${r.status}`)
    const body = (await r.json()) as {
      chunk?: Array<Record<string, unknown>>
      next_batch?: string
    }
    return { chunk: body.chunk ?? [], next_batch: body.next_batch }
  }

  /**
   * Paginate the room timeline. Returns events newest-first (dir=b) per Matrix
   * spec. The caller is responsible for reversing if it wants oldest-first.
   */
  async fetchRoomMessages(opts: {
    roomId: string
    asUserId: string
    limit?: number
    /** Opaque pagination token returned in `end` from a previous call. */
    from?: string
    /**
     * Server-side RoomEventFilter. Common keys: `types` (whitelist event types),
     * `not_types`, `not_rel_types` (e.g. `['m.thread']` to exclude thread
     * replies). Encoded as JSON into the `filter` query param.
     */
    filter?: {
      types?: string[]
      not_types?: string[]
      rel_types?: string[]
      not_rel_types?: string[]
    }
  }): Promise<{ chunk: Array<Record<string, unknown>>; end?: string }> {
    const params = new URLSearchParams({
      dir: 'b',
      limit: String(opts.limit ?? 50),
      user_id: opts.asUserId,
    })
    if (opts.from) params.set('from', opts.from)
    if (opts.filter) params.set('filter', JSON.stringify(opts.filter))
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}` +
      `/messages?${params.toString()}`
    const r = await this.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.asToken}` },
    })
    if (!r.ok) throw new Error(`fetchRoomMessages(${opts.roomId}) failed: ${r.status}`)
    return (await r.json()) as { chunk: Array<Record<string, unknown>>; end?: string }
  }

  async getJoinedMembers(
    roomId: string,
    asUserId: string,
  ): Promise<{ joined: Record<string, { display_name?: string }> }> {
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}` +
      `/joined_members?user_id=${encodeURIComponent(asUserId)}`
    const r = await this.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.asToken}` },
    })
    if (!r.ok) throw new Error(`getJoinedMembers(${roomId}) failed: ${r.status}`)
    return (await r.json()) as { joined: Record<string, { display_name?: string }> }
  }

  async sync(opts: {
    asUserId: string
    since?: string | null
    timeoutMs?: number
  }): Promise<{
    next_batch: string
    rooms: {
      join: Record<string, {
        timeline: { events: Record<string, unknown>[]; prev_batch?: string; limited?: boolean }
      }>
    }
  }> {
    const params = new URLSearchParams({
      user_id: opts.asUserId,
      timeout: String(opts.timeoutMs ?? 30_000),
    })
    if (opts.since) params.set('since', opts.since)
    const url = `${this.homeserver}/_matrix/client/v3/sync?${params.toString()}`
    const r = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.asToken}` },
    })
    if (!r.ok) throw new Error(`sync(${opts.asUserId}) failed: ${r.status}`)
    return r.json() as Promise<{
      next_batch: string
      rooms: {
        join: Record<string, {
          timeline: { events: Record<string, unknown>[]; prev_batch?: string; limited?: boolean }
        }>
      }
    }>
  }

  async fetchRoomName(roomId: string, asUserId: string): Promise<string | null> {
    const url =
      `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}` +
      `/state/m.room.name/?user_id=${encodeURIComponent(asUserId)}`
    const r = await this.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.asToken}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`fetchRoomName(${roomId}) failed: ${r.status}`)
    const body = (await r.json()) as { name?: string }
    return body.name ?? null
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
