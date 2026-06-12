export const MAX_MEDIA_PER_TURN = 8

export interface PendingMediaItem {
  eventId: string
  sender: string
  msgtype: string
  body: string
  filename?: string
  url: string
  info?: { mimetype?: string; size?: number; w?: number; h?: number }
}

export class PendingMediaStore {
  private readonly queues = new Map<string, PendingMediaItem[]>()

  private key(roomId: string, threadKey: string | undefined): string {
    return `${roomId} ${threadKey ?? 'main'}`
  }

  add(roomId: string, threadKey: string | undefined, item: PendingMediaItem): void {
    const k = this.key(roomId, threadKey)
    const q = this.queues.get(k) ?? []
    q.push(item)
    while (q.length > MAX_MEDIA_PER_TURN) q.shift()
    this.queues.set(k, q)
  }

  drain(roomId: string, threadKey: string | undefined, sender: string): PendingMediaItem[] {
    const k = this.key(roomId, threadKey)
    const q = this.queues.get(k) ?? []
    const mine = q.filter((i) => i.sender === sender)
    const rest = q.filter((i) => i.sender !== sender)
    if (rest.length) this.queues.set(k, rest)
    else this.queues.delete(k)
    return mine
  }
}
