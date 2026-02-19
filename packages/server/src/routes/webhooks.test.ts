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

describe('Webhook routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'wh-channel',
        name: 'WH Channel',
        is_public: true,
      }),
    });
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'priv-wh',
        name: 'Private WH',
        is_public: false,
      }),
    });
  });

  describe('POST /channels/:channelId/webhooks', () => {
    it('registers a webhook on a public channel (no auth) with default 3-day TTL', async () => {
      const res = await app.request(
        '/api/v1/channels/wh-channel/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/hook',
            event_types: ['signal'],
          }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        channel_id: string;
        url: string;
        expires_at: string;
      };
      expect(body.id).toBeTruthy();
      expect(body.channel_id).toBe('wh-channel');
      expect(body.url).toBe('https://example.com/hook');
      expect(body.expires_at).toBeTruthy();
    });

    it('registers a webhook with custom ttl_seconds', async () => {
      const res = await app.request(
        '/api/v1/channels/wh-channel/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/hook',
            ttl_seconds: 3600,
          }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { expires_at: string };
      const expiresAt = new Date(body.expires_at).getTime();
      const oneHourFromNow = Date.now() + 3600 * 1000;
      expect(Math.abs(expiresAt - oneHourFromNow)).toBeLessThan(5000);
    });

    it('re-registering same URL extends TTL (upsert)', async () => {
      const res1 = await app.request(
        '/api/v1/channels/wh-channel/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/hook',
            ttl_seconds: 3600,
          }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const body1 = (await res1.json()) as { id: string; expires_at: string };

      const res2 = await app.request(
        '/api/v1/channels/wh-channel/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/hook',
            ttl_seconds: 86400,
          }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res2.status).toBe(201);
      const body2 = (await res2.json()) as { id: string; expires_at: string };
      expect(body2.id).toBe(body1.id);
      expect(new Date(body2.expires_at).getTime()).toBeGreaterThan(
        new Date(body1.expires_at).getTime(),
      );
    });

    it('requires subscribe token for private channel', async () => {
      const res = await app.request(
        '/api/v1/channels/priv-wh/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hook' }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(401);
    });

    it('allows subscribe token for private channel', async () => {
      const token = await createToken(
        { scope: 'subscribe', channel: 'priv-wh', sub: 'sub-1' },
        JWT_SECRET,
      );
      const res = await app.request(
        '/api/v1/channels/priv-wh/webhooks',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: 'https://example.com/hook' }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(201);
    });

    it('rejects missing url', async () => {
      const res = await app.request(
        '/api/v1/channels/wh-channel/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request(
        '/api/v1/channels/nonexistent/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hook' }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /channels/:channelId/webhooks/:webhookId', () => {
    it('deletes a webhook with admin token', async () => {
      const createRes = await app.request(
        '/api/v1/channels/wh-channel/webhooks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hook' }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      const { id: webhookId } = (await createRes.json()) as { id: string };

      const res = await adminRequest(
        `/api/v1/channels/wh-channel/webhooks/${webhookId}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(204);
    });

    it('rejects without admin token', async () => {
      const token = await createToken(
        { scope: 'subscribe', channel: 'wh-channel', sub: 'sub-1' },
        JWT_SECRET,
      );
      const res = await app.request(
        '/api/v1/channels/wh-channel/webhooks/some-id',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent webhook', async () => {
      const res = await adminRequest(
        '/api/v1/channels/wh-channel/webhooks/nonexistent',
        { method: 'DELETE' },
      );
      expect(res.status).toBe(404);
    });
  });
});
