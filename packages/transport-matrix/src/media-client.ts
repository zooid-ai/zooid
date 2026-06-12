/** Limits are routing policy, not enforcement — see ZOD057 (enforcement lives
 *  in Tuwunel config + the Zoon composer). */
export const MAX_INLINE_IMAGE_BYTES = 524_288
export const INLINE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const MAX_DOWNLOAD_BYTES = 33_554_432

export interface MediaClientOptions {
  homeserver: string
  asToken: string
  fetch?: typeof globalThis.fetch
}

export function parseMxcUri(uri: string): { serverName: string; mediaId: string } | null {
  const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(uri)
  return m ? { serverName: m[1], mediaId: m[2] } : null
}

export class MediaClient {
  private readonly homeserver: string
  private readonly asToken: string
  private readonly fetch: typeof globalThis.fetch

  constructor(opts: MediaClientOptions) {
    this.homeserver = opts.homeserver.replace(/\/$/, '')
    this.asToken = opts.asToken
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  async download(input: {
    mxcUri: string
    asUserId: string
    maxBytes?: number
  }): Promise<{ data: Uint8Array; contentType: string }> {
    const parsed = parseMxcUri(input.mxcUri)
    if (!parsed) throw new Error(`not an mxc uri: ${input.mxcUri}`)
    const url =
      `${this.homeserver}/_matrix/client/v1/media/download/` +
      `${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}` +
      `?user_id=${encodeURIComponent(input.asUserId)}`
    const r = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.asToken}` },
    })
    if (!r.ok) throw new Error(`media download failed: ${r.status}`)
    const buf = new Uint8Array(await r.arrayBuffer())
    const max = input.maxBytes ?? MAX_DOWNLOAD_BYTES
    if (buf.byteLength > max) {
      throw new Error(`media too large: ${buf.byteLength} > ${max}`)
    }
    return { data: buf, contentType: r.headers.get('content-type') ?? 'application/octet-stream' }
  }

  async upload(input: {
    data: Uint8Array
    contentType: string
    filename?: string
    asUserId: string
  }): Promise<{ content_uri: string }> {
    const params = new URLSearchParams()
    if (input.filename) params.set('filename', input.filename)
    params.set('user_id', input.asUserId)
    const r = await this.fetch(`${this.homeserver}/_matrix/media/v3/upload?${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.asToken}`, 'Content-Type': input.contentType },
      body: input.data,
    })
    if (!r.ok) throw new Error(`media upload failed: ${r.status}`)
    return (await r.json()) as { content_uri: string }
  }
}
