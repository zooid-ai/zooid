import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { CLI_VERSION, readCliVersion } from './version.js'

const manifestVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

describe('readCliVersion', () => {
  it('reports the version from the package manifest', () => {
    expect(readCliVersion()).toBe(manifestVersion)
  })

  // The regression this exists for: `cli.version()` was a hardcoded '0.0.1'
  // from the first release through 0.12.0, so every published build claimed
  // to be a version that was never released.
  it('is not a hardcoded placeholder', () => {
    expect(CLI_VERSION).toBe(manifestVersion)
    expect(CLI_VERSION).not.toBe('0.0.1')
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  // dist/bin.js and src/bin.ts are the same depth from package.json, so the
  // single '../package.json' has to work from either. Simulate the built
  // bundle's location rather than trusting that they stay in step.
  it('resolves from a sibling directory the way dist/ does', () => {
    const root = mkdtempSync(join(tmpdir(), 'zooid-version-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }))
      const fromDist = pathToFileURL(join(root, 'dist', 'bin.js')).href
      expect(readCliVersion(fromDist)).toBe('9.9.9')
      const fromSrc = pathToFileURL(join(root, 'src', 'bin.ts')).href
      expect(readCliVersion(fromSrc)).toBe('9.9.9')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to "unknown" rather than throwing when the manifest is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'zooid-version-'))
    try {
      const url = pathToFileURL(join(root, 'dist', 'bin.js')).href
      expect(readCliVersion(url)).toBe('unknown')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to "unknown" on a manifest with no usable version', () => {
    const root = mkdtempSync(join(tmpdir(), 'zooid-version-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'zooid' }))
      const url = pathToFileURL(join(root, 'dist', 'bin.js')).href
      expect(readCliVersion(url)).toBe('unknown')
      writeFileSync(join(root, 'package.json'), '{not json')
      expect(readCliVersion(url)).toBe('unknown')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
