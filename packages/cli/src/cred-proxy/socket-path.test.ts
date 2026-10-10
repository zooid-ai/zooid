import { afterEach, describe, expect, it } from 'vitest'
import { credentialSocketPath } from './socket-path.js'

const saved = process.env.TMPDIR
afterEach(() => {
  if (saved === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = saved
})

describe('credentialSocketPath', () => {
  it('is stable per workforce and agent', () => {
    const a = credentialSocketPath('/cfg', 'smoke')
    expect(a).toBe(credentialSocketPath('/cfg', 'smoke'))
    expect(a).toMatch(/\/zooid-cred-[0-9a-f]{8}\/smoke\.sock$/)
  })

  it('differs across workforces', () => {
    const dir = (p: string) => p.slice(0, p.lastIndexOf('/'))
    expect(dir(credentialSocketPath('/a', 'smoke'))).not.toBe(dir(credentialSocketPath('/b', 'smoke')))
  })

  it('refuses a path Node would truncate', () => {
    process.env.TMPDIR = '/' + 'x'.repeat(99)
    const n = Buffer.byteLength(`${process.env.TMPDIR}/zooid-cred-00000000/smoke.sock`)
    expect(() => credentialSocketPath('/cfg', 'smoke')).toThrow(
      `credential proxy socket path for smoke is ${n} bytes; Unix sockets allow 103. Shorten the agent name or set TMPDIR`,
    )
  })
})
