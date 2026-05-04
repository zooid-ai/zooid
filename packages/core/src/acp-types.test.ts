import { describe, it, expectTypeOf } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type {
  AcpAgentSpec,
  AcpMount,
  AcpRuntime,
  AcpSpawnSpec,
} from './acp-types.js'

describe('AcpAgentSpec — preset vs command', () => {
  it('accepts the preset form', () => {
    const a: AcpAgentSpec = { preset: 'claude' }
    expectTypeOf(a).toMatchTypeOf<AcpAgentSpec>()
  })

  it('accepts the explicit form', () => {
    const a: AcpAgentSpec = { command: 'opencode', args: ['acp'] }
    expectTypeOf(a).toMatchTypeOf<AcpAgentSpec>()
  })

  it('forbids both at compile time', () => {
    // @ts-expect-error — XOR
    const _: AcpAgentSpec = { preset: 'claude', command: 'overridden' }
    void _
  })
})

describe('AcpRuntime returns a ChildProcess', () => {
  it('typechecks', () => {
    const _impl = (rt: AcpRuntime) => {
      const child: ChildProcess = rt.spawn({ command: 'x', args: [] })
      return child
    }
    void _impl
  })
})

describe('AcpSpawnSpec / AcpMount shape', () => {
  it('mount has path/target/mode', () => {
    const m: AcpMount = { path: '/host', target: '/container', mode: 'ro' }
    expectTypeOf(m).toMatchTypeOf<AcpMount>()
  })

  it('spawn spec carries command, args, optional env/cwd/image/mounts', () => {
    const s: AcpSpawnSpec = {
      command: 'foo',
      args: ['bar'],
      env: { K: 'v' },
      cwd: '/x',
      image: 'img',
      mounts: [{ path: '/h', target: '/c', mode: 'rw' }],
    }
    expectTypeOf(s).toMatchTypeOf<AcpSpawnSpec>()
  })
})
