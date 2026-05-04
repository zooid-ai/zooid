import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

const { DockerAcpRuntime } = await import('./docker-acp.js')

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stdin = new Writable({ write(_c, _e, cb) { cb() } })
  stderr = new Readable({ read() {} })
  pid = 1
  kill = vi.fn(() => true)
}

function argvOf(call: number = 0): string[] {
  return spawnMock.mock.calls[call][1] as string[]
}

describe('DockerAcpRuntime', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockReturnValue(new FakeChild())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses docker run --rm -i base flags', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'img:latest' })
    rt.spawn({ command: 'cmd', args: [] })
    expect(spawnMock.mock.calls[0][0]).toBe('docker')
    const argv = argvOf()
    expect(argv.slice(0, 3)).toEqual(['run', '--rm', '-i'])
  })

  it('engine: podman switches the binary from docker to podman', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'img:latest', engine: 'podman' })
    rt.spawn({ command: 'cmd', args: [] })
    expect(spawnMock.mock.calls[0][0]).toBe('podman')
  })

  it('image: spec wins over runtime default', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'default:1' })
    rt.spawn({ command: 'cmd', args: [], image: 'override:2' })
    const argv = argvOf()
    expect(argv).toContain('override:2')
    expect(argv).not.toContain('default:1')
  })

  it('throws if neither spec.image nor defaultImage set', () => {
    const rt = new DockerAcpRuntime({})
    expect(() => rt.spawn({ command: 'cmd', args: [] })).toThrow(/image/i)
  })

  it('emits -e KEY=value for each env entry', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'img' })
    rt.spawn({
      command: 'cmd',
      args: [],
      env: { ANTHROPIC_API_KEY: 'sk', FOO: 'bar' },
    })
    const argv = argvOf()
    expect(argv).toContain('-e')
    expect(argv).toContain('ANTHROPIC_API_KEY=sk')
    expect(argv).toContain('FOO=bar')
  })

  it('emits -v src:tgt:mode for each mount', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'img' })
    rt.spawn({
      command: 'cmd',
      args: [],
      mounts: [
        { path: '/host/a', target: '/c/a', mode: 'ro' },
        { path: '/host/b', target: '/c/b', mode: 'rw' },
      ],
    })
    const argv = argvOf()
    expect(argv).toContain('/host/a:/c/a:ro')
    expect(argv).toContain('/host/b:/c/b:rw')
  })

  it('emits -w <cwd> when cwd is set', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'img' })
    rt.spawn({ command: 'cmd', args: [], cwd: '/workspace' })
    const argv = argvOf()
    const wIdx = argv.indexOf('-w')
    expect(wIdx).toBeGreaterThan(-1)
    expect(argv[wIdx + 1]).toBe('/workspace')
  })

  it('args appear after the image (command is set via --entrypoint)', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'img' })
    rt.spawn({ command: 'opencode', args: ['acp', '--flag'] })
    const argv = argvOf()
    const imgIdx = argv.indexOf('img')
    expect(imgIdx).toBeGreaterThan(-1)
    expect(argv.slice(imgIdx + 1)).toEqual(['acp', '--flag'])
  })

  it('uses --entrypoint to override image entrypoint with spec command', () => {
    const rt = new DockerAcpRuntime({ defaultImage: 'img' })
    rt.spawn({ command: 'opencode', args: ['acp'] })
    const argv = argvOf()
    const epIdx = argv.indexOf('--entrypoint')
    expect(epIdx).toBeGreaterThan(-1)
    expect(argv[epIdx + 1]).toBe('opencode')
  })

  it('returns the ChildProcess from spawn', () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child)
    const rt = new DockerAcpRuntime({ defaultImage: 'img' })
    const result = rt.spawn({ command: 'cmd', args: [] })
    expect(result).toBe(child)
  })
})
