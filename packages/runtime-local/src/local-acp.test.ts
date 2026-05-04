import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

const { LocalAcpRuntime } = await import('./local-acp.js')

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c, _e, cb) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

describe('LocalAcpRuntime', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockReturnValue(new FakeChild())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns command + args verbatim with piped stdio', () => {
    const rt = new LocalAcpRuntime()
    rt.spawn({ command: 'opencode', args: ['acp'] })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = spawnMock.mock.calls[0]
    expect(cmd).toBe('opencode')
    expect(args).toEqual(['acp'])
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
  })

  it('forwards cwd', () => {
    const rt = new LocalAcpRuntime()
    rt.spawn({ command: 'x', args: [], cwd: '/workspace' })
    expect(spawnMock.mock.calls[0][2].cwd).toBe('/workspace')
  })

  it('merges process.env first, spec.env wins', () => {
    process.env.FROM_PARENT = 'yes'
    process.env.OVERRIDE_ME = 'parent'
    const rt = new LocalAcpRuntime()
    rt.spawn({
      command: 'x',
      args: [],
      env: { OVERRIDE_ME: 'spec', EXTRA: '1' },
    })
    const env = spawnMock.mock.calls[0][2].env
    expect(env.FROM_PARENT).toBe('yes')
    expect(env.OVERRIDE_ME).toBe('spec')
    expect(env.EXTRA).toBe('1')
    delete process.env.FROM_PARENT
    delete process.env.OVERRIDE_ME
  })

  it('ignores image and mounts on the spec (host runtime has no container)', () => {
    const rt = new LocalAcpRuntime()
    rt.spawn({
      command: 'x',
      args: [],
      image: 'should-be-ignored',
      mounts: [{ path: '/h', target: '/c', mode: 'ro' }],
    })
    const [cmd, args] = spawnMock.mock.calls[0]
    expect(cmd).toBe('x')
    expect(args).toEqual([])
  })

  it('returns the ChildProcess from spawn', () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const rt = new LocalAcpRuntime()
    const result = rt.spawn({ command: 'x', args: [] })
    expect(result).toBe(child)
  })
})
