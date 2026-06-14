import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readZoonWebPin } from './pin.js'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'zooid-pin-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readZoonWebPin', () => {
  it('reads zooid.webVersion from the cli package.json', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'zooid', zooid: { webVersion: '0.1.0' } }),
    )
    expect(readZoonWebPin(dir)).toBe('0.1.0')
  })

  it('returns undefined when the field is absent', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zooid' }))
    expect(readZoonWebPin(dir)).toBeUndefined()
  })
})
