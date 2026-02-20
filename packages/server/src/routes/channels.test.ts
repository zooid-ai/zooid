import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../index';
import { setupTestDb, cleanTestDb } from '../test-utils';
import { createToken } from '../lib/jwt';

const JWT_SECRET = 'test-jwt-secret';

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
    { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
  );
}

describe('Channel routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('POST /channels', () => {
    it('creates a channel with admin token', async () => {
      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'test-channel',
          name: 'Test Channel',
          description: 'A test channel',
          is_public: true,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        publish_token: string;
        subscribe_token: string;
      };
      expect(body.id).toBe('test-channel');
      expect(body.publish_token).toBeTruthy();
      expect(body.subscribe_token).toBeTruthy();
    });

    it('rejects without auth', async () => {
      const res = await app.request(
        '/api/v1/channels',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'test-channel', name: 'Test Channel' }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(401);
    });

    it('rejects with non-admin token', async () => {
      const res = await authRequest(
        '/api/v1/channels',
        {
          method: 'POST',
          body: JSON.stringify({ id: 'test-channel', name: 'Test Channel' }),
        },
        'publish',
        'some-channel',
      );

      expect(res.status).toBe(403);
    });

    it('rejects invalid channel ID (too short)', async () => {
      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'ab', name: 'Bad Channel' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects invalid channel ID (uppercase)', async () => {
      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'MyChannel', name: 'Bad Channel' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects duplicate channel ID', async () => {
      await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'test-channel', name: 'Test Channel' }),
      });

      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'test-channel', name: 'Duplicate' }),
      });

      expect(res.status).toBe(409);
    });

    it('accepts optional schema field', async () => {
      const schema = {
        type: 'object',
        properties: { market: { type: 'string' } },
        required: ['market'],
      };

      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'schema-channel',
          name: 'Schema Channel',
          schema,
        }),
      });

      expect(res.status).toBe(201);
    });

    it('creates a strict channel with schema', async () => {
      const schema = {
        alert: {
          required: ['level'],
          properties: { level: { type: 'string' } },
        },
      };

      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'strict-channel',
          name: 'Strict Channel',
          schema,
          strict: true,
        }),
      });

      expect(res.status).toBe(201);
    });

    it('rejects strict channel without schema', async () => {
      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'strict-no-schema',
          name: 'Bad Strict',
          strict: true,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('schema');
    });

    it('creates a channel with tags', async () => {
      const res = await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'tagged-channel',
          name: 'Tagged Channel',
          tags: ['ai', 'crypto'],
        }),
      });

      expect(res.status).toBe(201);
    });
  });

  describe('GET /channels', () => {
    it('returns empty list when no channels exist', async () => {
      const res = await app.request(
        '/api/v1/channels',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { channels: unknown[] };
      expect(body.channels).toEqual([]);
    });

    it('lists all channels (no auth required)', async () => {
      await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'channel-a', name: 'Channel A' }),
      });
      await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'channel-b', name: 'Channel B' }),
      });

      const res = await app.request(
        '/api/v1/channels',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        channels: Array<{ id: string; name: string }>;
      };
      expect(body.channels).toHaveLength(2);
      expect(body.channels[0].id).toBeTruthy();
      expect(body.channels[0].name).toBeTruthy();
    });

    it('lists channels with tags', async () => {
      await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'tagged-list',
          name: 'Tagged List',
          tags: ['ai', 'agents'],
        }),
      });

      const res = await app.request(
        '/api/v1/channels',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body = (await res.json()) as {
        channels: Array<{ id: string; tags: string[] }>;
      };

      const ch = body.channels.find((c) => c.id === 'tagged-list')!;
      expect(ch.tags).toEqual(['ai', 'agents']);
    });

    it('lists channels without tags as empty array', async () => {
      await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'no-tags-list',
          name: 'No Tags',
        }),
      });

      const res = await app.request(
        '/api/v1/channels',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body = (await res.json()) as {
        channels: Array<{ id: string; tags: string[] }>;
      };

      const ch = body.channels.find((c) => c.id === 'no-tags-list')!;
      expect(ch.tags).toEqual([]);
    });

    it('includes event_count and last_event_at fields', async () => {
      await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'count-channel', name: 'Count Channel' }),
      });

      const res = await app.request(
        '/api/v1/channels',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body = (await res.json()) as {
        channels: Array<{ event_count: number; last_event_at: string | null }>;
      };

      expect(body.channels[0]).toHaveProperty('event_count');
      expect(body.channels[0]).toHaveProperty('last_event_at');
    });
  });

  describe('POST /channels/:channelId/publishers', () => {
    it('adds a publisher to a channel', async () => {
      await authRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({ id: 'pub-channel', name: 'Pub Channel' }),
      });

      const res = await authRequest('/api/v1/channels/pub-channel/publishers', {
        method: 'POST',
        body: JSON.stringify({ name: 'whale-bot' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        name: string;
        publish_token: string;
      };
      expect(body.id).toBeTruthy();
      expect(body.name).toBe('whale-bot');
      expect(body.publish_token).toBeTruthy();
    });

    it('rejects without admin token', async () => {
      const res = await authRequest(
        '/api/v1/channels/pub-channel/publishers',
        {
          method: 'POST',
          body: JSON.stringify({ name: 'whale-bot' }),
        },
        'subscribe',
        'pub-channel',
      );

      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await authRequest('/api/v1/channels/nonexistent/publishers', {
        method: 'POST',
        body: JSON.stringify({ name: 'whale-bot' }),
      });

      expect(res.status).toBe(404);
    });
  });
});
