export interface ChunkerOptions {
  idleMs: number
  maxBytes: number
  onFlush: (chunks: string[]) => void
}

/**
 * Chunker buffers writes and flushes when one of three conditions hits:
 *   1. idleMs has elapsed since the last write
 *   2. buffered bytes >= maxBytes
 *   3. end() is called
 *
 * Each flush emits the buffered chunks as one batch via onFlush.
 */
export class Chunker {
  private buffer: string[] = []
  private bufferedBytes = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: ChunkerOptions) {}

  write(chunk: string): void {
    this.buffer.push(chunk)
    this.bufferedBytes += Buffer.byteLength(chunk, 'utf8')

    if (this.bufferedBytes >= this.opts.maxBytes) {
      this.flushNow()
      return
    }

    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.flushNow(), this.opts.idleMs)
  }

  end(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.buffer.length > 0) this.flushNow()
  }

  private flushNow(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.buffer.length === 0) return
    const out = this.buffer
    this.buffer = []
    this.bufferedBytes = 0
    this.opts.onFlush(out)
  }
}
