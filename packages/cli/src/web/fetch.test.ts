import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchWebBundle } from './fetch.js'
import { makeBundleTgz } from './test-helpers.js'

function registryFetch(opts: { tgz: Buffer; integrity: string; version?: string }) {
  const version = opts.version ?? '0.1.0'
  return vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u === 'https://registry.npmjs.org/@zooid/zoon-web') {
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: version },
          versions: {
            [version]: {
              dist: {
                tarball: `https://registry.npmjs.org/@zooid/zoon-web/-/zoon-web-${version}.tgz`,
                integrity: opts.integrity,
              },
            },
          },
        }),
        { status: 200 },
      )
    }
    if (u.endsWith(`/zoon-web-${version}.tgz`)) {
      return new Response(new Uint8Array(opts.tgz), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

describe('fetchWebBundle', () => {
  let cacheDir: string
  const setup = () => (cacheDir = mkdtempSync(join(tmpdir(), 'zooid-webcache-')))
  const teardown = () => rmSync(cacheDir, { recursive: true, force: true })

  it('downloads, verifies, extracts dist/ into <cacheDir>/<version>', async () => {
    setup()
    try {
      const { tgz, integrity } = makeBundleTgz()
      const f = registryFetch({ tgz, integrity })
      const root = await fetchWebBundle({ version: '0.1.0', cacheDir, fetch: f })
      expect(root).toBe(join(cacheDir, '0.1.0'))
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html>zoon</html>')
      expect(readFileSync(join(root, 'assets', 'app.js'), 'utf8')).toBe('// app')
    } finally {
      teardown()
    }
  })

  it('returns the cache on a second call without touching the network', async () => {
    setup()
    try {
      const { tgz, integrity } = makeBundleTgz()
      const f = registryFetch({ tgz, integrity })
      await fetchWebBundle({ version: '0.1.0', cacheDir, fetch: f })
      const fCold = vi.fn() as unknown as typeof fetch
      const root = await fetchWebBundle({ version: '0.1.0', cacheDir, fetch: fCold })
      expect(root).toBe(join(cacheDir, '0.1.0'))
      expect(fCold).not.toHaveBeenCalled()
    } finally {
      teardown()
    }
  })

  it('rejects on integrity mismatch and leaves no version dir behind', async () => {
    setup()
    try {
      const { tgz } = makeBundleTgz()
      const f = registryFetch({ tgz, integrity: 'sha512-' + 'A'.repeat(88) })
      await expect(fetchWebBundle({ version: '0.1.0', cacheDir, fetch: f })).rejects.toThrow(
        /integrity/i,
      )
      expect(existsSync(join(cacheDir, '0.1.0'))).toBe(false)
    } finally {
      teardown()
    }
  })

  it('fails with an actionable error when the pinned version is not on the registry', async () => {
    setup()
    try {
      const { tgz, integrity } = makeBundleTgz()
      const f = registryFetch({ tgz, integrity, version: '0.0.9' })
      await expect(fetchWebBundle({ version: '0.1.0', cacheDir, fetch: f })).rejects.toThrow(
        /@zooid\/zoon-web@0\.1\.0/,
      )
    } finally {
      teardown()
    }
  })

  it('names the cache path and the env override when the network is down', async () => {
    setup()
    try {
      const f = vi.fn(async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
      await expect(fetchWebBundle({ version: '0.1.0', cacheDir, fetch: f })).rejects.toThrow(
        /ZOOID_DEV_WEB_ROOT_OVERRIDE/,
      )
    } finally {
      teardown()
    }
  })

  it('prunes other version dirs after a successful fetch', async () => {
    setup()
    try {
      const stale = join(cacheDir, '0.0.9')
      mkdirSync(stale, { recursive: true })
      writeFileSync(join(stale, 'index.html'), 'old')
      const { tgz, integrity } = makeBundleTgz()
      await fetchWebBundle({ version: '0.1.0', cacheDir, fetch: registryFetch({ tgz, integrity }) })
      expect(readdirSync(cacheDir).sort()).toEqual(['0.1.0'])
    } finally {
      teardown()
    }
  })

  it('does not treat a half-extracted dir as a cache hit', async () => {
    setup()
    try {
      // a version dir without the completion marker = crashed mid-extract
      const partial = join(cacheDir, '0.1.0')
      mkdirSync(partial, { recursive: true })
      const { tgz, integrity } = makeBundleTgz()
      const f = registryFetch({ tgz, integrity })
      const root = await fetchWebBundle({ version: '0.1.0', cacheDir, fetch: f })
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html>zoon</html>')
      expect(f).toHaveBeenCalled()
    } finally {
      teardown()
    }
  })
})
