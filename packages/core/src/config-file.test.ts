import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findConfigFile } from './config.js'

describe('findConfigFile — zooid.yaml migration', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zooid-rename-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds zooid.yaml when present', () => {
    writeFileSync(join(dir, 'zooid.yaml'), 'runtime: local\n')
    const found = findConfigFile(dir)
    expect(found?.path).toBe(join(dir, 'zooid.yaml'))
  })

  it('throws a migration error when only workforce.yaml is present', () => {
    writeFileSync(join(dir, 'workforce.yaml'), 'runtime: local\n')
    expect(() => findConfigFile(dir)).toThrow(/workforce\.yaml.*no longer supported.*zooid\.yaml.*ZOD045/i)
  })

  it('returns null when neither file exists', () => {
    expect(findConfigFile(dir)).toBeNull()
  })

  it('prefers zooid.yaml when both exist (and does not throw)', () => {
    writeFileSync(join(dir, 'zooid.yaml'), 'runtime: local\n')
    writeFileSync(join(dir, 'workforce.yaml'), 'runtime: local\n')
    const found = findConfigFile(dir)
    expect(found?.path).toBe(join(dir, 'zooid.yaml'))
  })
})
