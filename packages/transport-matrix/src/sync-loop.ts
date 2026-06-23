export interface SyncResponse {
  next_batch: string
  // Real homeservers omit `rooms` (and `rooms.join`) entirely on an idle
  // incremental sync — both are optional.
  rooms?: {
    join?: Record<string, {
      // A joined room may carry only state/ephemeral/account_data on a given
      // sync, with no `timeline` (or a timeline with no `events`).
      timeline?: {
        events?: Record<string, unknown>[]
        prev_batch?: string
        limited?: boolean
      }
    }>
  }
}

export interface SyncClient {
  sync(opts: { asUserId: string; since: string | null; timeoutMs: number }): Promise<SyncResponse>
}

export interface SyncLoopOptions {
  client: SyncClient
  asUserId: string
  loadSince: () => string | null
  saveSince: (since: string) => void
  onEvent: (evt: Record<string, unknown>) => void | Promise<void>
  timeoutMs?: number
  /** Backoff after a failed tick before retrying. Default 5000ms. */
  retryDelayMs?: number
}

export class SyncLoop {
  private readonly opts: SyncLoopOptions
  private running = false

  constructor(opts: SyncLoopOptions) {
    this.opts = opts
  }

  async tick(): Promise<void> {
    const since = this.opts.loadSince()
    const res = await this.opts.client.sync({
      asUserId: this.opts.asUserId,
      since,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
    })
    for (const [roomId, roomState] of Object.entries(res.rooms?.join ?? {})) {
      for (const baseEvt of roomState.timeline?.events ?? []) {
        await this.opts.onEvent({ ...(baseEvt as Record<string, unknown>), room_id: roomId })
      }
    }
    this.opts.saveSince(res.next_batch)
  }

  async run(): Promise<void> {
    this.running = true
    while (this.running) {
      try {
        await this.tick()
      } catch (err) {
        // A transient /sync failure (network blip, sleep/wake, 5xx) must not
        // kill the loop — log and back off, then resume from the same `since`.
        if (!this.running) break
        console.warn(`[sync-loop] ${this.opts.asUserId} tick failed, retrying:`, err)
        await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 5_000))
      }
    }
  }

  stop(): void {
    this.running = false
  }
}
