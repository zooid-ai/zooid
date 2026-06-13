import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AddressInfo } from 'node:net'
import { fetchWebBundle } from './fetch.js'
import { makeBundleTgz } from './test-helpers.js'

let server: Server
let base = ''
const { tgz, integrity } = makeBundleTgz({
  'package/package.json': '{"name":"@zooid/zoon-web"}',
  'package/dist/index.html': '<html>integration</html>',
})

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/@zooid/zoon-web') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          versions: {
            '0.1.0': {
              dist: { tarball: `${base}/@zooid/zoon-web/-/zoon-web-0.1.0.tgz`, integrity },
            },
          },
        }),
      )
      return
    }
    if (req.url === '/@zooid/zoon-web/-/zoon-web-0.1.0.tgz') {
      res.setHeader('content-type', 'application/octet-stream')
      res.end(tgz)
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('fetchWebBundle over real HTTP', () => {
  it('fetches, verifies, extracts, and serves from cache on rerun', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'zooid-webint-'))
    try {
      const root = await fetchWebBundle({ version: '0.1.0', cacheDir, registryUrl: base })
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html>integration</html>')

      const serverPort = (server.address() as AddressInfo).port
      const newBase = `http://127.0.0.1:${serverPort}`
      const again = await fetchWebBundle({ version: '0.1.0', cacheDir, registryUrl: newBase })
      expect(again).toBe(root)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  }, 30_000)
})
