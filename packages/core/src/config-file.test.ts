import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findConfigFile } from './config.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-cfg-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('findConfigFile', () => {
  it('returns the workforce.yaml path when it exists', () => {
    writeFileSync(join(dir, 'workforce.yaml'), 'agents: {}\n')
    expect(findConfigFile(dir)?.path).toBe(join(dir, 'workforce.yaml'))
  })

  it('returns null when workforce.yaml is absent', () => {
    expect(findConfigFile(dir)).toBeNull()
  })

  it('ignores daemon.yaml (legacy filename is no longer recognised)', () => {
    writeFileSync(join(dir, 'daemon.yaml'), 'agents: {}\n')
    expect(findConfigFile(dir)).toBeNull()
  })
})
