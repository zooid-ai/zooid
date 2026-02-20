import { ZooidError } from './error';
import type {
  ZooidClientOptions,
  ServerDiscovery,
  ServerIdentity,
  ChannelInfo,
  CreateChannelOptions,
  CreateChannelResult,
  PublisherResult,
  ZooidEvent,
  PublishOptions,
  PollOptions,
  PollResult,
  WebhookOptions,
  WebhookResult,
  SubscribeOptions,
  TailOptions,
  TailStream,
  UpdateServerMetaOptions,
  ClaimResult,
} from './types';

/**
 * Client for the Zooid pub/sub API.
 *
 * Provides methods for channel management, event publishing/polling,
 * webhook registration, and server metadata access.
 *
 * @example
 * ```ts
 * const client = new ZooidClient({
 *   server: 'https://zooid.example.workers.dev',
 *   token: 'eyJ...',
 * });
 *
 * const channels = await client.listChannels();
 * ```
 */
export class ZooidClient {
  /** Base URL of the Zooid server (trailing slashes stripped). */
  readonly server: string;
  private token?: string;
  private _fetch: typeof globalThis.fetch;

  constructor(options: ZooidClientOptions) {
    this.server = options.server.replace(/\/+$/, '');
    this.token = options.token;
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await this._fetch(this.server + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ZooidError(
        0,
        `Cannot connect to ${this.server} — ${err instanceof Error ? err.message : 'network error'}`,
      );
    }

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as Record<string, unknown>;
        if (json.error) message = String(json.error);
      } catch {
        // use default message
      }
      throw new ZooidError(res.status, message);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  /** Fetch server discovery metadata from `GET /.well-known/zooid.json`. */
  async getMetadata(): Promise<ServerDiscovery> {
    return this.request<ServerDiscovery>('GET', '/.well-known/zooid.json');
  }

  /** Fetch editable server identity from `GET /api/v1/server`. */
  async getServerMeta(): Promise<ServerIdentity> {
    return this.request<ServerIdentity>('GET', '/api/v1/server');
  }

  /** Update server identity metadata via `PUT /api/v1/server`. Requires admin token. */
  async updateServerMeta(
    options: UpdateServerMetaOptions,
  ): Promise<ServerIdentity> {
    return this.request<ServerIdentity>('PUT', '/api/v1/server', options);
  }

  /** List all channels via `GET /api/v1/channels`. */
  async listChannels(): Promise<ChannelInfo[]> {
    const res = await this.request<{ channels: ChannelInfo[] }>(
      'GET',
      '/api/v1/channels',
    );
    return res.channels;
  }

  /** Create a new channel via `POST /api/v1/channels`. Requires admin token. */
  async createChannel(
    options: CreateChannelOptions,
  ): Promise<CreateChannelResult> {
    return this.request<CreateChannelResult>(
      'POST',
      '/api/v1/channels',
      options,
    );
  }

  /** Generate a signed claim for the Zooid Directory. Requires admin token. */
  async getClaim(channels: string[], action?: 'delete'): Promise<ClaimResult> {
    const body: Record<string, unknown> = { channels };
    if (action) body.action = action;
    return this.request<ClaimResult>('POST', '/api/v1/directory/claim', body);
  }

  /** Add a named publisher to a channel. Requires admin token. */
  async addPublisher(
    channelId: string,
    name: string,
  ): Promise<PublisherResult> {
    return this.request<PublisherResult>(
      'POST',
      `/api/v1/channels/${channelId}/publishers`,
      { name },
    );
  }

  /** Publish a single event to a channel. Requires a publish-scoped token. */
  async publish(
    channelId: string,
    options: PublishOptions,
  ): Promise<ZooidEvent> {
    const body: Record<string, unknown> = { data: options.data };
    if (options.type !== undefined) {
      body.type = options.type;
    }
    return this.request<ZooidEvent>(
      'POST',
      `/api/v1/channels/${channelId}/events`,
      body,
    );
  }

  /** Publish multiple events in a single request. Requires a publish-scoped token. */
  async publishBatch(
    channelId: string,
    events: PublishOptions[],
  ): Promise<ZooidEvent[]> {
    const body = {
      events: events.map((e) => {
        const item: Record<string, unknown> = { data: e.data };
        if (e.type !== undefined) item.type = e.type;
        return item;
      }),
    };
    const res = await this.request<{ events: ZooidEvent[] }>(
      'POST',
      `/api/v1/channels/${channelId}/events`,
      body,
    );
    return res.events;
  }

  /**
   * Fetch events from a channel.
   *
   * Without `follow`, performs a one-shot poll (alias for {@link poll}).
   * With `follow: true`, returns an async iterable stream that wraps {@link subscribe}.
   *
   * @example
   * ```ts
   * // One-shot
   * const result = await client.tail('my-channel', { limit: 10 });
   *
   * // Follow mode
   * const stream = client.tail('my-channel', { follow: true });
   * for await (const event of stream) {
   *   console.log(event);
   * }
   * ```
   */
  tail(channelId: string, options: TailOptions & { follow: true }): TailStream;
  tail(channelId: string, options?: TailOptions): Promise<PollResult>;
  tail(
    channelId: string,
    options?: TailOptions,
  ): Promise<PollResult> | TailStream {
    if (options?.follow) {
      return this.createTailStream(channelId, options);
    }
    return this.poll(channelId, options);
  }

  private createTailStream(
    channelId: string,
    options: TailOptions,
  ): TailStream {
    const buffer: ZooidEvent[] = [];
    let waiting: ((result: IteratorResult<ZooidEvent>) => void) | null = null;
    let done = false;
    let unsub: (() => void) | null = null;

    this.subscribe(
      channelId,
      (event) => {
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve({ value: event, done: false });
        } else {
          buffer.push(event);
        }
      },
      {
        mode: options.mode,
        interval: options.interval,
        type: options.type,
      },
    ).then((fn) => {
      unsub = fn;
      if (done) fn();
    });

    const stream: TailStream = {
      close() {
        done = true;
        unsub?.();
        if (waiting) {
          waiting({ value: undefined as unknown as ZooidEvent, done: true });
          waiting = null;
        }
      },
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ZooidEvent>> {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({
                value: undefined as unknown as ZooidEvent,
                done: true,
              });
            }
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
          return(): Promise<IteratorResult<ZooidEvent>> {
            stream.close();
            return Promise.resolve({
              value: undefined as unknown as ZooidEvent,
              done: true,
            });
          },
        };
      },
    };

    return stream;
  }

  /** Poll events from a channel with cursor-based pagination. */
  async poll(channelId: string, options?: PollOptions): Promise<PollResult> {
    const params = new URLSearchParams();
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.limit !== undefined)
      params.set('limit', String(options.limit));
    if (options?.type) params.set('type', options.type);
    if (options?.since) params.set('since', options.since);

    const qs = params.toString();
    const path = `/api/v1/channels/${channelId}/events${qs ? `?${qs}` : ''}`;
    return this.request<PollResult>('GET', path);
  }

  /** Register a webhook to receive events via POST. */
  async registerWebhook(
    channelId: string,
    url: string,
    options?: WebhookOptions,
  ): Promise<WebhookResult> {
    return this.request<WebhookResult>(
      'POST',
      `/api/v1/channels/${channelId}/webhooks`,
      {
        url,
        ...options,
      },
    );
  }

  /** Remove a webhook registration. Requires admin token. */
  async removeWebhook(channelId: string, webhookId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/api/v1/channels/${channelId}/webhooks/${webhookId}`,
    );
  }

  /**
   * Subscribe to a channel. Tries WebSocket first (mode `'auto'`), falls back to polling.
   *
   * Returns a promise that resolves with an unsubscribe function.
   *
   * @example
   * ```ts
   * const unsub = await client.subscribe('my-channel', (event) => {
   *   console.log('New event:', event.id);
   * });
   *
   * // Later: stop
   * unsub();
   * ```
   */
  async subscribe(
    channelId: string,
    callback: (event: ZooidEvent) => void,
    options?: SubscribeOptions,
  ): Promise<() => void> {
    const mode = options?.mode ?? 'auto';

    if (mode === 'poll') {
      return this.startPolling(channelId, callback, options);
    }

    // mode: 'auto' or 'ws' — try WebSocket
    const tryWs = (retryOnFail: boolean): Promise<() => void> => {
      return new Promise<() => void>((resolve, reject) => {
        const url = this.buildWsUrl(channelId, options);
        const ws = new globalThis.WebSocket(url);

        ws.onopen = () => {
          resolve(() => {
            ws.close();
          });
        };

        ws.onmessage = (e: MessageEvent) => {
          try {
            const event = JSON.parse(String(e.data)) as ZooidEvent;
            callback(event);
          } catch {
            // ignore non-JSON messages
          }
        };

        ws.onclose = () => {
          // If WS closes before opening, this is handled by onerror.
          // If WS was open and then closed, attempt reconnect.
        };

        ws.onerror = () => {
          ws.close();
          if (retryOnFail) {
            // Retry once after 1s
            setTimeout(() => {
              tryWs(false).then(resolve, reject);
            }, 1000);
          } else if (mode === 'auto') {
            // Fall back to polling
            this.startPolling(channelId, callback, options).then(
              resolve,
              reject,
            );
          } else {
            // mode: 'ws' — reject
            reject(new Error('WebSocket connection failed'));
          }
        };
      });
    };

    return tryWs(true);
  }

  private buildWsUrl(channelId: string, options?: SubscribeOptions): string {
    const base = this.server
      .replace(/^http:\/\//, 'ws://')
      .replace(/^https:\/\//, 'wss://');
    const params = new URLSearchParams();
    if (this.token) params.set('token', this.token);
    if (options?.type) params.set('types', options.type);
    const qs = params.toString();
    return `${base}/api/v1/channels/${channelId}/ws${qs ? `?${qs}` : ''}`;
  }

  private startPolling(
    channelId: string,
    callback: (event: ZooidEvent) => void,
    options?: SubscribeOptions,
  ): Promise<() => void> {
    const interval = options?.interval ?? 5000;
    const type = options?.type;
    let cursor: string | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const doPoll = async () => {
      try {
        const pollOpts: PollOptions = {};
        if (cursor) pollOpts.cursor = cursor;
        if (type) pollOpts.type = type;
        const result = await this.poll(channelId, pollOpts);
        if (stopped) return;
        for (const event of result.events) {
          callback(event);
        }
        if (result.cursor) {
          cursor = result.cursor;
        }
      } catch {
        // silently swallow errors, keep polling
      }
    };

    // Immediate first poll
    doPoll();

    // Set up interval for subsequent polls
    timer = setInterval(doPoll, interval);

    // Return unsubscribe function
    return Promise.resolve(() => {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    });
  }
}
