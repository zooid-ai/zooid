import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush from 'web-push'

export const VAPID_FILENAME = 'vapid.json'

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/**
 * Load the daemon's VAPID keypair, generating it on first call.
 *
 * Regenerating invalidates every existing browser subscription — every device
 * has to re-enable notifications by hand. It is a one-way door, so this never
 * regenerates over a readable file; only over a missing or corrupt one, and it
 * says so on the way past.
 */
export function loadOrCreateVapidKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, VAPID_FILENAME)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VapidKeys>
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string')
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
    console.warn(`[push] ${path} is malformed; generating a new VAPID keypair.`)
  } catch {
    // Missing file on first start is the normal path — say nothing.
  }
  const keys = webpush.generateVAPIDKeys()
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 })
  return keys
}
