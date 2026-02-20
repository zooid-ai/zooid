import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../packages/server/src/index';
import { ZooidClient } from '../../packages/sdk/src/client';
import { createToken } from '../../packages/server/src/lib/jwt';
import { setupTestDb, cleanTestDb } from '../../packages/server/src/test-utils';

// Mock Node.js builtins not available in Workers runtime.
// Command handlers import lib/config which uses node:os/fs/path,
// but integration tests inject the client directly so these are never called.
vi.mock('node:os', () => ({
  default: { homedir: () => '/tmp' },
}));

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

const JWT_SECRET = 'test-jwt-secret';

// Route SDK fetch calls through the real Hono app
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

describe('CLI Integration Tests', () => {
  let testFetch: ReturnType<typeof createTestFetch>;

  beforeAll(async () => {
    await setupTestDb();
    testFetch = createTestFetch();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  async function makeAdminClient() {
    const token = await createToken({ scope: 'admin' }, JWT_SECRET);
    return new ZooidClient({
      server: 'https://test.local',
      token,
      fetch: testFetch,
    });
  }

  function makeClient(token?: string) {
    return new ZooidClient({
      server: 'https://test.local',
      token,
      fetch: testFetch,
    });
  }

  describe('channel create -> list -> add-publisher (full flow)', () => {
    it('creates a channel via handler, lists it, adds a publisher', async () => {
      const { runChannelCreate, runChannelList, runChannelAddPublisher } =
        await import('../../packages/cli/src/commands/channel');
      const client = await makeAdminClient();

      // Create
      const created = await runChannelCreate(
        'int-test',
        {
          name: 'Integration Test',
          description: 'Testing CLI handlers',
          public: true,
        },
        client,
      );
      expect(created.id).toBe('int-test');
      expect(created.publish_token).toBeTruthy();

      // List
      const channels = await runChannelList(client);
      expect(channels).toHaveLength(1);
      expect(channels[0].id).toBe('int-test');
      expect(channels[0].event_count).toBe(0);

      // Add publisher
      const pub = await runChannelAddPublisher('int-test', 'test-bot', client);
      expect(pub.name).toBe('test-bot');
      expect(pub.publish_token).toBeTruthy();
    });
  });

  describe('publish -> poll (full flow)', () => {
    it('publishes an event and polls it back via handlers', async () => {
      const { runChannelCreate } =
        await import('../../packages/cli/src/commands/channel');
      const { runPublish } =
        await import('../../packages/cli/src/commands/publish');

      const adminClient = await makeAdminClient();

      // Create channel
      const ch = await runChannelCreate(
        'pub-int',
        { name: 'Pub Int', public: true },
        adminClient,
      );

      // Publish with the publish token
      const pubClient = makeClient(ch.publish_token);
      const event = await runPublish(
        'pub-int',
        {
          type: 'signal',
          data: '{"market":"BTC","shift":0.05}',
        },
        pubClient,
      );
      expect(event.id).toBeTruthy();
      expect(event.type).toBe('signal');

      // Poll without auth (public channel) using SDK directly
      const reader = makeClient();
      const result = await reader.poll('pub-int');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('signal');
    });
  });

  describe('publish data-only (full flow)', () => {
    it('publishes data without type via handler', async () => {
      const { runChannelCreate } =
        await import('../../packages/cli/src/commands/channel');
      const { runPublish } =
        await import('../../packages/cli/src/commands/publish');

      const adminClient = await makeAdminClient();
      const ch = await runChannelCreate(
        'file-int',
        { name: 'File Int', public: true },
        adminClient,
      );

      const pubClient = makeClient(ch.publish_token);
      const event = await runPublish(
        'file-int',
        {
          data: '{"hello":"world"}',
        },
        pubClient,
      );
      expect(event.id).toBeTruthy();
    });
  });

  describe('status (full flow)', () => {
    it('fetches server discovery and identity via handler', async () => {
      const { runStatus } =
        await import('../../packages/cli/src/commands/status');
      const client = makeClient();

      const result = await runStatus(client);
      expect(result.discovery.algorithm).toBe('Ed25519');
      expect(result.discovery.delivery).toContain('poll');
      expect(result.identity.name).toBe('Zooid');
    });
  });

  describe('subscribe webhook (full flow)', () => {
    it('registers a webhook via handler', async () => {
      const { runChannelCreate } =
        await import('../../packages/cli/src/commands/channel');
      const { runSubscribeWebhook } =
        await import('../../packages/cli/src/commands/subscribe');

      const adminClient = await makeAdminClient();
      await runChannelCreate(
        'wh-int',
        { name: 'WH Int', public: true },
        adminClient,
      );

      const result = await runSubscribeWebhook(
        'wh-int',
        'https://example.com/hook',
        adminClient,
      );
      expect(result.id).toBeTruthy();
      expect(result.url).toBe('https://example.com/hook');
    });
  });

  describe('server meta (full flow)', () => {
    it('gets and sets server metadata via handlers', async () => {
      const { runServerGet, runServerSet } =
        await import('../../packages/cli/src/commands/server');
      const adminClient = await makeAdminClient();
      const reader = makeClient();

      // Get defaults
      const defaults = await runServerGet(reader);
      expect(defaults.name).toBe('Zooid');
      expect(defaults.tags).toEqual([]);

      // Set
      const updated = await runServerSet(
        {
          name: 'My Server',
          tags: ['ai', 'crypto'],
          owner: 'tester',
        },
        adminClient,
      );
      expect(updated.name).toBe('My Server');
      expect(updated.tags).toEqual(['ai', 'crypto']);

      // Get back
      const fetched = await runServerGet(reader);
      expect(fetched.name).toBe('My Server');
      expect(fetched.owner).toBe('tester');
    });
  });
});
