import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../index';
import { setupTestDb, cleanTestDb } from '../test-utils';
import { createToken } from '../lib/jwt';

const JWT_SECRET = 'test-jwt-secret';

async function adminRequest(path: string, options: RequestInit = {}) {
  const token = await createToken({ scope: 'admin' }, JWT_SECRET);
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  return app.request(
    path,
    { ...options, headers },
    {
      ...env,
      ZOOID_JWT_SECRET: JWT_SECRET,
    },
  );
}

async function publishRequest(
  path: string,
  options: RequestInit = {},
  channel: string,
) {
  const token = await createToken(
    { scope: 'publish', channel, sub: 'test-publisher' },
    JWT_SECRET,
  );
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  return app.request(
    path,
    { ...options, headers },
    {
      ...env,
      ZOOID_JWT_SECRET: JWT_SECRET,
    },
  );
}

async function subscribeRequest(path: string, channel: string) {
  const token = await createToken(
    { scope: 'subscribe', channel, sub: 'test-subscriber' },
    JWT_SECRET,
  );
  return app.request(
    path,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
  );
}

describe('Event routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'pub-channel',
        name: 'Public Channel',
        is_public: true,
      }),
    });
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'priv-channel',
        name: 'Private Channel',
        is_public: false,
      }),
    });
  });

  describe('POST /channels/:channelId/events (publish)', () => {
    it('publishes a single event', async () => {
      const res = await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'signal',
            data: { message: 'hello' },
          }),
        },
        'pub-channel',
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        channel_id: string;
        type: string;
        publisher_id: string;
        created_at: string;
      };
      expect(body.id).toBeTruthy();
      expect(body.channel_id).toBe('pub-channel');
      expect(body.type).toBe('signal');
      expect(body.publisher_id).toBe('test-publisher');
      expect(body.created_at).toBeTruthy();
    });

    it('publishes a batch of events', async () => {
      const res = await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            events: [
              { type: 'a', data: { v: 1 } },
              { type: 'b', data: { v: 2 } },
            ],
          }),
        },
        'pub-channel',
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        events: Array<{ id: string }>;
      };
      expect(body.events).toHaveLength(2);
      expect(body.events[0].id).toBeTruthy();
      expect(body.events[1].id).toBeTruthy();
    });

    it('rejects without publish token', async () => {
      const res = await app.request(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'x', data: {} }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(401);
    });

    it('rejects publish token for wrong channel', async () => {
      const res = await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ type: 'x', data: {} }),
        },
        'other-channel',
      );
      expect(res.status).toBe(403);
    });

    it('rejects missing data field', async () => {
      const res = await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ type: 'x' }),
        },
        'pub-channel',
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await publishRequest(
        '/api/v1/channels/nonexistent/events',
        {
          method: 'POST',
          body: JSON.stringify({ type: 'x', data: {} }),
        },
        'nonexistent',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('Strict schema validation', () => {
    const strictSchema = {
      alert: {
        required: ['level', 'message'],
        properties: {
          level: { type: 'string', enum: ['info', 'warn', 'error'] },
          message: { type: 'string' },
        },
      },
      metric: {
        required: ['name', 'value'],
        properties: {
          name: { type: 'string' },
          value: { type: 'number' },
        },
      },
    };

    beforeEach(async () => {
      await adminRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'strict-channel',
          name: 'Strict Channel',
          schema: strictSchema,
          strict: true,
        }),
      });
      await adminRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'doconly-channel',
          name: 'Doc-Only Channel',
          schema: strictSchema,
          strict: false,
        }),
      });
    });

    it('strict channel accepts valid event', async () => {
      const res = await publishRequest(
        '/api/v1/channels/strict-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'alert',
            data: { level: 'info', message: 'hello' },
          }),
        },
        'strict-channel',
      );
      expect(res.status).toBe(201);
    });

    it('strict channel rejects event with no type', async () => {
      const res = await publishRequest(
        '/api/v1/channels/strict-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ data: { level: 'info', message: 'hello' } }),
        },
        'strict-channel',
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('must have a type');
    });

    it('strict channel rejects event with unknown type', async () => {
      const res = await publishRequest(
        '/api/v1/channels/strict-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ type: 'unknown', data: { foo: 'bar' } }),
        },
        'strict-channel',
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Unknown event type');
    });

    it('strict channel rejects event with wrong data shape', async () => {
      const res = await publishRequest(
        '/api/v1/channels/strict-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'metric',
            data: { name: 'cpu', value: 'not-a-number' },
          }),
        },
        'strict-channel',
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Validation failed');
    });

    it('strict channel validates batch events', async () => {
      const res = await publishRequest(
        '/api/v1/channels/strict-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            events: [
              { type: 'alert', data: { level: 'info', message: 'ok' } },
              { type: 'metric', data: { name: 'cpu', value: 'bad' } },
            ],
          }),
        },
        'strict-channel',
      );
      expect(res.status).toBe(400);
    });

    it('non-strict channel with schema does NOT validate', async () => {
      const res = await publishRequest(
        '/api/v1/channels/doconly-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'unknown-type',
            data: { anything: true },
          }),
        },
        'doconly-channel',
      );
      expect(res.status).toBe(201);
    });

    it('channel without schema is unaffected', async () => {
      const res = await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ data: { anything: true } }),
        },
        'pub-channel',
      );
      expect(res.status).toBe(201);
    });
  });

  describe('GET /channels/:channelId/events (poll)', () => {
    it('polls events from a public channel without auth', async () => {
      await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ type: 'signal', data: { v: 1 } }),
        },
        'pub-channel',
      );

      const res = await app.request(
        '/api/v1/channels/pub-channel/events',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: Array<{ type: string }>;
        has_more: boolean;
      };
      expect(body.events).toHaveLength(1);
      expect(body.events[0].type).toBe('signal');
      expect(body.has_more).toBe(false);
    });

    it('requires subscribe token for private channel', async () => {
      const res = await app.request(
        '/api/v1/channels/priv-channel/events',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(401);
    });

    it('allows subscribe token for private channel', async () => {
      const res = await subscribeRequest(
        '/api/v1/channels/priv-channel/events',
        'priv-channel',
      );
      expect(res.status).toBe(200);
    });

    it('supports limit query param', async () => {
      for (let i = 0; i < 5; i++) {
        await publishRequest(
          '/api/v1/channels/pub-channel/events',
          {
            method: 'POST',
            body: JSON.stringify({ type: 'evt', data: { i } }),
          },
          'pub-channel',
        );
      }

      const res = await app.request(
        '/api/v1/channels/pub-channel/events?limit=2',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body = (await res.json()) as {
        events: unknown[];
        has_more: boolean;
        cursor: string;
      };
      expect(body.events).toHaveLength(2);
      expect(body.has_more).toBe(true);
      expect(body.cursor).toBeTruthy();
    });

    it('supports cursor pagination', async () => {
      for (let i = 0; i < 3; i++) {
        await publishRequest(
          '/api/v1/channels/pub-channel/events',
          {
            method: 'POST',
            body: JSON.stringify({ type: 'evt', data: { i } }),
          },
          'pub-channel',
        );
      }

      const page1 = await app.request(
        '/api/v1/channels/pub-channel/events?limit=2',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body1 = (await page1.json()) as {
        cursor: string;
        events: unknown[];
      };

      const page2 = await app.request(
        `/api/v1/channels/pub-channel/events?limit=2&cursor=${body1.cursor}`,
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body2 = (await page2.json()) as {
        events: unknown[];
        has_more: boolean;
      };
      expect(body2.events).toHaveLength(1);
      expect(body2.has_more).toBe(false);
    });

    it('supports type filter', async () => {
      await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ type: 'signal', data: {} }),
        },
        'pub-channel',
      );
      await publishRequest(
        '/api/v1/channels/pub-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({ type: 'alert', data: {} }),
        },
        'pub-channel',
      );

      const res = await app.request(
        '/api/v1/channels/pub-channel/events?type=signal',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body = (await res.json()) as {
        events: Array<{ type: string }>;
      };
      expect(body.events).toHaveLength(1);
      expect(body.events[0].type).toBe('signal');
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request(
        '/api/v1/channels/nonexistent/events',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(404);
    });
  });
});
