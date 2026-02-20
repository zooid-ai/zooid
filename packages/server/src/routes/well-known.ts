import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';
import { getServerMeta } from '../db/queries';

const wellKnown = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Fixed ASN.1 DER prefix for Ed25519 SPKI (12 bytes)
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Convert a raw Ed25519 public key (base64) to base64url SPKI format.
 * If the key is already SPKI-length (44 bytes), just convert to base64url.
 */
function rawKeyToSpkiBase64Url(base64Key: string): string {
  const binary = atob(base64Key);
  const keyBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    keyBytes[i] = binary.charCodeAt(i);
  }

  let spkiBytes: Uint8Array;
  if (keyBytes.length === 32) {
    // Raw key — wrap in SPKI
    spkiBytes = new Uint8Array(ED25519_SPKI_PREFIX.length + keyBytes.length);
    spkiBytes.set(ED25519_SPKI_PREFIX);
    spkiBytes.set(keyBytes, ED25519_SPKI_PREFIX.length);
  } else {
    // Already SPKI (44 bytes) or other format — pass through
    spkiBytes = keyBytes;
  }

  let b64 = '';
  for (const byte of spkiBytes) {
    b64 += String.fromCharCode(byte);
  }
  return btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

wellKnown.get('/.well-known/zooid.json', async (c) => {
  const pollInterval = parseInt(c.env.ZOOID_POLL_INTERVAL || '30', 10);
  const meta = await getServerMeta(c.env.DB);

  return c.json({
    version: '0.1',
    public_key: c.env.ZOOID_PUBLIC_KEY
      ? rawKeyToSpkiBase64Url(c.env.ZOOID_PUBLIC_KEY)
      : '',
    public_key_format: 'spki',
    algorithm: 'Ed25519',
    server_id: c.env.ZOOID_SERVER_ID || 'zooid-local',
    server_name: meta?.name || c.env.ZOOID_SERVER_NAME || 'Zooid',
    server_description: meta?.description || c.env.ZOOID_SERVER_DESC || null,
    poll_interval: pollInterval,
    delivery: ['poll', 'webhook', 'websocket', 'rss'],
  });
});

export { wellKnown };
