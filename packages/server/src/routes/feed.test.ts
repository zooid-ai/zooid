import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../index';
import { setupTestDb, cleanTestDb } from '../test-utils';
import { createToken } from '../lib/jwt';

interface FeedBody {
  version: string;
  title: string;
  description: string;
  items: Array<{
    id: string;
    title: string;
    content_text: string;
    tags: string[];
    _zooid: { data: unknown };
  }>;
}

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

describe('JSON Feed routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'feed-channel',
        name: 'Feed Channel',
        description: 'Test JSON feed',
        is_public: true,
      }),
    });
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'priv-feed',
        name: 'Private Feed',
        is_public: false,
      }),
    });
  });

  describe('GET /channels/:channelId/feed.json', () => {
    it('returns valid JSON Feed with correct content type', async () => {
      await publishRequest(
        '/api/v1/channels/feed-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'signal',
            data: { market: 'test', shift: 0.05 },
          }),
        },
        'feed-channel',
      );

      const res = await app.request(
        '/api/v1/channels/feed-channel/feed.json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/feed+json');

      const body = (await res.json()) as FeedBody;
      expect(body.version).toBe('https://jsonfeed.org/version/1.1');
      expect(body.title).toBe('Feed Channel');
      expect(body.description).toBe('Test JSON feed');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBeDefined();
      expect(body.items[0]._zooid).toBeDefined();
      expect(body.items[0]._zooid.data).toEqual({
        market: 'test',
        shift: 0.05,
      });
    });

    it('formats data as YAML by default', async () => {
      await publishRequest(
        '/api/v1/channels/feed-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'signal',
            data: { market: 'election', shift: 0.07 },
          }),
        },
        'feed-channel',
      );

      const res = await app.request(
        '/api/v1/channels/feed-channel/feed.json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const body = (await res.json()) as FeedBody;
      // YAML-style: key: value
      expect(body.items[0].content_text).toContain('market: election');
      expect(body.items[0].content_text).toContain('shift: 0.07');
    });

    it('formats data as JSON when format=json', async () => {
      await publishRequest(
        '/api/v1/channels/feed-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'signal',
            data: { market: 'election' },
          }),
        },
        'feed-channel',
      );

      const res = await app.request(
        '/api/v1/channels/feed-channel/feed.json?format=json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const body = (await res.json()) as FeedBody;
      expect(body.items[0].content_text).toContain('"market"');
    });

    it('includes event type and publisher in item title', async () => {
      await publishRequest(
        '/api/v1/channels/feed-channel/events',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'odds_shift',
            data: { v: 1 },
          }),
        },
        'feed-channel',
      );

      const res = await app.request(
        '/api/v1/channels/feed-channel/feed.json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const body = (await res.json()) as FeedBody;
      expect(body.items[0].title).toContain('[odds_shift]');
      expect(body.items[0].title).toContain('test-publisher');
      expect(body.items[0].tags).toEqual(['odds_shift']);
    });

    it('returns empty feed when no events', async () => {
      const res = await app.request(
        '/api/v1/channels/feed-channel/feed.json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as FeedBody;
      expect(body.version).toBe('https://jsonfeed.org/version/1.1');
      expect(body.items).toEqual([]);
    });

    it('allows public channel without auth', async () => {
      const res = await app.request(
        '/api/v1/channels/feed-channel/feed.json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
    });

    it('requires token query param for private channel', async () => {
      const res = await app.request(
        '/api/v1/channels/priv-feed/feed.json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(401);
    });

    it('accepts token via query param for private channel', async () => {
      const token = await createToken(
        { scope: 'subscribe', channel: 'priv-feed', sub: 'sub-1' },
        JWT_SECRET,
      );
      const res = await app.request(
        `/api/v1/channels/priv-feed/feed.json?token=${token}`,
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request(
        '/api/v1/channels/nonexistent/feed.json',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(404);
    });
  });
});
