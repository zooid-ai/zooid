import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../packages/server/src/index';
import { ZooidClient } from '../../packages/sdk/src/client';
import { createToken } from '../../packages/server/src/lib/jwt';
import { setupTestDb, cleanTestDb } from '../../packages/server/src/test-utils';

const JWT_SECRET = 'test-jwt-secret';

// Helper: create a mini fetch that routes through the Hono app
function createTestFetch() {
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
});
