import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateVapidKeys, VAPID_FILENAME } from './vapid.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zooid-vapid-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadOrCreateVapidKeys', () => {
  it('generates a keypair on first call and persists it', () => {
    const keys = loadOrCreateVapidKeys(dir)
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
    // base64url-encoded uncompressed P-256 point: 65 bytes → 87 chars
    expect(keys.publicKey.length).toBe(87)

    const onDisk = JSON.parse(readFileSync(join(dir, VAPID_FILENAME), 'utf8'))
    expect(onDisk).toEqual({ publicKey: keys.publicKey, privateKey: keys.privateKey })
  })

  it('is stable across calls — regenerating would invalidate every subscription', () => {
    const first = loadOrCreateVapidKeys(dir)
    const second = loadOrCreateVapidKeys(dir)
    expect(second).toEqual(first)
  })

  it('creates the directory when it does not exist yet', () => {
    const nested = join(dir, 'a', 'b')
    const keys = loadOrCreateVapidKeys(nested)
    expect(readFileSync(join(nested, VAPID_FILENAME), 'utf8')).toContain(keys.publicKey)
  })

  it('regenerates rather than throwing when the file is corrupt', () => {
    writeFileSync(join(dir, VAPID_FILENAME), 'not json')
    const keys = loadOrCreateVapidKeys(dir)
    expect(keys.publicKey.length).toBe(87)
  })
})
