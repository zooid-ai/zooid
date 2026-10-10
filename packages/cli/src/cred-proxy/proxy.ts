import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname } from 'node:path'
import { CredentialExpiredError, type CodexAuth } from './codex-auth.js'

export interface CredentialProxyHandle {
  socketPath: string
  close(): Promise<void>
}

export interface StartCredentialProxyOptions {
  socketPath: string
  /** Origin, e.g. `https://chatgpt.com`. */
  upstream: string
  allowPaths: string[]
  auth: CodexAuth
  /** For log lines only. */
  agent: string
  log: (line: string) => void
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function endToEnd(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v
  }
  return out
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `zooid credential proxy: ${message}` } }))
}

/**
 * The host side of a vm agent's model access: an HTTP server on a Unix
 * socket that is mounted into the guest. It forwards allow-listed paths to
 * `upstream` with the real credential swapped in, streaming both ways, so
 * the credential never enters the guest. Never logs header values. [ZOD128]
 */
export async function startCredentialProxy(opts: StartCredentialProxyOptions): Promise<CredentialProxyHandle> {
  const origin = new URL(opts.upstream)
  const send = origin.protocol === 'https:' ? httpsRequest : httpRequest

  const server = createServer((req, res) => {
    const started = Date.now()
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    res.on('close', () =>
      opts.log(`[cred-proxy] ${opts.agent} ${method} ${path} → ${res.statusCode} (${Date.now() - started}ms)`),
    )
    if (!opts.allowPaths.some((p) => path.startsWith(p))) {
      req.resume()
      return fail(res, 403, `${method} ${path} is not forwarded`)
    }
    opts.auth.current().then(
      ({ access, accountId }) => {
        const headers = endToEnd(req.headers)
        headers.authorization = `Bearer ${access}`
        headers['chatgpt-account-id'] = accountId
        headers.host = origin.host
        const up = send(
          {
            protocol: origin.protocol,
            hostname: origin.hostname,
            port: origin.port || undefined,
            method,
            path: path + url.search,
            headers,
          },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, endToEnd(upRes.headers))
            upRes.pipe(res)
          },
        )
        up.on('error', () => {
          if (res.headersSent) res.destroy()
          else fail(res, 502, `upstream ${origin.origin} unreachable`)
        })
        res.on('close', () => {
          if (!res.writableFinished) up.destroy()
        })
        req.pipe(up)
      },
      (err: unknown) => {
        req.resume()
        if (err instanceof CredentialExpiredError) fail(res, 401, err.message)
        else fail(res, 502, 'credential lookup failed')
      },
    )
  })

  mkdirSync(dirname(opts.socketPath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(opts.socketPath), 0o700)
  rmSync(opts.socketPath, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  chmodSync(opts.socketPath, 0o600)

  return {
    socketPath: opts.socketPath,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(opts.socketPath, { force: true })
    },
  }
}
