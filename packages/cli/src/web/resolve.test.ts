import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWebRoot, webSourcePackage } from './resolve.js'

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
    const webPkg = join(root, 'zoon', 'packages', 'web')
    const webDist = join(webPkg, 'dist')
    mkdirSync(webDist, { recursive: true })
    writeFileSync(join(webPkg, 'package.json'), '{"name":"@zoon/web"}')
    writeFileSync(join(webDist, 'index.html'), '<html/>')
    expect(resolveWebRoot(cliRoot)).toBe(webDist)
  })

  it('throws a helpful error when neither layout has been built', () => {
    expect(() => resolveWebRoot(root)).toThrow(/@zoon\/web.*build/i)
  })
})

describe('webSourcePackage', () => {
  it('returns the source package dir when sibling zoon/packages/web exists', () => {
    const cliRoot = join(root, 'zooid', 'packages', 'cli')
    mkdirSync(cliRoot, { recursive: true })
    const webPkg = join(root, 'zoon', 'packages', 'web')
    mkdirSync(webPkg, { recursive: true })
    writeFileSync(join(webPkg, 'package.json'), '{"name":"@zoon/web"}')
    expect(webSourcePackage(cliRoot)).toBe(webPkg)
  })

  it('returns null outside the monorepo', () => {
    expect(webSourcePackage(root)).toBeNull()
  })
})
