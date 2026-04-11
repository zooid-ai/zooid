import { describe, it, expect } from 'vitest'
import { LocalRuntime } from './local.js'

describe('LocalRuntime', () => {
  it('spawns the configured command and captures stdout', async () => {
    const runtime = new LocalRuntime()
    const child = runtime.spawn({ command: 'echo', args: ['hello world'] })
    let stdout = ''
    child.stdout!.on('data', (d) => (stdout += d.toString()))
    await new Promise((resolve) => child.on('exit', resolve))
    expect(stdout.trim()).toBe('hello world')
  })

  it('propagates the child exit code', async () => {
    const runtime = new LocalRuntime()
    const child = runtime.spawn({ command: 'sh', args: ['-c', 'exit 3'] })
    const code = await new Promise<number>((resolve) =>
      child.on('exit', (c) => resolve(c ?? -1)),
    )
    expect(code).toBe(3)
  })

  it('passes env vars into the spawned process', async () => {
    const runtime = new LocalRuntime()
    const child = runtime.spawn({
      command: 'sh',
      args: ['-c', 'echo $FOO'],
      env: { FOO: 'bar' },
    })
    let stdout = ''
    child.stdout!.on('data', (d) => (stdout += d.toString()))
    await new Promise((resolve) => child.on('exit', resolve))
    expect(stdout.trim()).toBe('bar')
  })

  it('inherits PATH so adapters like claude can be resolved', async () => {
    const runtime = new LocalRuntime()
    const child = runtime.spawn({
      command: 'sh',
      args: ['-c', 'echo $PATH'],
    })
    let stdout = ''
    child.stdout!.on('data', (d) => (stdout += d.toString()))
    await new Promise((resolve) => child.on('exit', resolve))
    expect(stdout.trim().length).toBeGreaterThan(0)
  })
})
