import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../packages/server/src/index';
import { ZooidClient } from '../../packages/sdk/src/client';
import { createToken } from '../../packages/server/src/lib/jwt';
import { generateKeyPair } from '../../packages/server/src/lib/signing';
import { setupTestDb, cleanTestDb } from '../../packages/server/src/test-utils';

const JWT_SECRET = 'test-jwt-secret';

// Helper: create a mini fetch that routes through the Hono app
function createTestFetch(extraEnv: Record<string, string> = {}) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = new URL(url).pathname + new URL(url).search;
    return app.request(path, init ?? {}, {
      ...env,
      ZOOID_JWT_SECRET: JWT_SECRET,
      ...extraEnv,
    });
  };
}

describe('SDK Integration Tests', () => {
  let testFetch: ReturnType<typeof createTestFetch>;

  beforeAll(async () => {
    await setupTestDb();
    testFetch = createTestFetch();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('channel lifecycle', () => {
    it('creates a channel, lists it, and adds a publisher', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const client = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      // Create channel
      const created = await client.createChannel({
        id: 'test-channel',
        name: 'Test Channel',
        description: 'Integration test',
        is_public: true,
      });
      expect(created.id).toBe('test-channel');
      expect(created.publish_token).toBeTruthy();
      expect(created.subscribe_token).toBeTruthy();

      // List channels
      const channels = await client.listChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].id).toBe('test-channel');
      expect(channels[0].event_count).toBe(0);

      // Add publisher
      const publisher = await client.addPublisher('test-channel', 'my-bot');
      expect(publisher.name).toBe('my-bot');
      expect(publisher.publish_token).toBeTruthy();
    });
  });

  describe('publish and poll', () => {
    it('publishes events and polls them back', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      const created = await admin.createChannel({
        id: 'pub-test',
        name: 'Pub Test',
        is_public: true,
      });

      // Publish with the publish token
      const publisher = new ZooidClient({
        server: 'https://test.local',
        token: created.publish_token,
        fetch: testFetch,
      });

      const event = await publisher.publish('pub-test', {
        type: 'signal',
        data: { market: 'BTC', shift: 0.05 },
      });
      expect(event.id).toBeTruthy();
      expect(event.type).toBe('signal');

      // Poll without auth (public channel)
      const reader = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      const result = await reader.poll('pub-test');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('signal');
      expect(result.has_more).toBe(false);
    });

    it('publishes a batch and polls with cursor', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      const created = await admin.createChannel({
        id: 'batch-test',
        name: 'Batch',
        is_public: true,
      });

      const publisher = new ZooidClient({
        server: 'https://test.local',
        token: created.publish_token,
        fetch: testFetch,
      });

      const events = await publisher.publishBatch('batch-test', [
        { type: 'a', data: { v: 1 } },
        { type: 'b', data: { v: 2 } },
        { type: 'c', data: { v: 3 } },
      ]);
      expect(events).toHaveLength(3);

      // Poll with limit
      const reader = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      const page1 = await reader.poll('batch-test', { limit: 2 });
      expect(page1.events).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeTruthy();

      const page2 = await reader.poll('batch-test', { cursor: page1.cursor! });
      expect(page2.events).toHaveLength(1);
      expect(page2.has_more).toBe(false);
    });
  });

  describe('tail (one-shot read)', () => {
    it('tails latest events from a public channel', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      const created = await admin.createChannel({
        id: 'tail-test',
        name: 'Tail Test',
        is_public: true,
      });

      const publisher = new ZooidClient({
        server: 'https://test.local',
        token: created.publish_token,
        fetch: testFetch,
      });

      await publisher.publishBatch('tail-test', [
        { type: 'a', data: { v: 1 } },
        { type: 'b', data: { v: 2 } },
        { type: 'c', data: { v: 3 } },
      ]);

      // Tail without auth (public channel)
      const reader = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      const result = await reader.tail('tail-test');
      expect(result.events).toHaveLength(3);
      expect(result.events[0].type).toBe('a');
      expect(result.events[2].type).toBe('c');
    });

    it('tails with limit', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      const created = await admin.createChannel({
        id: 'tail-limit',
        name: 'Tail Limit',
        is_public: true,
      });

      const publisher = new ZooidClient({
        server: 'https://test.local',
        token: created.publish_token,
        fetch: testFetch,
      });

      await publisher.publishBatch('tail-limit', [
        { type: 'a', data: { v: 1 } },
        { type: 'b', data: { v: 2 } },
        { type: 'c', data: { v: 3 } },
      ]);

      const reader = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      const result = await reader.tail('tail-limit', { limit: 2 });
      expect(result.events).toHaveLength(2);
      expect(result.has_more).toBe(true);
      expect(result.cursor).toBeTruthy();
    });

    it('requires subscribe token to tail private channel', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      await admin.createChannel({
        id: 'tail-private',
        name: 'Private Tail',
        is_public: false,
      });

      const anonymous = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      await expect(anonymous.tail('tail-private')).rejects.toThrow();
    });
  });

  describe('private channels', () => {
    it('requires subscribe token to poll private channel', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      await admin.createChannel({
        id: 'private-ch',
        name: 'Private',
        is_public: false,
      });

      // Poll without token should fail
      const anonymous = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      await expect(anonymous.poll('private-ch')).rejects.toThrow();

      // Poll with subscribe token should work
      const subToken = await createToken(
        { scope: 'subscribe', channel: 'private-ch' },
        JWT_SECRET,
      );
      const subscriber = new ZooidClient({
        server: 'https://test.local',
        token: subToken,
        fetch: testFetch,
      });

      const result = await subscriber.poll('private-ch');
      expect(result.events).toEqual([]);
    });
  });

  describe('server info', () => {
    it('fetches server discovery metadata', async () => {
      const client = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      const meta = await client.getMetadata();
      expect(meta.version).toBe('0.1');
      expect(meta.algorithm).toBe('Ed25519');
      expect(meta.delivery).toContain('poll');
    });
  });

  describe('server meta', () => {
    it('returns defaults when no row exists', async () => {
      const client = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });

      const meta = await client.getServerMeta();
      expect(meta.name).toBe('Zooid');
      expect(meta.description).toBeNull();
      expect(meta.tags).toEqual([]);
    });

    it('updates and retrieves server metadata', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: testFetch,
      });

      const updated = await admin.updateServerMeta({
        name: 'My Zooid',
        description: 'Integration test server',
        tags: ['ai', 'agents'],
        owner: 'tester',
      });
      expect(updated.name).toBe('My Zooid');
      expect(updated.tags).toEqual(['ai', 'agents']);

      // Read back without auth
      const reader = new ZooidClient({
        server: 'https://test.local',
        fetch: testFetch,
      });
      const meta = await reader.getServerMeta();
      expect(meta.name).toBe('My Zooid');
      expect(meta.owner).toBe('tester');
    });
  });

  describe('directory claim', () => {
    let claimFetch: ReturnType<typeof createTestFetch>;
    let signingKeyBase64: string;
    let publicKey: CryptoKey;

    function arrayBufferToBase64(buffer: ArrayBuffer): string {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    }

    function base64UrlToBytes(base64url: string): Uint8Array {
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    beforeAll(async () => {
      const keyPair = await generateKeyPair();
      const exported = await crypto.subtle.exportKey(
        'pkcs8',
        keyPair.privateKey,
      );
      signingKeyBase64 = arrayBufferToBase64(exported);
      publicKey = keyPair.publicKey;
      claimFetch = createTestFetch({ ZOOID_SIGNING_KEY: signingKeyBase64 });
    });

    it('creates channels and generates a valid signed claim via SDK', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: claimFetch,
      });

      // Create channels
      await admin.createChannel({
        id: 'claim-ch-a',
        name: 'Claim A',
        is_public: true,
      });
      await admin.createChannel({
        id: 'claim-ch-b',
        name: 'Claim B',
        is_public: true,
      });

      // Get claim
      const result = await admin.getClaim(['claim-ch-a', 'claim-ch-b']);
      expect(result.claim).toBeTruthy();
      expect(result.signature).toBeTruthy();

      // Decode claim
      const claimBytes = base64UrlToBytes(result.claim);
      const claimJson = new TextDecoder().decode(claimBytes);
      const claim = JSON.parse(claimJson);
      expect(claim.channels).toEqual(['claim-ch-a', 'claim-ch-b']);
      expect(claim.server_url).toBeTruthy();
      expect(claim.timestamp).toBeTruthy();

      // Verify signature
      const sigBytes = base64UrlToBytes(result.signature);
      const valid = await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        sigBytes,
        claimBytes,
      );
      expect(valid).toBe(true);
    });

    it('generates a delete claim via SDK', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: claimFetch,
      });

      await admin.createChannel({
        id: 'del-ch',
        name: 'Delete Me',
        is_public: true,
      });

      const result = await admin.getClaim(['del-ch'], 'delete');
      const claimJson = new TextDecoder().decode(
        base64UrlToBytes(result.claim),
      );
      const claim = JSON.parse(claimJson);
      expect(claim.action).toBe('delete');
      expect(claim.channels).toEqual(['del-ch']);
    });

    it('rejects claim for non-existent channels via SDK', async () => {
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const admin = new ZooidClient({
        server: 'https://test.local',
        token: adminToken,
        fetch: claimFetch,
      });

      await expect(admin.getClaim(['does-not-exist'])).rejects.toThrow();
    });

    it('rejects claim without admin token', async () => {
      const subToken = await createToken(
        { scope: 'subscribe', channel: 'any' },
        JWT_SECRET,
      );
      const subscriber = new ZooidClient({
        server: 'https://test.local',
        token: subToken,
        fetch: claimFetch,
      });

      await expect(subscriber.getClaim(['any'])).rejects.toThrow();
    });
  });
});
