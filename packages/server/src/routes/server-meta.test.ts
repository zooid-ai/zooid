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

describe('Server meta routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('GET /api/v1/server', () => {
    it('returns defaults when no row exists', async () => {
      const res = await app.request(
        '/api/v1/server',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe('Zooid');
      expect(body.description).toBeNull();
      expect(body.tags).toEqual([]);
      expect(body.owner).toBeNull();
      expect(body.company).toBeNull();
      expect(body.email).toBeNull();
      expect(body.updated_at).toBeTruthy();
    });

    it('returns stored metadata after update', async () => {
      await authRequest('/api/v1/server', {
        method: 'PUT',
        body: JSON.stringify({
          name: 'My Server',
          description: 'Test server',
          tags: ['ai', 'agents'],
          owner: 'tester',
        }),
      });

      const res = await app.request(
        '/api/v1/server',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe('My Server');
      expect(body.description).toBe('Test server');
      expect(body.tags).toEqual(['ai', 'agents']);
      expect(body.owner).toBe('tester');
    });

    it('does not require authentication', async () => {
      const res = await app.request(
        '/api/v1/server',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/v1/server', () => {
    it('creates server metadata with admin token', async () => {
      const res = await authRequest('/api/v1/server', {
        method: 'PUT',
        body: JSON.stringify({
          name: 'My Zooid',
          description: 'A cool server',
          tags: ['crypto', 'trading'],
          owner: 'alice',
          company: 'Acme',
          email: 'alice@acme.com',
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe('My Zooid');
      expect(body.description).toBe('A cool server');
      expect(body.tags).toEqual(['crypto', 'trading']);
      expect(body.owner).toBe('alice');
      expect(body.company).toBe('Acme');
      expect(body.email).toBe('alice@acme.com');
      expect(body.updated_at).toBeTruthy();
    });

    it('updates existing metadata (upsert)', async () => {
      await authRequest('/api/v1/server', {
        method: 'PUT',
        body: JSON.stringify({ name: 'First Name', owner: 'alice' }),
      });

      const res = await authRequest('/api/v1/server', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Updated Name', owner: 'bob' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe('Updated Name');
      expect(body.owner).toBe('bob');
    });

    it('rejects without auth', async () => {
      const res = await app.request(
        '/api/v1/server',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'No Auth' }),
        },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );

      expect(res.status).toBe(401);
    });

    it('rejects with non-admin token', async () => {
      const res = await authRequest(
        '/api/v1/server',
        {
          method: 'PUT',
          body: JSON.stringify({ name: 'No Auth' }),
        },
        'publish',
        'some-channel',
      );

      expect(res.status).toBe(403);
    });
  });
});
