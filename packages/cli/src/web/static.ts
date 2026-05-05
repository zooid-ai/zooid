import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { Hono } from 'hono'

export interface WebStaticOpts {
  webRoot: string
  homeserverUrl: string
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function isAssetPath(p: string): boolean {
  return p.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(p)
}

export function webStatic(opts: WebStaticOpts): Hono {
  const app = new Hono()

  app.get('/config.json', (c) => c.json({ homeserver_url: opts.homeserverUrl }))

  app.get('*', (c) => {
    const url = new URL(c.req.url)
    const requested = decodeURIComponent(url.pathname)
    const wantFile = requested === '/' ? '/index.html' : requested

    const safe = normalize(wantFile).replace(/^(\.\.[/\\])+/g, '')
    const filePath = join(opts.webRoot, safe)
    if (!filePath.startsWith(opts.webRoot)) return c.notFound()

    try {
      const stat = statSync(filePath)
      if (stat.isFile()) {
        const body = readFileSync(filePath)
        const ct = MIME[extname(filePath)] ?? 'application/octet-stream'
        return c.body(body as unknown as ArrayBuffer, 200, { 'content-type': ct })
      }
    } catch {
      // fall through to history fallback
    }

    if (isAssetPath(requested)) return c.notFound()
    const indexBytes = readFileSync(join(opts.webRoot, 'index.html'))
    return c.body(indexBytes as unknown as ArrayBuffer, 200, {
      'content-type': MIME['.html']!,
    })
  })

  return app
}
