import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureTokens, readTokens } from './tokens.js'

let dir: string
beforeEach(() => {
  dir = join(tmpdir(), `zooid-tokens-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ensureTokens', () => {
  it('generates two distinct hex tokens on first call and persists them', () => {
    const envPath = join(dir, '.env')
    const t = ensureTokens(envPath)
    expect(t.asToken).toMatch(/^as-[0-9a-f]{32,}$/)
    expect(t.hsToken).toMatch(/^hs-[0-9a-f]{32,}$/)
    expect(t.asToken).not.toBe(t.hsToken)
    const env = readFileSync(envPath, 'utf8')
    expect(env).toContain(`MATRIX_AS_TOKEN=${t.asToken}`)
    expect(env).toContain(`MATRIX_HS_TOKEN=${t.hsToken}`)
  })

  it('reuses tokens on subsequent calls (idempotent)', () => {
    const envPath = join(dir, '.env')
    const a = ensureTokens(envPath)
    const b = ensureTokens(envPath)
    expect(a).toEqual(b)
  })

  it('errors with a clear message if .env exists but is missing tokens', () => {
    const envPath = join(dir, '.env')
    writeFileSync(envPath, 'MATRIX_AS_TOKEN=as-abc\n', 'utf8')
    expect(() => ensureTokens(envPath)).toThrow(
      /missing MATRIX_AS_TOKEN or MATRIX_HS_TOKEN/i,
    )
  })

  it('readTokens returns null when file does not exist', () => {
    expect(readTokens(join(dir, 'nope.env'))).toBeNull()
  })
})
