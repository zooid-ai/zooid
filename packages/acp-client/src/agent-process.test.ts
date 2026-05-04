import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

const { AgentProcess } = await import('./agent-process.js')

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({
    write(_c, _e, cb) {
      cb()
    },
  })
  stderr = new Readable({ read() {} })
  pid = 12345
  kill = vi.fn(() => true)
}

describe('AgentProcess', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns the configured command with args, piped stdio, and env', () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const proc = new AgentProcess({
      command: 'opencode',
      args: ['acp'],
      env: { OPENAI_API_KEY: 'sk-test' },
      cwd: '/workspace',
    })
    proc.start()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = spawnMock.mock.calls[0]
    expect(cmd).toBe('opencode')
    expect(args).toEqual(['acp'])
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(options.env).toMatchObject({ OPENAI_API_KEY: 'sk-test' })
    expect(options.cwd).toBe('/workspace')
  })

  it('exposes stdout and stdin streams from the spawned child', () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const proc = new AgentProcess({ command: 'x', args: [] })
    proc.start()

    expect(proc.stdout).toBe(child.stdout)
    expect(proc.stdin).toBe(child.stdin)
  })

  it('emits "exit" with code when the child exits', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const proc = new AgentProcess({ command: 'x', args: [] })
    proc.start()

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on('exit', resolve)
    })
    child.emit('exit', 0, null)
    await expect(exitPromise).resolves.toBe(0)
  })

  it('kill() forwards SIGTERM to the child', () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const proc = new AgentProcess({ command: 'x', args: [] })
    proc.start()
    proc.kill()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('inherits parent env unless inheritEnv is false', () => {
    process.env.FROM_PARENT = 'yes'
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)

    const proc = new AgentProcess({ command: 'x', args: [], env: { EXTRA: '1' } })
    proc.start()

    const [, , options] = spawnMock.mock.calls[0]
    expect(options.env.FROM_PARENT).toBe('yes')
    expect(options.env.EXTRA).toBe('1')
    delete process.env.FROM_PARENT
  })
})
