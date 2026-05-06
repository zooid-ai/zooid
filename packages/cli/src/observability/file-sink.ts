import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Verbosity = 'default' | 'verbose-thoughts' | 'verbose'

export interface JsonlSinkOpts {
  /** Truncate any single string field longer than this. Default 4 KB. */
  maxStringLen?: number
}

const TRUNC_MARKER = '…[truncated]'

export class JsonlSink {
  private stream: WriteStream | null = null
  private readonly maxStringLen: number
  private readonly readyPromise: Promise<void>

  constructor(
    private readonly path: string,
    opts: JsonlSinkOpts = {},
  ) {
    this.maxStringLen = opts.maxStringLen ?? 4096
    this.readyPromise = (async () => {
      await mkdir(dirname(this.path), { recursive: true })
      this.stream = createWriteStream(this.path, { flags: 'a' })
    })()
  }

  async write(obj: unknown): Promise<void> {
    await this.readyPromise
    const capped = capStrings(obj, this.maxStringLen)
    const line = JSON.stringify(capped) + '\n'
    return new Promise((resolve, reject) => {
      this.stream!.write(line, (err) => (err ? reject(err) : resolve()))
    })
  }

  async close(): Promise<void> {
    await this.readyPromise
    return new Promise((resolve) => {
      this.stream!.end(() => resolve())
    })
  }
}

function capStrings(v: unknown, max: number): unknown {
  if (typeof v === 'string') {
    return v.length <= max ? v : v.slice(0, max) + TRUNC_MARKER
  }
  if (Array.isArray(v)) return v.map((x) => capStrings(x, max))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = capStrings(val, max)
    return out
  }
  return v
}

const DEFAULT_VARIANTS = new Set([
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'user_message_chunk',
])

export function shouldCaptureUpdate(
  verbosity: Verbosity,
  variant: string,
): boolean {
  if (verbosity === 'verbose') return true
  if (verbosity === 'verbose-thoughts') {
    return DEFAULT_VARIANTS.has(variant) || variant === 'agent_thought_chunk'
  }
  return DEFAULT_VARIANTS.has(variant)
}
