// Shared helper for bringing up the Tuwunel docker-compose fixture on a
// free host port with a unique compose project name. Lets multiple
// integration test files run side-by-side (and side-by-side with the
// user's `zooid dev` on 8448) without port clashes.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)

const here = dirname(fileURLToPath(import.meta.url))
const composeFile = resolve(here, 'docker-compose.yml')

export interface TuwunelHandle {
  /** `http://localhost:<port>` */
  homeserver: string
  /** Stop and remove the container + network. Idempotent. */
  down(): Promise<void>
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

// Run compose out-of-process and unblocked. This used to be execSync, which
// pinned the worker thread for the whole call — vitest cannot apply a hook
// timeout while the thread is blocked, so a slow teardown surfaced as
// "Hook timed out in 30000ms" on work that had in fact completed.
// Passing argv (rather than an interpolated string) also survives a repo
// checked out under a path with spaces.
function compose(project: string, port: number, args: string[]) {
  return execFileP('docker', ['compose', '-f', composeFile, '-p', project, ...args], {
    env: { ...process.env, TUWUNEL_HOST_PORT: String(port) },
  })
}

function composeDown(project: string, port: number) {
  // Graceful stop on purpose. `-t 0` (straight to SIGKILL) shaves about a
  // second and is not worth it: docker cannot SIGKILL a container whose PID 1
  // has zombied, which fails teardown outright. The compose file sets
  // `init: true` so signals are forwarded and children reaped either way.
  return compose(project, port, ['down', '-v'])
}

export async function startTuwunel(): Promise<TuwunelHandle> {
  const project = `zooid-mx-${randomUUID().slice(0, 8)}`

  // findFreePort has an unavoidable race: it releases the port before compose
  // binds it, so a sibling test file (or anything else on the box) can take it
  // in between. Losing that race used to fail beforeAll outright, and because
  // the handle was never assigned, afterAll's `tuwunel?.down()` no-oped and
  // stranded the container in `created` state forever. Retry on a fresh port,
  // cleaning up the failed attempt first.
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await findFreePort()

    try {
      await compose(project, port, ['up', '-d'])
    } catch (err) {
      lastErr = err
      await composeDown(project, port).catch(() => {})
      continue
    }

    try {
      await waitFor(`http://localhost:${port}/_matrix/client/versions`, 60_000)
    } catch (err) {
      // It started but never served. That is a real failure rather than a
      // port race, so don't retry — but it is still ours to clean up.
      await composeDown(project, port).catch(() => {})
      throw err
    }

    let torn = false
    return {
      homeserver: `http://localhost:${port}`,
      down: async () => {
        if (torn) return
        torn = true
        await composeDown(project, port)
      },
    }
  }

  throw new Error(`docker compose up failed after 3 attempts: ${lastErr}`)
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
