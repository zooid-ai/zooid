import { describe, it, expect, vi } from 'vitest'
import {
  MediaClient,
  parseMxcUri,
  MAX_INLINE_IMAGE_BYTES,
  INLINE_IMAGE_MIMES,
} from './media-client.js'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function fakeFetch(response: Partial<Response> & { body?: Uint8Array; json?: unknown }) {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    headers: new Headers(response.headers ?? { 'content-type': 'image/png' }),
    arrayBuffer: async () => {
      const buf = response.body ?? TINY_PNG
      // Use byteOffset/byteLength so the slice covers exactly the bytes the Buffer references.
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    },
    json: async () => response.json ?? {},
    text: async () => '',
  })) as unknown as typeof fetch
}

describe('parseMxcUri', () => {
  it('splits server name and media id', () => {
    expect(parseMxcUri('mxc://localhost/AbCd1234')).toEqual({
      serverName: 'localhost',
      mediaId: 'AbCd1234',
    })
  })

  it('returns null for non-mxc uris', () => {
    expect(parseMxcUri('https://example.com/x.png')).toBeNull()
    expect(parseMxcUri('mxc://missing-id')).toBeNull()
  })
})

describe('MediaClient.download', () => {
  it('GETs the authenticated v1 endpoint with AS token and user_id', async () => {
    const f = fakeFetch({ body: TINY_PNG })
    const media = new MediaClient({ homeserver: 'http://hs', asToken: 'tok', fetch: f })
    const out = await media.download({ mxcUri: 'mxc://localhost/abc', asUserId: '@dev:localhost' })

    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://hs/_matrix/client/v1/media/download/localhost/abc?user_id=%40dev%3Alocalhost',
    )
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(Buffer.from(out.data).equals(TINY_PNG)).toBe(true)
    expect(out.contentType).toBe('image/png')
  })

  it('rejects bodies larger than maxBytes', async () => {
    const big = new Uint8Array(64)
    const f = fakeFetch({ body: big })
    const media = new MediaClient({ homeserver: 'http://hs', asToken: 'tok', fetch: f })
    await expect(
      media.download({ mxcUri: 'mxc://localhost/abc', asUserId: '@dev:localhost', maxBytes: 16 }),
    ).rejects.toThrow(/too large/i)
  })

  it('throws on non-OK responses with status in the message', async () => {
    const f = fakeFetch({ ok: false, status: 404 })
    const media = new MediaClient({ homeserver: 'http://hs', asToken: 'tok', fetch: f })
    await expect(
      media.download({ mxcUri: 'mxc://localhost/gone', asUserId: '@dev:localhost' }),
    ).rejects.toThrow(/404/)
  })
})

describe('MediaClient.upload', () => {
  it('POSTs raw bytes to /_matrix/media/v3/upload with filename and user_id', async () => {
    const f = fakeFetch({ json: { content_uri: 'mxc://localhost/up1' } })
    const media = new MediaClient({ homeserver: 'http://hs', asToken: 'tok', fetch: f })
    const out = await media.upload({
      data: TINY_PNG,
      contentType: 'image/png',
      filename: 'shot.png',
      asUserId: '@dev:localhost',
    })

    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://hs/_matrix/media/v3/upload?filename=shot.png&user_id=%40dev%3Alocalhost')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    expect(out.content_uri).toBe('mxc://localhost/up1')
  })
})

describe('inline routing constants', () => {
  it('caps inline images at 0.5 MB and allowlists model-consumable mimes', () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(524_288)
    expect(INLINE_IMAGE_MIMES).toContain('image/png')
    expect(INLINE_IMAGE_MIMES).toContain('image/jpeg')
    expect(INLINE_IMAGE_MIMES).not.toContain('image/svg+xml')
  })
})
