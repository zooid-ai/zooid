/** Options for verifying a Zooid webhook signature. */
export interface VerifyWebhookOptions {
  /** The raw JSON request body string. */
  body: string;
  /** Base64-encoded Ed25519 signature from the `X-Zooid-Signature` header. */
  signature: string;
  /** ISO 8601 timestamp from the `X-Zooid-Timestamp` header. */
  timestamp: string;
  /** Base64-encoded SPKI public key from `/.well-known/zooid.json`. */
  publicKey: string;
  /** Maximum age in seconds before the timestamp is considered stale. Default: no check. */
  maxAge?: number;
}

/**
 * Verify an Ed25519 webhook signature from a Zooid server.
 *
 * @example
 * ```ts
 * import { verifyWebhook } from '@zooid/sdk';
 *
 * const isValid = await verifyWebhook({
 *   body: rawBody,
 *   signature: req.headers['x-zooid-signature'],
 *   timestamp: req.headers['x-zooid-timestamp'],
 *   publicKey: cachedPublicKey,
 *   maxAge: 300,
 * });
 * ```
 */
export async function verifyWebhook(
  options: VerifyWebhookOptions,
): Promise<boolean> {
  const { body, signature, timestamp, publicKey, maxAge } = options;

  if (maxAge !== undefined) {
    const ts = Date.parse(timestamp);
    if (Number.isNaN(ts)) return false;
    const age = (Date.now() - ts) / 1000;
    if (age > maxAge || age < -maxAge) return false;
  }

  const key = await crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(publicKey),
    'Ed25519',
    false,
    ['verify'],
  );

  const message = new TextEncoder().encode(`${timestamp}.${body}`);
  const sigBytes = base64ToArrayBuffer(signature);

  return crypto.subtle.verify('Ed25519', key, sigBytes, message);
}

function base64ToArrayBuffer(input: string): ArrayBuffer {
  // Accept both standard base64 and base64url
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
