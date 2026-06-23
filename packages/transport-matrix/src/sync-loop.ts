export interface SyncResponse {
  next_batch: string
  rooms: {
    join: Record<string, {
      timeline: {
        events: Record<string, unknown>[]
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
    for (const [roomId, roomState] of Object.entries(res.rooms.join)) {
      for (const baseEvt of roomState.timeline.events) {
        await this.opts.onEvent({ ...(baseEvt as Record<string, unknown>), room_id: roomId })
      }
    }
    this.opts.saveSince(res.next_batch)
  }

  async run(): Promise<void> {
    this.running = true
    while (this.running) {
      await this.tick()
    }
  }

  stop(): void {
    this.running = false
  }
}
