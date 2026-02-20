import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { setupTestDb, cleanTestDb } from '../test-utils';
import {
  createChannel,
  listChannels,
  createEvent,
  createEvents,
  pollEvents,
  cleanupExpiredEvents,
  createWebhook,
  deleteWebhook,
  getWebhooksForChannel,
  getServerMeta,
  upsertServerMeta,
} from './queries';

describe('Event queries', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
    await createChannel(env.DB, {
      id: 'test-channel',
      name: 'Test Channel',
    });
  });

  describe('createEvent', () => {
    it('creates an event with ULID and returns it', async () => {
      const event = await createEvent(env.DB, {
        channelId: 'test-channel',
        publisherId: 'pub-1',
        type: 'signal',
        data: { message: 'hello' },
      });

      expect(event.id).toHaveLength(26); // ULID
      expect(event.channel_id).toBe('test-channel');
      expect(event.publisher_id).toBe('pub-1');
      expect(event.type).toBe('signal');
      expect(event.data).toBe(JSON.stringify({ message: 'hello' }));
      expect(event.created_at).toBeTruthy();
    });

    it('rejects payloads over 64KB', async () => {
      const bigData = { content: 'x'.repeat(65 * 1024) };
      await expect(
        createEvent(env.DB, {
          channelId: 'test-channel',
          data: bigData,
        }),
      ).rejects.toThrow(/64KB/);
    });
  });

  describe('createEvents (batch)', () => {
    it('creates multiple events atomically', async () => {
      const events = await createEvents(env.DB, 'test-channel', 'pub-1', [
        { type: 'a', data: { v: 1 } },
        { type: 'b', data: { v: 2 } },
      ]);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('a');
      expect(events[1].type).toBe('b');
      // ULIDs should be monotonically ordered
      expect(events[1].id > events[0].id).toBe(true);
    });

    it('rejects batches over 100 events', async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        type: 'x',
        data: { i },
      }));
      await expect(
        createEvents(env.DB, 'test-channel', null, tooMany),
      ).rejects.toThrow(/100/);
    });
  });

  describe('pollEvents', () => {
    it('returns events for a channel ordered by creation', async () => {
      await createEvent(env.DB, {
        channelId: 'test-channel',
        type: 'first',
        data: { n: 1 },
      });
      await createEvent(env.DB, {
        channelId: 'test-channel',
        type: 'second',
        data: { n: 2 },
      });

      const result = await pollEvents(env.DB, 'test-channel', {});
      expect(result.events).toHaveLength(2);
      expect(result.events[0].type).toBe('first');
      expect(result.events[1].type).toBe('second');
      expect(result.has_more).toBe(false);
    });

    it('filters by type', async () => {
      await createEvent(env.DB, {
        channelId: 'test-channel',
        type: 'signal',
        data: {},
      });
      await createEvent(env.DB, {
        channelId: 'test-channel',
        type: 'alert',
        data: {},
      });

      const result = await pollEvents(env.DB, 'test-channel', {
        type: 'signal',
      });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('signal');
    });

    it('supports cursor-based pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await createEvent(env.DB, {
          channelId: 'test-channel',
          type: 'evt',
          data: { i },
        });
      }

      const page1 = await pollEvents(env.DB, 'test-channel', { limit: 2 });
      expect(page1.events).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeTruthy();

      const page2 = await pollEvents(env.DB, 'test-channel', {
        limit: 2,
        cursor: page1.cursor!,
      });
      expect(page2.events).toHaveLength(2);
      expect(page2.has_more).toBe(true);

      const page3 = await pollEvents(env.DB, 'test-channel', {
        limit: 2,
        cursor: page2.cursor!,
      });
      expect(page3.events).toHaveLength(1);
      expect(page3.has_more).toBe(false);
    });

    it('supports since parameter (ISO timestamp)', async () => {
      await env.DB.prepare(
        `INSERT INTO events (id, channel_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          '00000000000000000000000001',
          'test-channel',
          'old',
          '{}',
          '2026-02-01T00:00:00Z',
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO events (id, channel_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          '00000000000000000000000002',
          'test-channel',
          'new',
          '{}',
          '2026-02-17T00:00:00Z',
        )
        .run();

      const result = await pollEvents(env.DB, 'test-channel', {
        since: '2026-02-10T00:00:00Z',
      });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('new');
    });

    it('defaults to limit of 50', async () => {
      const result = await pollEvents(env.DB, 'test-channel', {});
      expect(result.events).toBeInstanceOf(Array);
    });
  });

  describe('cleanupExpiredEvents', () => {
    it('deletes events older than 7 days', async () => {
      await env.DB.prepare(
        `INSERT INTO events (id, channel_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          '00000000000000000000000001',
          'test-channel',
          'old',
          '{}',
          '2020-01-01T00:00:00Z',
        )
        .run();
      await createEvent(env.DB, {
        channelId: 'test-channel',
        type: 'fresh',
        data: {},
      });

      const deleted = await cleanupExpiredEvents(env.DB, 'test-channel');
      expect(deleted).toBe(1);

      const result = await pollEvents(env.DB, 'test-channel', {});
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('fresh');
    });
  });
});

describe('Webhook queries', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
    await createChannel(env.DB, { id: 'wh-channel', name: 'WH Channel' });
  });

  describe('createWebhook', () => {
    it('creates a webhook for a channel with default 3-day TTL', async () => {
      const webhook = await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://example.com/hook',
        eventTypes: ['signal'],
      });

      expect(webhook.id).toBeTruthy();
      expect(webhook.channel_id).toBe('wh-channel');
      expect(webhook.url).toBe('https://example.com/hook');
      expect(webhook.expires_at).toBeTruthy();
      const expiresAt = new Date(webhook.expires_at).getTime();
      const threeDaysFromNow = Date.now() + 3 * 24 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt - threeDaysFromNow)).toBeLessThan(5000);
    });

    it('creates a webhook with custom TTL', async () => {
      const webhook = await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://example.com/hook',
        ttlSeconds: 3600,
      });

      expect(webhook.id).toBeTruthy();
      const expiresAt = new Date(webhook.expires_at).getTime();
      const oneHourFromNow = Date.now() + 3600 * 1000;
      expect(Math.abs(expiresAt - oneHourFromNow)).toBeLessThan(5000);
    });

    it('creates a webhook with no event type filter', async () => {
      const webhook = await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://example.com/hook',
      });

      expect(webhook.id).toBeTruthy();
    });

    it('re-registration of same URL extends expires_at (upsert)', async () => {
      const wh1 = await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://example.com/hook',
        ttlSeconds: 3600,
      });

      const wh2 = await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://example.com/hook',
        ttlSeconds: 86400,
      });

      expect(wh2.id).toBe(wh1.id);
      const expires1 = new Date(wh1.expires_at).getTime();
      const expires2 = new Date(wh2.expires_at).getTime();
      expect(expires2).toBeGreaterThan(expires1);

      const webhooks = await getWebhooksForChannel(env.DB, 'wh-channel');
      expect(webhooks).toHaveLength(1);
    });
  });

  describe('deleteWebhook', () => {
    it('deletes a webhook by ID', async () => {
      const webhook = await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://example.com/hook',
      });

      const deleted = await deleteWebhook(env.DB, webhook.id, 'wh-channel');
      expect(deleted).toBe(true);

      const webhooks = await getWebhooksForChannel(env.DB, 'wh-channel');
      expect(webhooks).toHaveLength(0);
    });

    it('returns false for non-existent webhook', async () => {
      const deleted = await deleteWebhook(env.DB, 'nonexistent', 'wh-channel');
      expect(deleted).toBe(false);
    });
  });

  describe('getWebhooksForChannel', () => {
    it('returns all non-expired webhooks for a channel', async () => {
      await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://a.com/hook',
      });
      await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://b.com/hook',
        eventTypes: ['alert'],
      });

      const webhooks = await getWebhooksForChannel(env.DB, 'wh-channel');
      expect(webhooks).toHaveLength(2);
    });

    it('filters by event type when provided', async () => {
      await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://a.com/hook',
        eventTypes: ['signal'],
      });
      await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://b.com/hook',
      });

      const webhooks = await getWebhooksForChannel(
        env.DB,
        'wh-channel',
        'signal',
      );
      expect(webhooks).toHaveLength(2);
    });

    it('excludes expired webhooks', async () => {
      await env.DB.prepare(
        `INSERT INTO webhooks (id, channel_id, url, expires_at) VALUES (?, ?, ?, ?)`,
      )
        .bind(
          'expired-wh',
          'wh-channel',
          'https://expired.com/hook',
          '2020-01-01T00:00:00Z',
        )
        .run();

      await createWebhook(env.DB, {
        channelId: 'wh-channel',
        url: 'https://valid.com/hook',
      });

      const webhooks = await getWebhooksForChannel(env.DB, 'wh-channel');
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0].url).toBe('https://valid.com/hook');
    });
  });
});

describe('Channel tags', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  it('creates a channel with tags', async () => {
    const channel = await createChannel(env.DB, {
      id: 'tagged-channel',
      name: 'Tagged Channel',
      tags: ['ai', 'crypto'],
    });

    expect(channel.tags).toBe(JSON.stringify(['ai', 'crypto']));
  });

  it('creates a channel without tags (null)', async () => {
    const channel = await createChannel(env.DB, {
      id: 'no-tags',
      name: 'No Tags',
    });

    expect(channel.tags).toBeNull();
  });

  it('lists channels with parsed tags', async () => {
    await createChannel(env.DB, {
      id: 'tagged',
      name: 'Tagged',
      tags: ['ai', 'agents'],
    });
    await createChannel(env.DB, {
      id: 'untagged',
      name: 'Untagged',
    });

    const channels = await listChannels(env.DB);
    const tagged = channels.find((c) => c.id === 'tagged')!;
    const untagged = channels.find((c) => c.id === 'untagged')!;

    expect(tagged.tags).toEqual(['ai', 'agents']);
    expect(untagged.tags).toEqual([]);
  });
});

describe('Server meta queries', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('getServerMeta', () => {
    it('returns null when no row exists', async () => {
      const meta = await getServerMeta(env.DB);
      expect(meta).toBeNull();
    });

    it('returns the stored metadata', async () => {
      await upsertServerMeta(env.DB, {
        name: 'Test Server',
        description: 'A test',
        tags: ['test'],
      });

      const meta = await getServerMeta(env.DB);
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe('Test Server');
      expect(meta!.description).toBe('A test');
      expect(meta!.tags).toEqual(['test']);
    });
  });

  describe('upsertServerMeta', () => {
    it('inserts a new row with defaults', async () => {
      const meta = await upsertServerMeta(env.DB, {
        name: 'My Server',
      });

      expect(meta.name).toBe('My Server');
      expect(meta.description).toBeNull();
      expect(meta.tags).toEqual([]);
      expect(meta.owner).toBeNull();
      expect(meta.company).toBeNull();
      expect(meta.email).toBeNull();
      expect(meta.updated_at).toBeTruthy();
    });

    it('inserts with all fields', async () => {
      const meta = await upsertServerMeta(env.DB, {
        name: 'Full Server',
        description: 'All fields set',
        tags: ['a', 'b'],
        owner: 'alice',
        company: 'Acme',
        email: 'alice@acme.com',
      });

      expect(meta.name).toBe('Full Server');
      expect(meta.description).toBe('All fields set');
      expect(meta.tags).toEqual(['a', 'b']);
      expect(meta.owner).toBe('alice');
      expect(meta.company).toBe('Acme');
      expect(meta.email).toBe('alice@acme.com');
    });

    it('updates existing row on second call', async () => {
      await upsertServerMeta(env.DB, {
        name: 'First',
        owner: 'alice',
      });

      const meta = await upsertServerMeta(env.DB, {
        name: 'Second',
        owner: 'bob',
      });

      expect(meta.name).toBe('Second');
      expect(meta.owner).toBe('bob');

      // Verify only one row exists
      const result = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM server_meta',
      ).first<{ count: number }>();
      expect(result!.count).toBe(1);
    });
  });
});
