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

describe('OPML routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('GET /api/v1/opml', () => {
    it('returns valid OPML with correct content type', async () => {
      await adminRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'signals',
          name: 'Signals',
          description: 'Market signals',
          is_public: true,
        }),
      });

      const res = await app.request(
        '/api/v1/opml',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/x-opml');

      const xml = await res.text();
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<opml');
      expect(xml).toContain('version="2.0"');
      expect(xml).toContain('Signals');
      expect(xml).toContain('/api/v1/channels/signals/rss');
      expect(xml).toContain('/signals');
    });

    it('only includes public channels', async () => {
      await adminRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'public-ch',
          name: 'Public',
          is_public: true,
        }),
      });
      await adminRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'private-ch',
          name: 'Private',
          is_public: false,
        }),
      });

      const res = await app.request(
        '/api/v1/opml',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const xml = await res.text();
      expect(xml).toContain('Public');
      expect(xml).not.toContain('Private');
    });

    it('returns empty body when no channels', async () => {
      const res = await app.request(
        '/api/v1/opml',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain('<opml');
      expect(xml).not.toContain('xmlUrl');
    });

    it('includes multiple channels as outlines', async () => {
      await adminRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'alpha',
          name: 'Alpha',
          is_public: true,
        }),
      });
      await adminRequest('/api/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          id: 'beta',
          name: 'Beta',
          is_public: true,
        }),
      });

      const res = await app.request(
        '/api/v1/opml',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      const xml = await res.text();
      expect(xml).toContain('alpha/rss');
      expect(xml).toContain('beta/rss');
    });
  });
});
