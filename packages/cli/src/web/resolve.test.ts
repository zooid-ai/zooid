import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureWebRoot, webSourcePackage } from './resolve.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zooid-resolve-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.ZOOID_DEV_WEB_ROOT_OVERRIDE
})

function makeSibling(rootDir: string): { cliRoot: string; webDist: string } {
  const cliRoot = join(rootDir, 'zooid', 'packages', 'cli')
  mkdirSync(cliRoot, { recursive: true })
  const webPkg = join(rootDir, 'zoon', 'packages', 'web')
  const webDist = join(webPkg, 'dist')
  mkdirSync(webDist, { recursive: true })
  writeFileSync(join(webPkg, 'package.json'), '{"name":"@zooid/web"}')
  writeFileSync(join(webDist, 'index.html'), '<html/>')
  return { cliRoot, webDist }
}

describe('ensureWebRoot', () => {
  it('env override wins over everything and skips the fetch', async () => {
    const { cliRoot } = makeSibling(root)
    const override = join(root, 'override')
    mkdirSync(override, { recursive: true })
    writeFileSync(join(override, 'index.html'), '<html/>')
    process.env.ZOOID_DEV_WEB_ROOT_OVERRIDE = override
    const fetchBundle = vi.fn()
    const out = await ensureWebRoot({ cliRoot, cacheDir: join(root, 'cache'), version: '0.1.0', fetchBundle })
    expect(out).toBe(override)
    expect(fetchBundle).not.toHaveBeenCalled()
  })

  it('prefers the monorepo sibling dist over the cache (contributor path)', async () => {
    const { cliRoot, webDist } = makeSibling(root)
    const fetchBundle = vi.fn()
    const out = await ensureWebRoot({ cliRoot, cacheDir: join(root, 'cache'), version: '0.1.0', fetchBundle })
    expect(out).toBe(webDist)
    expect(fetchBundle).not.toHaveBeenCalled()
  })

  it('falls back to fetchBundle outside the monorepo (installed-package path)', async () => {
    const cliRoot = join(root, 'lonely', 'cli')
    mkdirSync(cliRoot, { recursive: true })
    const cached = join(root, 'cache', '0.1.0')
    const fetchBundle = vi.fn(async () => cached)
    const out = await ensureWebRoot({ cliRoot, cacheDir: join(root, 'cache'), version: '0.1.0', fetchBundle })
    expect(out).toBe(cached)
    expect(fetchBundle).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.1.0', cacheDir: join(root, 'cache') }),
    )
  })

  it('throws an actionable error when no version pin is available outside the monorepo', async () => {
    const cliRoot = join(root, 'lonely', 'cli')
    mkdirSync(cliRoot, { recursive: true })
    await expect(
      ensureWebRoot({ cliRoot, cacheDir: join(root, 'cache'), version: undefined, fetchBundle: vi.fn() }),
    ).rejects.toThrow(/webVersion/)
  })
})

describe('webSourcePackage', () => {
  it('returns the source package dir when sibling zooid-clients/packages/web exists', () => {
    const { cliRoot } = makeSibling(root)
    expect(webSourcePackage(cliRoot)).toBe(join(root, 'zoon', 'packages', 'web'))
  })

  it('returns null outside the monorepo', () => {
    expect(webSourcePackage(root)).toBeNull()
  })
})
