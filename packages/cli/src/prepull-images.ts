import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

export interface PrepullExec {
  (cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface PrepullOptions {
  engine: 'docker' | 'podman'
  runtime: 'local' | 'docker' | 'podman'
  /** Injectable for tests. Defaults to a child_process.execFile-backed exec. */
  exec?: PrepullExec
  /** When true, skip the inspect check and pull every image. */
  refresh?: boolean
  /** When true, the function returns immediately without touching the engine. */
  skip?: boolean
  log?: (line: string) => void
}

export interface PrepullableRegistry {
  agentNames(): string[]
  resolveSpawnImage(name: string): string | undefined
}

/**
 * Walk the registry's unique resolved-image set, `<engine> image inspect`
 * each one, and `<engine> pull` the ones not cached locally. Parallel and
 * fail-fast: any pull exit ≠ 0 throws with the engine's stderr embedded.
 * No-op when `opts.skip` or `opts.runtime === 'local'`.
 */
export async function prepullImages(
  registry: PrepullableRegistry,
  opts: PrepullOptions,
): Promise<void> {
  if (opts.skip || opts.runtime === 'local') return
  const exec = opts.exec ?? defaultExec
  const log = opts.log ?? ((l: string) => console.log(l))

  const images = new Set<string>()
  for (const name of registry.agentNames()) {
    const img = registry.resolveSpawnImage(name)
    if (img) images.add(img)
  }

  const toPull: string[] = []
  let cached = 0
  if (opts.refresh) {
    toPull.push(...images)
  } else {
    await Promise.all(
      [...images].map(async (img) => {
        const r = await exec(opts.engine, ['image', 'inspect', img])
        if (r.code === 0) cached++
        else toPull.push(img)
      }),
    )
  }

  log(
    `[zooid] image prepull: ${images.size} unique images (${cached} cached, ${toPull.length} to pull)`,
  )
  if (toPull.length === 0) return

  await Promise.all(
    toPull.map(async (img) => {
      log(`[zooid]   ${img}  pulling…`)
      const start = Date.now()
      const r = await exec(opts.engine, ['pull', img])
      const secs = ((Date.now() - start) / 1000).toFixed(1)
      if (r.code !== 0) {
        throw new Error(
          `image prepull failed for ${img}:\n${r.stderr.trim() || '(no stderr)'}`,
        )
      }
      log(`[zooid]   ${img}  ✓ ${secs}s`)
    }),
  )
}

const defaultExec: PrepullExec = async (cmd, args) => {
  try {
    const { stdout, stderr } = await pExecFile(cmd, args, {
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string
      stderr?: string
    }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(e),
    }
  }
}
