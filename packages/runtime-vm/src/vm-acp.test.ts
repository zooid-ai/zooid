import { describe, it, expect } from 'vitest'
import { VmAcpRuntime } from './vm-acp.js'

describe('VmAcpRuntime.buildArgv', () => {
  const rt = new VmAcpRuntime({ machine: 'zooid-smoke-abcd1234' })

  it('execs into the agent machine with stdin kept open', () => {
    const argv = rt.buildArgv({ command: 'node', args: ['agent.mjs'], cwd: '/workspace' })
    expect(argv.slice(0, 6)).toEqual(['machine', 'exec', '-i', '--name', 'zooid-smoke-abcd1234', '--'])
  })

  it('sets cwd and env through a POSIX sh wrapper, not exec flags', () => {
    const argv = rt.buildArgv({
      command: 'node',
      args: ['agent.mjs', '--flag'],
      cwd: '/workspace',
      env: { B: '2', A: 'one two' },
    })
    expect(argv.slice(6)).toEqual([
      'sh',
      '-c',
      'cd "$1" && shift && exec env "$@"',
      'zooid-acp',
      '/workspace',
      'A=one two',
      'B=2',
      'node',
      'agent.mjs',
      '--flag',
    ])
  })

  it('defaults cwd to the guest workdir mount', () => {
    const argv = rt.buildArgv({ command: 'node', args: [] })
    expect(argv[10]).toBe('/workspace')
  })

  it('ignores image and mounts (both are fixed when the machine is created)', () => {
    const a = rt.buildArgv({ command: 'node', args: [], cwd: '/workspace' })
    const b = rt.buildArgv({
      command: 'node',
      args: [],
      cwd: '/workspace',
      image: 'other:1',
      mounts: [{ path: '/etc', target: '/x', mode: 'rw' }],
    })
    expect(b).toEqual(a)
  })
})
