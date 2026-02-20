import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireAuth, requireScope } from './auth';
import { createToken } from '../lib/jwt';

const JWT_SECRET = 'test-jwt-secret';

function createTestApp() {
  const app = new Hono<{
    Bindings: { ZOOID_JWT_SECRET: string };
    Variables: { jwtPayload: { scope: string; channel?: string } };
  }>();

  app.get('/public', (c) => c.json({ ok: true }));

  app.get('/protected', requireAuth(), (c) => {
    return c.json({ scope: c.get('jwtPayload').scope });
  });

  app.get('/admin', requireAuth(), requireScope('admin'), (c) => {
    return c.json({ admin: true });
  });

  app.post(
    '/publish/:channelId',
    requireAuth(),
    requireScope('publish', { channelParam: 'channelId' }),
    (c) => {
      return c.json({ published: true });
    },
  );

  return app;
}

describe('Auth middleware', () => {
  const app = createTestApp();

  it('allows unauthenticated access to public routes', async () => {
    const res = await app.request(
      '/public',
      {},
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(200);
  });

  it('rejects requests without Authorization header', async () => {
    const res = await app.request(
      '/protected',
      {},
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(401);
  });

  it('rejects requests with invalid token', async () => {
    const res = await app.request(
      '/protected',
      { headers: { Authorization: 'Bearer invalid-token' } },
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(401);
  });

  it('allows requests with valid token', async () => {
    const token = await createToken({ scope: 'admin' }, JWT_SECRET);
    const res = await app.request(
      '/protected',
      { headers: { Authorization: `Bearer ${token}` } },
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe('admin');
  });

  it('enforces admin scope', async () => {
    const token = await createToken(
      { scope: 'publish', channel: 'test' },
      JWT_SECRET,
    );
    const res = await app.request(
      '/admin',
      { headers: { Authorization: `Bearer ${token}` } },
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(403);
  });

  it('allows admin scope on admin route', async () => {
    const token = await createToken({ scope: 'admin' }, JWT_SECRET);
    const res = await app.request(
      '/admin',
      { headers: { Authorization: `Bearer ${token}` } },
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(200);
  });

  it('rejects publish token for wrong channel', async () => {
    const token = await createToken(
      { scope: 'publish', channel: 'channel-a' },
      JWT_SECRET,
    );
    const res = await app.request(
      '/publish/channel-b',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(403);
  });

  it('allows admin token on any channel-scoped route', async () => {
    const token = await createToken({ scope: 'admin' }, JWT_SECRET);
    const res = await app.request(
      '/publish/any-channel',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      { ZOOID_JWT_SECRET: JWT_SECRET },
    );
    expect(res.status).toBe(200);
  });
});
