import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface WebWatchHandle {
  distPath: string
  // Pipe captured child output onwards. Call once Listr / interactive
  // renderers are done, otherwise vite output will get garbled.
  attachStdio: () => void
  stop: () => Promise<void>
}

export interface WebWatchOpts {
  webPackageDir: string
  // Wait up to this many ms for vite's first build to finish before resolving.
  firstBuildTimeoutMs?: number
}

// Spawns `vite build --watch` in webPackageDir and resolves once the first
// build has completed (detected via index.html mtime > spawn time).
export async function startWebWatch(opts: WebWatchOpts): Promise<WebWatchHandle> {
  const distPath = join(opts.webPackageDir, 'dist')
  const indexPath = join(distPath, 'index.html')
  const timeoutMs = opts.firstBuildTimeoutMs ?? 60_000
  const spawnTime = Date.now()

  const child: ChildProcess = spawn(
    'pnpm',
    ['-C', opts.webPackageDir, 'exec', 'vite', 'build', '--watch'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let buffered = ''
  const onData = (chunk: Buffer): void => {
    buffered += chunk.toString('utf8')
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  let attached = false
  const attachStdio = (): void => {
    if (attached) return
    attached = true
    child.stdout?.off('data', onData)
    child.stderr?.off('data', onData)
    if (buffered) process.stdout.write(buffered)
    buffered = ''
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
  }

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  while (Date.now() - spawnTime < timeoutMs) {
    if (exited) {
      attachStdio()
      throw new Error(`vite build --watch exited before first build (code ${child.exitCode})`)
    }
    if (existsSync(indexPath)) {
      const m = statSync(indexPath).mtimeMs
      // Slack for clock granularity on macOS HFS+/APFS.
      if (m >= spawnTime - 500) return makeHandle()
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  // Timed out: clean up and surface what vite said.
  attachStdio()
  await stopChild(child)
  throw new Error(`vite build --watch did not produce ${indexPath} within ${timeoutMs}ms`)

  function makeHandle(): WebWatchHandle {
    return {
      distPath,
      attachStdio,
      stop: () => stopChild(child),
    }
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    child.once('exit', finish)
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish()
    }, 2000)
  })
}
