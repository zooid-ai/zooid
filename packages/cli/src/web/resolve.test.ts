import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWebRoot } from './resolve.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zooid-resolve-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('resolveWebRoot', () => {
  it('returns dist/web when present (published-package layout)', () => {
    const distWeb = join(root, 'dist', 'web')
    mkdirSync(distWeb, { recursive: true })
    writeFileSync(join(distWeb, 'index.html'), '<html/>')
    expect(resolveWebRoot(root)).toBe(distWeb)
  })

  it('falls back to ../../zoon/packages/web/dist when running from source', () => {
    const cliRoot = join(root, 'zooid', 'packages', 'cli')
    mkdirSync(cliRoot, { recursive: true })
    const webDist = join(root, 'zoon', 'packages', 'web', 'dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webDist, 'index.html'), '<html/>')
    expect(resolveWebRoot(cliRoot)).toBe(webDist)
  })

  it('throws a helpful error when neither layout has been built', () => {
    expect(() => resolveWebRoot(root)).toThrow(/@zoon\/web.*build/i)
  })
})
