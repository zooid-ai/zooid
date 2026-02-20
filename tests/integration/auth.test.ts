import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../packages/server/src/index';
import { createToken } from '../../packages/server/src/lib/jwt';
import { setupTestDb, cleanTestDb } from '../../packages/server/src/test-utils';

const JWT_SECRET = 'test-jwt-secret';

/** Make a raw HTTP request through the Hono app */
function req(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return app.request(
    path,
    {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    },
    { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
  );
}

/** Create a channel via admin token, return create response JSON */
async function createChannel(id: string, opts: { is_public?: boolean } = {}) {
  const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
  const res = await req('/api/v1/channels', {
    method: 'POST',
    token: adminToken,
    body: {
      id,
      name: id,
      is_public: opts.is_public ?? true,
    },
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe('Auth Integration Tests', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('publish auth', () => {
    it('rejects publish without any token → 401', async () => {
      await createChannel('pub-ch', { is_public: true });
      const res = await req('/api/v1/channels/pub-ch/events', {
        method: 'POST',
        body: { type: 'test', data: {} },
      });
      expect(res.status).toBe(401);
    });

    it('rejects publish with subscribe token → 403', async () => {
      await createChannel('pub-ch', { is_public: true });
      const subToken = await createToken(
        { scope: 'subscribe', channel: 'pub-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels/pub-ch/events', {
        method: 'POST',
        token: subToken,
        body: { type: 'test', data: {} },
      });
      expect(res.status).toBe(403);
    });

    it('rejects publish with publish token for different channel → 403', async () => {
      await createChannel('pub-ch-a', { is_public: true });
      await createChannel('pub-ch-b', { is_public: true });
      const tokenA = await createToken(
        { scope: 'publish', channel: 'pub-ch-a' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels/pub-ch-b/events', {
        method: 'POST',
        token: tokenA,
        body: { type: 'test', data: {} },
      });
      expect(res.status).toBe(403);
    });

    it('allows publish with admin token → 200', async () => {
      await createChannel('pub-ch', { is_public: true });
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const res = await req('/api/v1/channels/pub-ch/events', {
        method: 'POST',
        token: adminToken,
        body: { type: 'test', data: {} },
      });
      expect(res.status).toBe(201);
    });

    it('rejects publish with expired token → 401', async () => {
      await createChannel('pub-ch', { is_public: true });
      const expiredToken = await createToken(
        { scope: 'publish', channel: 'pub-ch' },
        JWT_SECRET,
        { expiresIn: -60 }, // expired 60 seconds ago
      );
      const res = await req('/api/v1/channels/pub-ch/events', {
        method: 'POST',
        token: expiredToken,
        body: { type: 'test', data: {} },
      });
      expect(res.status).toBe(401);
    });

    it('rejects publish with garbage/malformed token → 401', async () => {
      await createChannel('pub-ch', { is_public: true });
      const res = await req('/api/v1/channels/pub-ch/events', {
        method: 'POST',
        token: 'not.a.valid.jwt.token',
        body: { type: 'test', data: {} },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('private channel auth', () => {
    it('rejects poll on private channel without token → 401', async () => {
      await createChannel('priv-ch', { is_public: false });
      const res = await req('/api/v1/channels/priv-ch/events');
      expect(res.status).toBe(401);
    });

    it('rejects poll on private channel with publish token → 403', async () => {
      await createChannel('priv-ch', { is_public: false });
      const pubToken = await createToken(
        { scope: 'publish', channel: 'priv-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels/priv-ch/events', {
        token: pubToken,
      });
      expect(res.status).toBe(403);
    });

    it('rejects poll on private channel with subscribe token for different channel → 403', async () => {
      await createChannel('priv-ch-a', { is_public: false });
      await createChannel('priv-ch-b', { is_public: false });
      const subTokenA = await createToken(
        { scope: 'subscribe', channel: 'priv-ch-a' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels/priv-ch-b/events', {
        token: subTokenA,
      });
      expect(res.status).toBe(403);
    });

    it('allows poll on private channel with correct subscribe token → 200', async () => {
      await createChannel('priv-ch', { is_public: false });
      const subToken = await createToken(
        { scope: 'subscribe', channel: 'priv-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels/priv-ch/events', {
        token: subToken,
      });
      expect(res.status).toBe(200);
    });

    it('allows poll on private channel with admin token → 200', async () => {
      await createChannel('priv-ch', { is_public: false });
      const adminToken = await createToken({ scope: 'admin' }, JWT_SECRET);
      const res = await req('/api/v1/channels/priv-ch/events', {
        token: adminToken,
      });
      expect(res.status).toBe(200);
    });

    it('allows poll on private channel with token as query param → 200', async () => {
      await createChannel('priv-ch', { is_public: false });
      const subToken = await createToken(
        { scope: 'subscribe', channel: 'priv-ch' },
        JWT_SECRET,
      );
      const res = await req(
        `/api/v1/channels/priv-ch/events?token=${subToken}`,
      );
      expect(res.status).toBe(200);
    });

    it('rejects webhook registration on private channel without token → 401', async () => {
      await createChannel('priv-ch', { is_public: false });
      const res = await req('/api/v1/channels/priv-ch/webhooks', {
        method: 'POST',
        body: {
          url: 'https://example.com/hook',
          event_types: ['*'],
        },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('admin routes', () => {
    it('rejects create channel without token → 401', async () => {
      const res = await req('/api/v1/channels', {
        method: 'POST',
        body: { id: 'test-ch', name: 'Test' },
      });
      expect(res.status).toBe(401);
    });

    it('rejects create channel with publish token → 403', async () => {
      const pubToken = await createToken(
        { scope: 'publish', channel: 'some-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels', {
        method: 'POST',
        token: pubToken,
        body: { id: 'test-ch', name: 'Test' },
      });
      expect(res.status).toBe(403);
    });

    it('rejects create channel with subscribe token → 403', async () => {
      const subToken = await createToken(
        { scope: 'subscribe', channel: 'some-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels', {
        method: 'POST',
        token: subToken,
        body: { id: 'test-ch', name: 'Test' },
      });
      expect(res.status).toBe(403);
    });

    it('rejects add publisher without admin token → 403', async () => {
      await createChannel('admin-ch', { is_public: true });
      const pubToken = await createToken(
        { scope: 'publish', channel: 'admin-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/channels/admin-ch/publishers', {
        method: 'POST',
        token: pubToken,
        body: { name: 'my-bot' },
      });
      expect(res.status).toBe(403);
    });

    it('rejects directory claim without token → 401', async () => {
      const res = await req('/api/v1/directory/claim', {
        method: 'POST',
        body: { channels: ['any-ch'] },
      });
      expect(res.status).toBe(401);
    });

    it('rejects directory claim with publish token → 403', async () => {
      const pubToken = await createToken(
        { scope: 'publish', channel: 'any-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/directory/claim', {
        method: 'POST',
        token: pubToken,
        body: { channels: ['any-ch'] },
      });
      expect(res.status).toBe(403);
    });

    it('rejects directory claim with subscribe token → 403', async () => {
      const subToken = await createToken(
        { scope: 'subscribe', channel: 'any-ch' },
        JWT_SECRET,
      );
      const res = await req('/api/v1/directory/claim', {
        method: 'POST',
        token: subToken,
        body: { channels: ['any-ch'] },
      });
      expect(res.status).toBe(403);
    });

    it('rejects delete webhook without admin token → 401', async () => {
      await createChannel('admin-ch', { is_public: true });
      const res = await req(
        '/api/v1/channels/admin-ch/webhooks/fake-webhook-id',
        { method: 'DELETE' },
      );
      expect(res.status).toBe(401);
    });
  });

  describe('public channel access', () => {
    it('allows poll on public channel without any token → 200', async () => {
      await createChannel('public-ch', { is_public: true });
      const res = await req('/api/v1/channels/public-ch/events');
      expect(res.status).toBe(200);
    });

    it('allows webhook registration on public channel without token → 200', async () => {
      await createChannel('public-ch', { is_public: true });
      const res = await req('/api/v1/channels/public-ch/webhooks', {
        method: 'POST',
        body: {
          url: 'https://example.com/hook',
          event_types: ['*'],
        },
      });
      expect(res.status).toBe(201);
    });
  });

  describe('cross-channel isolation', () => {
    it('publish token for channel A cannot publish to channel B', async () => {
      await createChannel('iso-a', { is_public: true });
      await createChannel('iso-b', { is_public: true });
      const tokenA = await createToken(
        { scope: 'publish', channel: 'iso-a' },
        JWT_SECRET,
      );

      // Can publish to A
      const resA = await req('/api/v1/channels/iso-a/events', {
        method: 'POST',
        token: tokenA,
        body: { type: 'test', data: {} },
      });
      expect(resA.status).toBe(201);

      // Cannot publish to B
      const resB = await req('/api/v1/channels/iso-b/events', {
        method: 'POST',
        token: tokenA,
        body: { type: 'test', data: {} },
      });
      expect(resB.status).toBe(403);
    });

    it('subscribe token for channel A cannot read private channel B', async () => {
      await createChannel('iso-a', { is_public: false });
      await createChannel('iso-b', { is_public: false });
      const tokenA = await createToken(
        { scope: 'subscribe', channel: 'iso-a' },
        JWT_SECRET,
      );

      // Can read A
      const resA = await req('/api/v1/channels/iso-a/events', {
        token: tokenA,
      });
      expect(resA.status).toBe(200);

      // Cannot read B
      const resB = await req('/api/v1/channels/iso-b/events', {
        token: tokenA,
      });
      expect(resB.status).toBe(403);
    });
  });
});
