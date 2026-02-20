import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  signPayload,
  verifySignature,
  exportPublicKey,
} from './signing';

describe('Ed25519 signing', () => {
  it('generates a key pair', async () => {
    const keyPair = await generateKeyPair();
    expect(keyPair.privateKey).toBeTruthy();
    expect(keyPair.publicKey).toBeTruthy();
  });

  it('signs a payload and produces a base64 signature', async () => {
    const keyPair = await generateKeyPair();
    const timestamp = '2026-02-17T14:30:00Z';
    const body = '{"test":"data"}';
    const signature = await signPayload(keyPair.privateKey, timestamp, body);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
  });

  it('verifies a valid signature', async () => {
    const keyPair = await generateKeyPair();
    const timestamp = '2026-02-17T14:30:00Z';
    const body = '{"test":"data"}';
    const signature = await signPayload(keyPair.privateKey, timestamp, body);
    const valid = await verifySignature(
      keyPair.publicKey,
      signature,
      timestamp,
      body,
    );
    expect(valid).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const keyPair = await generateKeyPair();
    const timestamp = '2026-02-17T14:30:00Z';
    const body = '{"test":"data"}';
    const signature = await signPayload(keyPair.privateKey, timestamp, body);
    const valid = await verifySignature(
      keyPair.publicKey,
      signature,
      timestamp,
      '{"test":"tampered"}',
    );
    expect(valid).toBe(false);
  });

  it('rejects a tampered timestamp', async () => {
    const keyPair = await generateKeyPair();
    const timestamp = '2026-02-17T14:30:00Z';
    const body = '{"test":"data"}';
    const signature = await signPayload(keyPair.privateKey, timestamp, body);
    const valid = await verifySignature(
      keyPair.publicKey,
      signature,
      '2026-02-17T15:00:00Z',
      body,
    );
    expect(valid).toBe(false);
  });

  it('exports public key as base64 SPKI', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportPublicKey(keyPair.publicKey);
    expect(typeof exported).toBe('string');
    expect(exported).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
