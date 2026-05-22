import { describe, it, expect, vi } from 'vitest'
import { prepullImages } from './prepull-images.js'

type Call = { argv: string[] }

function mkExec(
  plan: Record<
    string,
    { inspectExit: number; pullExit?: number; pullStderr?: string }
  >,
) {
  const calls: Call[] = []
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ argv: [cmd, ...args] })
    const op = args[0] === 'image' ? 'inspect' : 'pull'
    const image = op === 'inspect' ? args[2] : args[1]
    const entry = plan[image!]
    if (!entry) throw new Error(`unexpected image: ${image}`)
    if (op === 'inspect') {
      return { code: entry.inspectExit, stdout: '', stderr: '' }
    }
    return { code: entry.pullExit ?? 0, stdout: '', stderr: entry.pullStderr ?? '' }
  })
  return { exec, calls }
}

const mkRegistry = (imagesByAgent: Record<string, string | undefined>) => ({
  resolveSpawnImage: (n: string) => imagesByAgent[n],
  agentNames: () => Object.keys(imagesByAgent),
})

describe('prepullImages', () => {
  it('skips locally cached images (inspect exit 0)', async () => {
    const { exec, calls } = mkExec({
      'ghcr.io/zooid-ai/agent-claude:latest': { inspectExit: 0 },
    })
    const lines: string[] = []
    await prepullImages(
      mkRegistry({ alice: 'ghcr.io/zooid-ai/agent-claude:latest' }) as any,
      {
        engine: 'docker',
        runtime: 'docker',
        exec,
        log: (l) => lines.push(l),
      },
    )
    expect(calls.filter((c) => c.argv.includes('pull'))).toHaveLength(0)
    expect(lines.some((l) => /1 unique images \(1 cached, 0 to pull\)/.test(l))).toBe(
      true,
    )
  })

  it('pulls only missing images (inspect exit non-zero → pull)', async () => {
    const { exec, calls } = mkExec({
      'cached:1': { inspectExit: 0 },
      'missing:1': { inspectExit: 1, pullExit: 0 },
    })
    const lines: string[] = []
    await prepullImages(
      mkRegistry({ a: 'cached:1', b: 'missing:1' }) as any,
      { engine: 'docker', runtime: 'docker', exec, log: (l) => lines.push(l) },
    )
    const pulls = calls.filter((c) => c.argv.includes('pull')).map((c) => c.argv[2])
    expect(pulls).toEqual(['missing:1'])
    expect(lines.some((l) => /1 cached, 1 to pull/.test(l))).toBe(true)
    expect(lines.some((l) => /missing:1.*✓/.test(l))).toBe(true)
  })

  it('dedupes by image — five agents on the same image pull once', async () => {
    const { exec, calls } = mkExec({
      'shared:1': { inspectExit: 1, pullExit: 0 },
    })
    await prepullImages(
      mkRegistry({
        a: 'shared:1',
        b: 'shared:1',
        c: 'shared:1',
        d: 'shared:1',
        e: 'shared:1',
      }) as any,
      { engine: 'docker', runtime: 'docker', exec, log: () => {} },
    )
    expect(calls.filter((c) => c.argv.includes('pull'))).toHaveLength(1)
  })

  it('refresh=true skips the inspect check and pulls every image', async () => {
    const { exec, calls } = mkExec({
      'a:1': { inspectExit: 0, pullExit: 0 },
      'b:1': { inspectExit: 0, pullExit: 0 },
    })
    await prepullImages(mkRegistry({ x: 'a:1', y: 'b:1' }) as any, {
      engine: 'docker',
      runtime: 'docker',
      exec,
      refresh: true,
      log: () => {},
    })
    expect(calls.filter((c) => c.argv.includes('inspect'))).toHaveLength(0)
    expect(calls.filter((c) => c.argv.includes('pull'))).toHaveLength(2)
  })

  it('fail-fast: pull exit non-zero throws with engine stderr embedded', async () => {
    const { exec } = mkExec({
      'broken:1': { inspectExit: 1, pullExit: 1, pullStderr: 'manifest unknown' },
    })
    await expect(
      prepullImages(mkRegistry({ a: 'broken:1' }) as any, {
        engine: 'docker',
        runtime: 'docker',
        exec,
        log: () => {},
      }),
    ).rejects.toThrow(/broken:1[\s\S]*manifest unknown/)
  })

  it('skip=true is a no-op (returns immediately, no exec calls)', async () => {
    const { exec, calls } = mkExec({})
    await prepullImages(mkRegistry({ a: 'whatever:1' }) as any, {
      engine: 'docker',
      runtime: 'docker',
      exec,
      skip: true,
      log: () => {},
    })
    expect(calls).toHaveLength(0)
  })

  it('runtime: local is a no-op regardless of opts', async () => {
    const { exec, calls } = mkExec({})
    await prepullImages(mkRegistry({ a: 'whatever:1' }) as any, {
      engine: 'docker',
      runtime: 'local',
      exec,
      log: () => {},
    })
    expect(calls).toHaveLength(0)
  })

  it('uses the configured engine (podman) in argv', async () => {
    const { exec, calls } = mkExec({ 'x:1': { inspectExit: 1, pullExit: 0 } })
    await prepullImages(mkRegistry({ a: 'x:1' }) as any, {
      engine: 'podman',
      runtime: 'podman',
      exec,
      log: () => {},
    })
    expect(calls.every((c) => c.argv[0] === 'podman')).toBe(true)
  })
})
