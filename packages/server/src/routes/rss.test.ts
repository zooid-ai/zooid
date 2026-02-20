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
    { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
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
    { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
  );
}

describe('RSS routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'rss-channel',
        name: 'RSS Channel',
        description: 'Test RSS feed',
        is_public: true,
      }),
    });
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'priv-rss',
        name: 'Private RSS',
        is_public: false,
      }),
    });
  });

  describe('GET /channels/:channelId/rss', () => {
    it('returns valid RSS XML with correct content type', async () => {
      await publishRequest(
        '/api/v1/channels/rss-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'signal',
            data: { market: 'test', shift: 0.05 },
          }),
        },
        'rss-channel',
      );

      const res = await app.request(
        '/api/v1/channels/rss-channel/rss',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/rss+xml');

      const xml = await res.text();
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<rss version="2.0">');
      expect(xml).toContain('<title>RSS Channel</title>');
      expect(xml).toContain('<description>Test RSS feed</description>');
      expect(xml).toContain('<item>');
      expect(xml).toContain('<guid>');
    });

    it('formats data as YAML by default', async () => {
      await publishRequest(
        '/api/v1/channels/rss-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'signal',
            data: { market: 'election', shift: 0.07 },
          }),
        },
        'rss-channel',
      );

      const res = await app.request(
        '/api/v1/channels/rss-channel/rss',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const xml = await res.text();
      // YAML-style: key: value
      expect(xml).toContain('market: election');
      expect(xml).toContain('shift: 0.07');
    });

    it('formats data as JSON when format=json', async () => {
      await publishRequest(
        '/api/v1/channels/rss-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'signal',
            data: { market: 'election' },
          }),
        },
        'rss-channel',
      );

      const res = await app.request(
        '/api/v1/channels/rss-channel/rss?format=json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const xml = await res.text();
      // JSON stays raw inside CDATA
      expect(xml).toContain('"market"');
    });

    it('includes event type and publisher in title', async () => {
      await publishRequest(
        '/api/v1/channels/rss-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'odds_shift',
            data: { v: 1 },
          }),
        },
        'rss-channel',
      );

      const res = await app.request(
        '/api/v1/channels/rss-channel/rss',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const xml = await res.text();
      expect(xml).toContain('[odds_shift]');
      expect(xml).toContain('test-publisher');
    });

    it('returns empty feed when no events', async () => {
      const res = await app.request(
        '/api/v1/channels/rss-channel/rss',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain('<rss version="2.0">');
      expect(xml).not.toContain('<item>');
    });

    it('allows public channel without auth', async () => {
      const res = await app.request(
        '/api/v1/channels/rss-channel/rss',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
    });

    it('requires token query param for private channel', async () => {
      const res = await app.request(
        '/api/v1/channels/priv-rss/rss',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(401);
    });

    it('accepts token via query param for private channel', async () => {
      const token = await createToken(
        { scope: 'subscribe', channel: 'priv-rss', sub: 'sub-1' },
        JWT_SECRET,
      );
      const res = await app.request(
        `/api/v1/channels/priv-rss/rss?token=${token}`,
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request(
        '/api/v1/channels/nonexistent/rss',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(404);
    });
  });
});
