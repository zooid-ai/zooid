import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZooidClient } from './client';

const mockFetch = vi.fn();

// --- MockWebSocket ---
type WsHandler = (e: { data: string }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: WsHandler | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  // Test helpers
  simulateOpen() {
    this.onopen?.();
  }
  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
  simulateError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', mockFetch);
  MockWebSocket.instances = [];
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ZooidClient.subscribe() — poll mode', () => {
  it('calls callback with events from initial poll', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

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

    const unsub = await client.subscribe('signals', callback, {
      mode: 'poll',
      interval: 5000,
    });

    // Wait for initial poll to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', type: 'signal' }),
    );

    unsub();
  });

  it('polls periodically at the given interval', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    // Initial poll — empty
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ events: [], cursor: null, has_more: false }),
    );

    const unsub = await client.subscribe('signals', callback, {
      mode: 'poll',
      interval: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second poll after 5s — one event
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        events: [
          {
            id: 'e2',
            type: 'x',
            data: '{}',
            created_at: '2026-01-01T00:00:05Z',
          },
        ],
        cursor: 'e2',
        has_more: false,
      }),
    );

    await vi.advanceTimersByTimeAsync(5000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);

    unsub();
  });

  it('uses cursor from previous poll for subsequent requests', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    // Initial poll returns event with cursor
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        events: [
          {
            id: 'e1',
            type: 'x',
            data: '{}',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        cursor: 'e1',
        has_more: false,
      }),
    );

    const unsub = await client.subscribe('signals', callback, {
      mode: 'poll',
      interval: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Second poll should include cursor=e1
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ events: [], cursor: null, has_more: false }),
    );

    await vi.advanceTimersByTimeAsync(5000);

    const secondUrl = mockFetch.mock.calls[1][0];
    expect(secondUrl).toContain('cursor=e1');

    unsub();
  });

  it('stops polling after unsubscribe is called', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    mockFetch.mockResolvedValue(
      jsonResponse({ events: [], cursor: null, has_more: false }),
    );

    const unsub = await client.subscribe('signals', callback, {
      mode: 'poll',
      interval: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unsub();

    await vi.advanceTimersByTimeAsync(10000);
    // Should not have polled again
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('defaults to 5000ms interval', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    mockFetch.mockResolvedValue(
      jsonResponse({ events: [], cursor: null, has_more: false }),
    );

    const unsub = await client.subscribe('signals', callback, { mode: 'poll' });
    await vi.advanceTimersByTimeAsync(0);

    // Should not poll at 4999ms
    await vi.advanceTimersByTimeAsync(4999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Should poll at 5000ms
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('continues polling even if a poll errors', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    // First poll succeeds
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ events: [], cursor: null, has_more: false }),
    );

    const unsub = await client.subscribe('signals', callback, {
      mode: 'poll',
      interval: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Second poll fails
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    await vi.advanceTimersByTimeAsync(5000);

    // Third poll succeeds
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        events: [
          {
            id: 'e1',
            type: 'x',
            data: '{}',
            created_at: '2026-01-01T00:00:10Z',
          },
        ],
        cursor: 'e1',
        has_more: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    unsub();
  });

  it('passes type filter as ?type= query param on poll', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ events: [], cursor: null, has_more: false }),
    );

    const unsub = await client.subscribe('signals', callback, {
      mode: 'poll',
      type: 'alert',
      interval: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('type=alert');

    unsub();
  });
});

describe('ZooidClient.subscribe() — ws mode', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('builds correct WS URL from https server', async () => {
    const client = new ZooidClient({
      server: 'https://example.com',
      token: 'tok123',
    });
    const callback = vi.fn();

    const promise = client.subscribe('signals', callback, {
      mode: 'ws',
      type: 'alert',
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe(
      'wss://example.com/api/v1/channels/signals/ws?token=tok123&types=alert',
    );

    ws.simulateOpen();
    const unsub = await promise;
    unsub();
  });

  it('builds correct WS URL from http server', async () => {
    const client = new ZooidClient({ server: 'http://localhost:8787' });
    const callback = vi.fn();

    const promise = client.subscribe('ch', callback, { mode: 'ws' });

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('ws://localhost:8787/api/v1/channels/ch/ws');

    ws.simulateOpen();
    const unsub = await promise;
    unsub();
  });

  it('resolves with unsubscribe fn on successful connection', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    const promise = client.subscribe('ch', callback, { mode: 'ws' });

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const unsub = await promise;
    expect(typeof unsub).toBe('function');

    unsub();
    expect(ws.closed).toBe(true);
  });

  it('delivers WS messages to callback', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    const promise = client.subscribe('ch', callback, { mode: 'ws' });

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    await promise;

    const event = {
      id: 'e1',
      type: 'signal',
      data: '{"v":1}',
      created_at: '2026-01-01T00:00:00Z',
    };
    ws.simulateMessage(JSON.stringify(event));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', type: 'signal' }),
    );
  });

  it('rejects on failure in ws mode (no fallback)', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    const promise = client.subscribe('ch', callback, { mode: 'ws' });

    // First attempt fails
    MockWebSocket.instances[0].simulateError();

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);

    // Second attempt also fails
    MockWebSocket.instances[1].simulateError();

    await expect(promise).rejects.toThrow('WebSocket connection failed');
  });

  it('retries once then rejects in ws mode', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    const promise = client.subscribe('ch', callback, { mode: 'ws' });

    // First WS attempt fails
    MockWebSocket.instances[0].simulateError();
    expect(MockWebSocket.instances).toHaveLength(1);

    // Advance past retry delay — creates second WS
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second attempt succeeds
    MockWebSocket.instances[1].simulateOpen();

    const unsub = await promise;
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

describe('ZooidClient.subscribe() — auto mode', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('uses WS when connection succeeds', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    const promise = client.subscribe('ch', callback); // auto by default

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const unsub = await promise;
    // Should not have polled
    expect(mockFetch).not.toHaveBeenCalled();

    unsub();
  });

  it('falls back to polling when WS fails twice', async () => {
    const client = new ZooidClient({ server: 'https://example.com' });
    const callback = vi.fn();

    mockFetch.mockResolvedValue(
      jsonResponse({ events: [], cursor: null, has_more: false }),
    );

    const promise = client.subscribe('ch', callback);

    // First attempt fails
    MockWebSocket.instances[0].simulateError();

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);

    // Second attempt also fails — should fall back to polling
    MockWebSocket.instances[1].simulateError();

    const unsub = await promise;

    // Should have started polling
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalled();

    unsub();
  });
});
