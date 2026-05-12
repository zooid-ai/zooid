// Shared helper for bringing up the Tuwunel docker-compose fixture on a
// free host port with a unique compose project name. Lets multiple
// integration test files run side-by-side (and side-by-side with the
// user's `zooid dev` on 8448) without port clashes.

import { execSync } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const composeFile = resolve(here, 'docker-compose.yml')

export interface TuwunelHandle {
  /** `http://localhost:<port>` */
  homeserver: string
  /** Stop and remove the container + network. */
  down(): void
}

/** Ask the OS for an unused TCP port by binding to 0 and reading back. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rejectP)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close()
        rejectP(new Error('failed to read free port'))
        return
      }
      const port = addr.port
      srv.close(() => resolveP(port))
    })
  })
}

export async function startTuwunel(): Promise<TuwunelHandle> {
  const port = await findFreePort()
  const project = `zooid-mx-${randomUUID().slice(0, 8)}`
  const env = { ...process.env, TUWUNEL_HOST_PORT: String(port) }
  execSync(`docker compose -f ${composeFile} -p ${project} up -d`, {
    stdio: 'inherit',
    env,
  })
  const homeserver = `http://localhost:${port}`
  await waitFor(`${homeserver}/_matrix/client/versions`, 60_000)
  return {
    homeserver,
    down: () => {
      execSync(`docker compose -f ${composeFile} -p ${project} down -v`, {
        stdio: 'inherit',
        env,
      })
    },
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${url}`)
}
