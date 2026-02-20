import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../index';
import { setupTestDb, cleanTestDb } from '../test-utils';
import { createToken } from '../lib/jwt';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
} from '../lib/signing';

const JWT_SECRET = 'test-jwt-secret';

let SIGNING_KEY_BASE64: string;
let PUBLIC_KEY: CryptoKey;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64UrlToBytes(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

async function authRequest(
  path: string,
  options: RequestInit = {},
  scope: 'admin' | 'publish' | 'subscribe' = 'admin',
  channel?: string,
) {
  const token = await createToken({ scope, channel }, JWT_SECRET);
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  return app.request(
    path,
    { ...options, headers },
    {
      ...env,
      ZOOID_JWT_SECRET: JWT_SECRET,
      ZOOID_SIGNING_KEY: SIGNING_KEY_BASE64,
    },
  );
}

async function createTestChannel(id: string) {
  await authRequest('/api/v1/channels', {
    method: 'POST',
    body: JSON.stringify({ id, name: id, is_public: true }),
  });
}

describe('Directory claim route', () => {
  beforeAll(async () => {
    await setupTestDb();

    // Generate a key pair for signing
    const keyPair = await generateKeyPair();
    const exported = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    SIGNING_KEY_BASE64 = arrayBufferToBase64(exported);
    PUBLIC_KEY = keyPair.publicKey;
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('POST /directory/claim', () => {
    it('returns a signed claim for valid channels', async () => {
      await createTestChannel('test-channel');

      const res = await authRequest('/api/v1/directory/claim', {
        method: 'POST',
        body: JSON.stringify({ channels: ['test-channel'] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { claim: string; signature: string };
      expect(body.claim).toBeTruthy();
      expect(body.signature).toBeTruthy();

      // Decode and verify claim contents
      const claimJson = new TextDecoder().decode(base64UrlToBytes(body.claim));
      const claim = JSON.parse(claimJson);
      expect(claim.channels).toEqual(['test-channel']);
      expect(claim.server_url).toBeTruthy();
      expect(claim.timestamp).toBeTruthy();
      expect(claim.action).toBeUndefined();
    });

    it('includes action field when action=delete', async () => {
      await createTestChannel('del-channel');

      const res = await authRequest('/api/v1/directory/claim', {
        method: 'POST',
        body: JSON.stringify({ channels: ['del-channel'], action: 'delete' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { claim: string; signature: string };
      const claimJson = new TextDecoder().decode(base64UrlToBytes(body.claim));
      const claim = JSON.parse(claimJson);
      expect(claim.action).toBe('delete');
    });

    it('produces a valid Ed25519 signature', async () => {
      await createTestChannel('sig-channel');

      const res = await authRequest('/api/v1/directory/claim', {
        method: 'POST',
        body: JSON.stringify({ channels: ['sig-channel'] }),
      });

      const body = (await res.json()) as { claim: string; signature: string };
      const claimBytes = base64UrlToBytes(body.claim);
      const sigBytes = base64UrlToBytes(body.signature);

      // Verify with the public key
      const valid = await crypto.subtle.verify(
        'Ed25519',
        PUBLIC_KEY,
        sigBytes,
        claimBytes,
      );
      expect(valid).toBe(true);
    });

    it('handles multiple channels', async () => {
      await createTestChannel('channel-a');
      await createTestChannel('channel-b');

      const res = await authRequest('/api/v1/directory/claim', {
        method: 'POST',
        body: JSON.stringify({ channels: ['channel-a', 'channel-b'] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { claim: string; signature: string };
      const claimJson = new TextDecoder().decode(base64UrlToBytes(body.claim));
      const claim = JSON.parse(claimJson);
      expect(claim.channels).toEqual(['channel-a', 'channel-b']);
    });

    it('returns 400 for non-existent channels', async () => {
      const res = await authRequest('/api/v1/directory/claim', {
        method: 'POST',
        body: JSON.stringify({ channels: ['nonexistent'] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('nonexistent');
    });

    it('returns 400 when some channels exist and some do not', async () => {
      await createTestChannel('real-channel');

      const res = await authRequest('/api/v1/directory/claim', {
        method: 'POST',
        body: JSON.stringify({ channels: ['real-channel', 'fake-channel'] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('fake-channel');
    });

    it('rejects without auth', async () => {
      const res = await app.request(
        '/api/v1/directory/claim',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels: ['test'] }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(401);
    });

    it('rejects with non-admin token', async () => {
      const res = await authRequest(
        '/api/v1/directory/claim',
        {
          method: 'POST',
          body: JSON.stringify({ channels: ['test'] }),
        },
        'publish',
        'test',
      );

      expect(res.status).toBe(403);
    });

    it('returns 500 when signing key is not configured', async () => {
      await createTestChannel('no-key-channel');

      const token = await createToken({ scope: 'admin' }, JWT_SECRET);
      const headers = new Headers();
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('Content-Type', 'application/json');

      const res = await app.request(
        '/api/v1/directory/claim',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ channels: ['no-key-channel'] }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
        // No ZOOID_SIGNING_KEY
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('signing key');
    });
  });
});
