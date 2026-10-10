import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// No real docker from tests: spawn and execFile are fully mocked.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  inspect: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: (_bin: string, args: string[]) => mocks.inspect(args),
  })
  return { spawn: mocks.spawn, execFile }
})

import { buildRunArgs, TuwunelService } from './tuwunel.js'

describe('buildRunArgs', () => {
  const base = {
    name: 'zooid-tuwunel',
    image: 'ghcr.io/matrix-construct/tuwunel:v1.9.3',
    hostPort: 8448,
    paths: {
      dataDir: '/abs/data/matrix',
      dbDir: '/abs/data/matrix/db',
      mediaDir: '/abs/data/matrix/media',
      configDir: '/abs/data/matrix/config',
      registrationsDir: '/abs/data/matrix/config/registrations',
      tuwunelTomlPath: '/abs/data/matrix/config/tuwunel.toml',
      appserviceYamlPath: '/abs/data/matrix/config/registrations/zooid.yaml',
      envPath: '/abs/data/matrix/config/.env',
    },
  }

  it('uses docker by default, mounts persistent volumes and config read-only', () => {
    const args = buildRunArgs({ ...base, engine: 'docker' })
    expect(args[0]).toBe('run')
    expect(args).toContain('--rm')
    // Foregrounded so the parent process owns Tuwunel's stdio (logs).
    expect(args).not.toContain('-d')
    expect(args).toContain('--name')
    expect(args).toContain('zooid-tuwunel')
    expect(args).toContain('-p')
    expect(args).toContain('8448:8448')
    expect(args).toContain('/abs/data/matrix/db:/var/lib/tuwunel/db')
    expect(args).toContain('/abs/data/matrix/media:/var/lib/tuwunel/media')
    expect(args).toContain(
      '/abs/data/matrix/config/tuwunel.toml:/etc/tuwunel/tuwunel.toml:ro',
    )
    expect(args).toContain(
      '/abs/data/matrix/config/registrations:/var/lib/tuwunel/registrations:ro',
    )
    // ZOD041 deliberately does NOT mount ${dataRoot}/logs into the container.
    // Today the daemon captures tuwunel's stdout/stderr via captureChildToFile
    // — there's no internal tuwunel log directive yet. A future cycle that flips
    // tuwunel.toml to write its own logs can add the mount alongside that change.
    expect(args.some((a) => a.endsWith(':/var/log/tuwunel'))).toBe(false)
    expect(args).toContain('TUWUNEL_CONFIG=/etc/tuwunel/tuwunel.toml')
    expect(args[args.length - 1]).toBe(base.image)
  })

  it('engine: podman switches the binary (caller chooses), args are identical', () => {
    const docker = buildRunArgs({ ...base, engine: 'docker' })
    const podman = buildRunArgs({ ...base, engine: 'podman' })
    expect(podman).toEqual(docker)
  })

  it('honors a custom container name and host port', () => {
    const args = buildRunArgs({
      ...base,
      name: 'my-zooid-tuwunel',
      hostPort: 9000,
      engine: 'docker',
    })
    expect(args).toContain('my-zooid-tuwunel')
    expect(args).toContain('9000:8448')
  })
})

describe('TuwunelService startup', () => {
  const opts = {
    name: 'zooid-tuwunel',
    hostPort: 8448,
    engine: 'docker' as const,
    paths: {
      dataDir: '/d',
      dbDir: '/d/db',
      mediaDir: '/d/media',
      configDir: '/d/config',
      registrationsDir: '/d/config/registrations',
      tuwunelTomlPath: '/d/config/tuwunel.toml',
      appserviceYamlPath: '/d/config/registrations/zooid.yaml',
      envPath: '/d/config/.env',
    },
  }

  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    exitCode: number | null = null
    kill = vi.fn()
    exit(code: number): void {
      this.exitCode = code
      this.emit('exit', code, null)
    }
  }

  let runChild: FakeChild
  let calls: string[][]
  let containerState: string | null

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    calls = []
    containerState = null
    runChild = new FakeChild()
    mocks.spawn.mockReset()
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'run') return runChild
      // rm / stop succeed immediately
      const c = new FakeChild()
      queueMicrotask(() => c.exit(0))
      return c
    })
    mocks.inspect.mockReset()
    mocks.inspect.mockImplementation(async () => {
      if (containerState === null) throw new Error('No such container')
      return { stdout: `${containerState}|0|\n` }
    })
  })

  it('prepare(): no existing container -> nothing removed', async () => {
    await new TuwunelService(opts).prepare()
    expect(calls).toEqual([])
  })

  it.each(['created', 'exited'])(
    'prepare(): removes a stale %s container',
    async (state) => {
      containerState = state
      await new TuwunelService(opts).prepare()
      expect(calls).toEqual([['rm', 'zooid-tuwunel']])
    },
  )

  it('prepare(): refuses to touch a running container', async () => {
    containerState = 'running'
    await expect(new TuwunelService(opts).prepare()).rejects.toThrow(
      /already running.*docker stop zooid-tuwunel/s,
    )
    expect(calls).toEqual([])
  })

  it('waitHealthy(): fails at once with stderr + exit code when run exits early', async () => {
    const svc = new TuwunelService(opts)
    svc.start()
    const waiting = svc.waitHealthy({ url: 'http://x', timeoutMs: 60_000 })
    const settled = waiting.then(
      () => 'ok',
      (e: Error) => e,
    )
    runChild.stderr.emit(
      'data',
      Buffer.from('docker: Error response from daemon: Conflict. The container name "/zooid-tuwunel" is already in use'),
    )
    runChild.exit(125)
    const err = (await settled) as Error
    expect(err.message).toMatch(/exit=125/)
    expect(err.message).toMatch(/Conflict/)
    expect(err.message).not.toMatch(/did not become healthy/)
  })

  it('waitHealthy(): early exit during the HTTP phase also fails immediately', async () => {
    containerState = 'running'
    const svc = new TuwunelService(opts)
    svc.start()
    const waiting = svc.waitHealthy({ url: 'http://x', timeoutMs: 60_000 })
    const settled = waiting.then(
      () => 'ok',
      (e: Error) => e,
    )
    await new Promise((r) => setTimeout(r, 20))
    runChild.exit(1)
    expect(((await settled) as Error).message).toMatch(/exit=1/)
  })

  it('waitHealthy(): refuses to poll when start() was never called', async () => {
    await expect(
      new TuwunelService(opts).waitHealthy({ url: 'http://x', timeoutMs: 1000 }),
    ).rejects.toThrow(/before start/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('waitHealthy(): resolves once running and /versions answers', async () => {
    containerState = 'running'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const svc = new TuwunelService(opts)
    svc.start()
    await expect(
      svc.waitHealthy({ url: 'http://x', timeoutMs: 5000 }),
    ).resolves.toBeUndefined()
  })
})
