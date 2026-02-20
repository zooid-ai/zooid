import { describe, it, expect } from 'vitest';
import { verifyWebhook } from './verify';

async function generateTestKeyPair() {
  const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const pubRaw = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const pubB64 = arrayBufferToBase64(pubRaw);

  return { keyPair, publicKey: pubB64 };
}

async function sign(privateKey: CryptoKey, timestamp: string, body: string) {
  const message = new TextEncoder().encode(`${timestamp}.${body}`);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, message);
  return arrayBufferToBase64(sig);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('verifyWebhook', () => {
  it('accepts a valid signature', async () => {
    const { keyPair, publicKey } = await generateTestKeyPair();
    const timestamp = new Date().toISOString();
    const body = '{"type":"test","data":{}}';
    const signature = await sign(keyPair.privateKey, timestamp, body);

    const valid = await verifyWebhook({
      body,
      signature,
      timestamp,
      publicKey,
    });
    expect(valid).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const { keyPair, publicKey } = await generateTestKeyPair();
    const timestamp = new Date().toISOString();
    const body = '{"type":"test","data":{}}';
    const signature = await sign(keyPair.privateKey, timestamp, body);

    const valid = await verifyWebhook({
      body: '{"type":"tampered"}',
      signature,
      timestamp,
      publicKey,
    });
    expect(valid).toBe(false);
  });

  it('rejects a tampered timestamp', async () => {
    const { keyPair, publicKey } = await generateTestKeyPair();
    const timestamp = '2026-02-17T14:30:00Z';
    const body = '{"test":"data"}';
    const signature = await sign(keyPair.privateKey, timestamp, body);

    const valid = await verifyWebhook({
      body,
      signature,
      timestamp: '2026-02-17T15:00:00Z',
      publicKey,
    });
    expect(valid).toBe(false);
  });

  it('rejects a stale timestamp when maxAge is set', async () => {
    const { keyPair, publicKey } = await generateTestKeyPair();
    const staleTimestamp = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
    const body = '{"test":"data"}';
    const signature = await sign(keyPair.privateKey, staleTimestamp, body);

    const valid = await verifyWebhook({
      body,
      signature,
      timestamp: staleTimestamp,
      publicKey,
      maxAge: 300, // 5 min
    });
    expect(valid).toBe(false);
  });

  it('accepts a fresh timestamp when maxAge is set', async () => {
    const { keyPair, publicKey } = await generateTestKeyPair();
    const timestamp = new Date().toISOString();
    const body = '{"test":"data"}';
    const signature = await sign(keyPair.privateKey, timestamp, body);

    const valid = await verifyWebhook({
      body,
      signature,
      timestamp,
      publicKey,
      maxAge: 300,
    });
    expect(valid).toBe(true);
  });

  it('rejects an invalid timestamp string when maxAge is set', async () => {
    const { keyPair, publicKey } = await generateTestKeyPair();
    const body = '{"test":"data"}';
    const signature = await sign(keyPair.privateKey, 'not-a-date', body);

    const valid = await verifyWebhook({
      body,
      signature,
      timestamp: 'not-a-date',
      publicKey,
      maxAge: 300,
    });
    expect(valid).toBe(false);
  });
});
