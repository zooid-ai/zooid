import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZooidClient } from './client';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ZooidClient', () => {
  describe('construction', () => {
    it('stores server URL with trailing slash stripped', () => {
      const client = new ZooidClient({ server: 'https://example.com/' });
      expect(client.server).toBe('https://example.com');
    });

    it('stores server URL as-is when no trailing slash', () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      expect(client.server).toBe('https://example.com');
    });

    it('accepts an optional token', () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'tok',
      });
      expect(client).toBeTruthy();
    });
  });

  describe('getMetadata()', () => {
    it('fetches GET /.well-known/zooid.json', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          version: '0.1',
          algorithm: 'Ed25519',
          public_key_format: 'spki',
          public_key: 'abc123',
          server_id: 'test',
          poll_interval: 30,
          delivery: ['poll', 'webhook', 'rss'],
        }),
      );

      const meta = await client.getMetadata();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/.well-known/zooid.json',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(meta.algorithm).toBe('Ed25519');
      expect(meta.poll_interval).toBe(30);
    });
  });

  describe('listChannels()', () => {
    it('fetches GET /api/v1/channels', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          channels: [
            { id: 'ch-1', name: 'Channel 1', is_public: true, event_count: 5 },
          ],
        }),
      );

      const channels = await client.listChannels();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/channels',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(channels).toHaveLength(1);
      expect(channels[0].id).toBe('ch-1');
    });
  });

  describe('createChannel()', () => {
    it('sends POST /api/v1/channels with auth header', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            id: 'new-ch',
            publish_token: 'pub-tok',
            subscribe_token: 'sub-tok',
          },
          201,
        ),
      );

      const result = await client.createChannel({
        id: 'new-ch',
        name: 'New Channel',
        is_public: true,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/channels',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
      expect(result.id).toBe('new-ch');
      expect(result.publish_token).toBe('pub-tok');
      expect(result.subscribe_token).toBe('sub-tok');
    });

    it('throws on non-2xx response', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Channel already exists' }, 409),
      );

      await expect(
        client.createChannel({ id: 'dup', name: 'Dup' }),
      ).rejects.toThrow();
    });
  });

  describe('getClaim()', () => {
    it('sends POST /api/v1/directory/claim with channels', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ claim: 'Y2xhaW0', signature: 'c2ln' }),
      );

      const result = await client.getClaim(['channel-a', 'channel-b']);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://example.com/api/v1/directory/claim');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer admin-token');
      const body = JSON.parse(opts.body);
      expect(body.channels).toEqual(['channel-a', 'channel-b']);
      expect(body.action).toBeUndefined();
      expect(result.claim).toBe('Y2xhaW0');
      expect(result.signature).toBe('c2ln');
    });

    it('sends action when provided', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ claim: 'Y2xhaW0', signature: 'c2ln' }),
      );

      await client.getClaim(['channel-a'], 'delete');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channels).toEqual(['channel-a']);
      expect(body.action).toBe('delete');
    });

    it('throws on non-2xx response', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Channels not found: bad-ch' }, 400),
      );

      await expect(client.getClaim(['bad-ch'])).rejects.toThrow();
    });
  });

  describe('addPublisher()', () => {
    it('sends POST /api/v1/channels/:id/publishers', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { id: 'pub-1', name: 'whale-bot', publish_token: 'pt' },
          201,
        ),
      );

      const result = await client.addPublisher('signals', 'whale-bot');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/channels/signals/publishers',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result.name).toBe('whale-bot');
      expect(result.publish_token).toBe('pt');
    });
  });

  describe('publish()', () => {
    it('sends POST /api/v1/channels/:id/events with event data', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'publish-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            id: 'evt-1',
            channel_id: 'signals',
            type: 'alert',
            data: '{"v":1}',
          },
          201,
        ),
      );

      const event = await client.publish('signals', {
        type: 'alert',
        data: { v: 1 },
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://example.com/api/v1/channels/signals/events');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.type).toBe('alert');
      expect(body.data).toEqual({ v: 1 });
      expect(event.id).toBe('evt-1');
    });

    it('sends event without type when not provided', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'publish-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { id: 'evt-2', channel_id: 'ch', type: null, data: '{}' },
          201,
        ),
      );

      await client.publish('ch', { data: { hello: 'world' } });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBeUndefined();
      expect(body.data).toEqual({ hello: 'world' });
    });
  });

  describe('publishBatch()', () => {
    it('sends POST /api/v1/channels/:id/events with events array', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'publish-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            events: [
              { id: 'e1', type: 'a', data: '{}' },
              { id: 'e2', type: 'b', data: '{}' },
            ],
          },
          201,
        ),
      );

      const result = await client.publishBatch('signals', [
        { type: 'a', data: {} },
        { type: 'b', data: {} },
      ]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.events).toHaveLength(2);
      expect(result).toHaveLength(2);
    });
  });

  describe('tail()', () => {
    it('fetches GET /api/v1/channels/:id/events (alias for poll)', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          events: [{ id: 'e1', type: 'signal', data: '{}' }],
          cursor: 'e1',
          has_more: false,
        }),
      );

      const result = await client.tail('signals');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/channels/signals/events',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.events).toHaveLength(1);
      expect(result.has_more).toBe(false);
    });

    it('passes query params for limit, type, since', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ events: [], cursor: null, has_more: false }),
      );

      await client.tail('signals', {
        limit: 5,
        type: 'alert',
        since: '2026-01-01T00:00:00Z',
      });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=5');
      expect(url).toContain('type=alert');
      expect(url).toContain('since=2026-01-01T00%3A00%3A00Z');
    });
  });

  describe('tail({ follow: true })', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns an async iterable that yields events from subscribe', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });

      // subscribe will be called internally — mock poll mode
      mockFetch.mockResolvedValue(
        jsonResponse({ events: [], cursor: null, has_more: false }),
      );

      const stream = client.tail('signals', {
        follow: true,
        mode: 'poll',
        interval: 1000,
      });

      // Manually push events via the subscribe callback
      // We need to access the internal subscribe — let's spy on it
      // Instead, we test the integration: publish events via poll responses

      // First poll — empty (subscribe starts immediately)
      await vi.advanceTimersByTimeAsync(0);

      // Second poll returns an event
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          events: [
            {
              id: 'e1',
              type: 'signal',
              data: '{"v":1}',
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          cursor: 'e1',
          has_more: false,
        }),
      );
      await vi.advanceTimersByTimeAsync(1000);

      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual(expect.objectContaining({ id: 'e1' }));

      stream.close();
    });

    it('close() ends the async iteration', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });

      mockFetch.mockResolvedValue(
        jsonResponse({ events: [], cursor: null, has_more: false }),
      );

      const stream = client.tail('signals', {
        follow: true,
        mode: 'poll',
        interval: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);

      // Close the stream
      stream.close();

      const iterator = stream[Symbol.asyncIterator]();
      const result = await iterator.next();
      expect(result.done).toBe(true);
    });

    it('buffers events that arrive before iteration starts', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });

      // First poll immediately returns events
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          events: [
            {
              id: 'e1',
              type: 'a',
              data: '{}',
              created_at: '2026-01-01T00:00:00Z',
            },
            {
              id: 'e2',
              type: 'b',
              data: '{}',
              created_at: '2026-01-01T00:00:01Z',
            },
          ],
          cursor: 'e2',
          has_more: false,
        }),
      );
      // Subsequent polls empty
      mockFetch.mockResolvedValue(
        jsonResponse({ events: [], cursor: null, has_more: false }),
      );

      const stream = client.tail('signals', {
        follow: true,
        mode: 'poll',
        interval: 5000,
      });

      // Let the initial poll resolve
      await vi.advanceTimersByTimeAsync(0);

      // Now start iterating — events should be buffered
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      const second = await iterator.next();

      expect(first.value).toEqual(expect.objectContaining({ id: 'e1' }));
      expect(second.value).toEqual(expect.objectContaining({ id: 'e2' }));

      stream.close();
    });

    it('passes type filter to subscribe', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });

      mockFetch.mockResolvedValue(
        jsonResponse({ events: [], cursor: null, has_more: false }),
      );

      const stream = client.tail('signals', {
        follow: true,
        mode: 'poll',
        type: 'alert',
      });
      await vi.advanceTimersByTimeAsync(0);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('type=alert');

      stream.close();
    });
  });

  describe('poll()', () => {
    it('fetches GET /api/v1/channels/:id/events', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          events: [{ id: 'e1', type: 'signal', data: '{}' }],
          cursor: 'e1',
          has_more: false,
        }),
      );

      const result = await client.poll('signals');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/channels/signals/events',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.events).toHaveLength(1);
      expect(result.has_more).toBe(false);
    });

    it('passes query params for cursor, limit, type, since', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ events: [], cursor: null, has_more: false }),
      );

      await client.poll('signals', {
        cursor: 'abc',
        limit: 10,
        type: 'alert',
        since: '2026-01-01T00:00:00Z',
      });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('cursor=abc');
      expect(url).toContain('limit=10');
      expect(url).toContain('type=alert');
      expect(url).toContain('since=2026-01-01T00%3A00%3A00Z');
    });

    it('sends auth header when token is set', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'sub-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ events: [], cursor: null, has_more: false }),
      );

      await client.poll('private-ch');

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer sub-token');
    });
  });

  describe('registerWebhook()', () => {
    it('sends POST /api/v1/channels/:id/webhooks', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'sub-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            id: 'wh-1',
            channel_id: 'signals',
            url: 'https://hook.example.com',
          },
          201,
        ),
      );

      const wh = await client.registerWebhook(
        'signals',
        'https://hook.example.com',
        {
          event_types: ['alert'],
          ttl_seconds: 3600,
        },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.url).toBe('https://hook.example.com');
      expect(body.event_types).toEqual(['alert']);
      expect(body.ttl_seconds).toBe(3600);
      expect(wh.id).toBe('wh-1');
    });
  });

  describe('removeWebhook()', () => {
    it('sends DELETE /api/v1/channels/:id/webhooks/:whId', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.removeWebhook('signals', 'wh-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/channels/signals/webhooks/wh-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('getServerMeta()', () => {
    it('fetches GET /api/v1/server', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          name: 'My Zooid',
          description: 'A server',
          tags: ['ai'],
          owner: 'alice',
          company: null,
          email: null,
          updated_at: '2026-02-18T00:00:00Z',
        }),
      );

      const meta = await client.getServerMeta();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/server',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(meta.name).toBe('My Zooid');
      expect(meta.tags).toEqual(['ai']);
      expect(meta.owner).toBe('alice');
    });
  });

  describe('updateServerMeta()', () => {
    it('sends PUT /api/v1/server with auth header', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'admin-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          name: 'Updated',
          description: null,
          tags: ['new'],
          owner: null,
          company: null,
          email: null,
          updated_at: '2026-02-18T00:00:00Z',
        }),
      );

      const meta = await client.updateServerMeta({
        name: 'Updated',
        tags: ['new'],
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://example.com/api/v1/server');
      expect(opts.method).toBe('PUT');
      expect(opts.headers.Authorization).toBe('Bearer admin-token');
      const body = JSON.parse(opts.body);
      expect(body.name).toBe('Updated');
      expect(body.tags).toEqual(['new']);
      expect(meta.name).toBe('Updated');
    });
  });

  describe('error handling', () => {
    it('throws ZooidError with status and message on API error', async () => {
      const client = new ZooidClient({
        server: 'https://example.com',
        token: 'bad-token',
      });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Invalid or expired token' }, 401),
      );

      try {
        await client.listChannels();
        expect.unreachable('should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as { status: number }).status).toBe(401);
        expect((err as Error).message).toContain('Invalid or expired token');
      }
    });

    it('throws on network failure', async () => {
      const client = new ZooidClient({ server: 'https://example.com' });
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(client.getMetadata()).rejects.toThrow('Failed to fetch');
    });
  });
});
