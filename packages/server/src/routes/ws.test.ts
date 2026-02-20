import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
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

describe('WebSocket routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'ws-channel',
        name: 'WS Channel',
        is_public: true,
      }),
    });
    await adminRequest('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        id: 'priv-ws',
        name: 'Private WS',
        is_public: false,
      }),
    });
  });

  describe('GET /channels/:channelId/ws', () => {
    it('returns 426 without Upgrade header', async () => {
      const res = await app.request(
        '/api/v1/channels/ws-channel/ws',
        {},
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(426);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Expected WebSocket upgrade');
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request(
        '/api/v1/channels/nonexistent/ws',
        { headers: { Upgrade: 'websocket' } },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(404);
    });

    it('requires subscribe token for private channel', async () => {
      const res = await app.request(
        '/api/v1/channels/priv-ws/ws',
        { headers: { Upgrade: 'websocket' } },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(401);
    });

    it('allows subscribe token for private channel via Authorization header', async () => {
      // SELF.fetch() uses the real env from .dev.vars
      const realSecret = env.ZOOID_JWT_SECRET;
      const token = await createToken(
        { scope: 'subscribe', channel: 'priv-ws', sub: 'sub-1' },
        realSecret,
      );

      // Set up channel in the real env
      const adminToken = await createToken({ scope: 'admin' }, realSecret);
      await SELF.fetch('http://localhost/api/v1/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'priv-ws',
          name: 'Private WS',
          is_public: false,
        }),
      });

      const res = await SELF.fetch(
        'http://localhost/api/v1/channels/priv-ws/ws',
        {
          headers: {
            Upgrade: 'websocket',
            Authorization: `Bearer ${token}`,
          },
        },
      );
      expect(res.status).toBe(101);
      expect(res.webSocket).toBeDefined();
      res.webSocket!.accept();
      res.webSocket!.close();
    });

    it('allows subscribe token for private channel via ?token= query param', async () => {
      const realSecret = env.ZOOID_JWT_SECRET;
      const token = await createToken(
        { scope: 'subscribe', channel: 'priv-ws', sub: 'sub-1' },
        realSecret,
      );

      const adminToken = await createToken({ scope: 'admin' }, realSecret);
      await SELF.fetch('http://localhost/api/v1/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'priv-ws',
          name: 'Private WS',
          is_public: false,
        }),
      });

      const res = await SELF.fetch(
        `http://localhost/api/v1/channels/priv-ws/ws?token=${token}`,
        {
          headers: { Upgrade: 'websocket' },
        },
      );
      expect(res.status).toBe(101);
      expect(res.webSocket).toBeDefined();
      res.webSocket!.accept();
      res.webSocket!.close();
    });

    it('rejects invalid ?token= for private channel', async () => {
      const res = await app.request(
        '/api/v1/channels/priv-ws/ws?token=invalid-token',
        { headers: { Upgrade: 'websocket' } },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(401);
    });

    it('rejects wrong-channel ?token= for private channel', async () => {
      const token = await createToken(
        { scope: 'subscribe', channel: 'other-channel', sub: 'sub-1' },
        JWT_SECRET,
      );
      const res = await app.request(
        `/api/v1/channels/priv-ws/ws?token=${token}`,
        { headers: { Upgrade: 'websocket' } },
        { ...env, ZOOID_JWT_SECRET: JWT_SECRET },
      );
      expect(res.status).toBe(403);
    });

    it('upgrades to WebSocket for public channel', async () => {
      // SELF.fetch() uses the real env from .dev.vars
      const realSecret = env.ZOOID_JWT_SECRET;
      const adminToken = await createToken({ scope: 'admin' }, realSecret);
      await SELF.fetch('http://localhost/api/v1/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'ws-channel',
          name: 'WS Channel',
          is_public: true,
        }),
      });

      const res = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/ws',
        {
          headers: { Upgrade: 'websocket' },
        },
      );
      expect(res.status).toBe(101);
      expect(res.webSocket).toBeDefined();
      res.webSocket!.accept();
      res.webSocket!.close();
    });

    it('broadcasts to multiple connected clients', async () => {
      const realSecret = env.ZOOID_JWT_SECRET;
      const adminToken = await createToken({ scope: 'admin' }, realSecret);

      await SELF.fetch('http://localhost/api/v1/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'ws-channel',
          name: 'WS Channel',
          is_public: true,
        }),
      });

      // Connect two WebSocket clients
      const wsRes1 = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/ws',
        { headers: { Upgrade: 'websocket' } },
      );
      const wsRes2 = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/ws',
        { headers: { Upgrade: 'websocket' } },
      );
      expect(wsRes1.status).toBe(101);
      expect(wsRes2.status).toBe(101);

      const ws1 = wsRes1.webSocket!;
      const ws2 = wsRes2.webSocket!;
      ws1.accept();
      ws2.accept();

      const messages1: string[] = [];
      const messages2: string[] = [];
      ws1.addEventListener('message', (e: MessageEvent) =>
        messages1.push(e.data as string),
      );
      ws2.addEventListener('message', (e: MessageEvent) =>
        messages2.push(e.data as string),
      );

      // Publish an event
      const publishToken = await createToken(
        { scope: 'publish', channel: 'ws-channel', sub: 'test-pub' },
        realSecret,
      );
      const publishRes = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/events',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${publishToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ type: 'signal', data: { v: 1 } }),
        },
      );
      expect(publishRes.status).toBe(201);

      await new Promise((r) => setTimeout(r, 100));

      expect(messages1.length).toBeGreaterThanOrEqual(1);
      expect(messages2.length).toBeGreaterThanOrEqual(1);

      const received1 = JSON.parse(messages1[0]);
      const received2 = JSON.parse(messages2[0]);
      expect(received1.channel_id).toBe('ws-channel');
      expect(received2.channel_id).toBe('ws-channel');

      ws1.close();
      ws2.close();
    });

    it('filters events by type when ?types= is specified', async () => {
      const realSecret = env.ZOOID_JWT_SECRET;
      const adminToken = await createToken({ scope: 'admin' }, realSecret);

      await SELF.fetch('http://localhost/api/v1/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'ws-channel',
          name: 'WS Channel',
          is_public: true,
        }),
      });

      // Client 1: only wants "alert" events
      const wsRes1 = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/ws?types=alert',
        { headers: { Upgrade: 'websocket' } },
      );
      // Client 2: wants all events (no filter)
      const wsRes2 = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/ws',
        { headers: { Upgrade: 'websocket' } },
      );
      expect(wsRes1.status).toBe(101);
      expect(wsRes2.status).toBe(101);

      const ws1 = wsRes1.webSocket!;
      const ws2 = wsRes2.webSocket!;
      ws1.accept();
      ws2.accept();

      const messages1: string[] = [];
      const messages2: string[] = [];
      ws1.addEventListener('message', (e: MessageEvent) =>
        messages1.push(e.data as string),
      );
      ws2.addEventListener('message', (e: MessageEvent) =>
        messages2.push(e.data as string),
      );

      const publishToken = await createToken(
        { scope: 'publish', channel: 'ws-channel', sub: 'test-pub' },
        realSecret,
      );

      // Publish a "signal" event — should only reach client 2
      await SELF.fetch('http://localhost/api/v1/channels/ws-channel/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${publishToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'signal', data: { v: 1 } }),
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages1.length).toBe(0);
      expect(messages2.length).toBe(1);

      // Publish an "alert" event — should reach both clients
      await SELF.fetch('http://localhost/api/v1/channels/ws-channel/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${publishToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'alert', data: { v: 2 } }),
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(messages1.length).toBe(1);
      expect(messages2.length).toBe(2);

      const filtered = JSON.parse(messages1[0]);
      expect(filtered.type).toBe('alert');

      ws1.close();
      ws2.close();
    });

    it('supports multiple types in ?types= filter', async () => {
      const realSecret = env.ZOOID_JWT_SECRET;
      const adminToken = await createToken({ scope: 'admin' }, realSecret);

      await SELF.fetch('http://localhost/api/v1/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'ws-channel',
          name: 'WS Channel',
          is_public: true,
        }),
      });

      // Client subscribes to both "alert" and "signal" but not "info"
      const wsRes = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/ws?types=alert,signal',
        { headers: { Upgrade: 'websocket' } },
      );
      expect(wsRes.status).toBe(101);
      const ws = wsRes.webSocket!;
      ws.accept();

      const messages: string[] = [];
      ws.addEventListener('message', (e: MessageEvent) =>
        messages.push(e.data as string),
      );

      const publishToken = await createToken(
        { scope: 'publish', channel: 'ws-channel', sub: 'test-pub' },
        realSecret,
      );

      // Publish "info" — should not be received
      await SELF.fetch('http://localhost/api/v1/channels/ws-channel/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${publishToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'info', data: { v: 1 } }),
      });

      // Publish "alert" — should be received
      await SELF.fetch('http://localhost/api/v1/channels/ws-channel/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${publishToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'alert', data: { v: 2 } }),
      });

      // Publish "signal" — should be received
      await SELF.fetch('http://localhost/api/v1/channels/ws-channel/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${publishToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'signal', data: { v: 3 } }),
      });

      await new Promise((r) => setTimeout(r, 150));

      expect(messages.length).toBe(2);
      const types = messages.map((m) => JSON.parse(m).type);
      expect(types).toContain('alert');
      expect(types).toContain('signal');
      expect(types).not.toContain('info');

      ws.close();
    });

    it('receives broadcast after publish', async () => {
      // SELF.fetch() uses the real env from .dev.vars
      const realSecret = env.ZOOID_JWT_SECRET;
      const adminToken = await createToken({ scope: 'admin' }, realSecret);

      // Create channel via SELF
      await SELF.fetch('http://localhost/api/v1/channels', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'ws-channel',
          name: 'WS Channel',
          is_public: true,
        }),
      });

      // Connect WebSocket via SELF
      const wsRes = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/ws',
        {
          headers: { Upgrade: 'websocket' },
        },
      );
      expect(wsRes.status).toBe(101);
      const ws = wsRes.webSocket!;
      ws.accept();

      const messages: string[] = [];
      ws.addEventListener('message', (e: MessageEvent) =>
        messages.push(e.data as string),
      );

      // Publish an event via SELF
      const publishToken = await createToken(
        { scope: 'publish', channel: 'ws-channel', sub: 'test-pub' },
        realSecret,
      );
      const publishRes = await SELF.fetch(
        'http://localhost/api/v1/channels/ws-channel/events',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${publishToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ type: 'signal', data: { v: 42 } }),
        },
      );
      expect(publishRes.status).toBe(201);

      // Give waitUntil a moment to complete
      await new Promise((r) => setTimeout(r, 100));

      expect(messages.length).toBeGreaterThanOrEqual(1);
      const received = JSON.parse(messages[0]);
      expect(received.channel_id).toBe('ws-channel');
      expect(received.type).toBe('signal');

      ws.close();
    });
  });
});
