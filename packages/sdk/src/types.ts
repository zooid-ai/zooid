// Re-export shared API types (canonical names)
export type {
  ZooidEvent,
  PollResult,
  ServerDiscovery,
  ServerIdentity,
} from '@zooid/types';

// Deprecated aliases re-exported for backward compatibility
export type { ServerMetadata, ServerMeta } from '@zooid/types';

import type {
  ZooidEvent as ZooidEventType,
  ChannelListItem,
  Webhook,
} from '@zooid/types';

// Local alias so we can reference ZooidEvent in interface definitions
// while still re-exporting it above.
type ZooidEvent = ZooidEventType;

/** Channel info as returned by `GET /api/v1/channels`. Alias for {@link ChannelListItem}. */
export type ChannelInfo = ChannelListItem;

/** Webhook registration result. Alias for {@link Webhook}. */
export type WebhookResult = Webhook;

// SDK-specific types

/** Options for constructing a {@link ZooidClient}. */
export interface ZooidClientOptions {
  /** Base URL of the Zooid server (e.g. `"https://zooid.example.workers.dev"`). */
  server: string;
  /** JWT token (admin, publish, or subscribe scoped). */
  token?: string;
  /** Custom fetch implementation (for testing or custom environments). */
  fetch?: typeof globalThis.fetch;
}

/** Options for creating a new channel via `POST /api/v1/channels`. */
export interface CreateChannelOptions {
  /** URL-safe slug identifier (lowercase + hyphens, 3-64 chars). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Optional channel description. */
  description?: string;
  /** Whether the channel is publicly accessible. Defaults to `true`. */
  is_public?: boolean;
  /** Optional JSON Schema for event payload validation. */
  schema?: Record<string, unknown>;
  /** When `true`, events are rejected if they don't match `schema`. */
  strict?: boolean;
}

/** Result of creating a new channel. */
export interface CreateChannelResult {
  /** The channel's slug identifier. */
  id: string;
  /** JWT token scoped for publishing to this channel. */
  publish_token: string;
  /** JWT token scoped for subscribing to this channel. */
  subscribe_token: string;
}

/** Result of adding a publisher to a channel. */
export interface PublisherResult {
  /** ULID identifier for the new publisher. */
  id: string;
  /** Display name of the publisher. */
  name: string;
  /** JWT token scoped for publishing as this publisher. */
  publish_token: string;
}

/** Options for publishing a single event. */
export interface PublishOptions {
  /** Optional event type string for subscriber filtering. */
  type?: string;
  /** Event payload (will be JSON-serialized, max 64 KB). */
  data: unknown;
}

/** Options for polling events from a channel. */
export interface PollOptions {
  /** Opaque cursor from a previous poll response. */
  cursor?: string;
  /** ISO 8601 timestamp — only return events created after this time. */
  since?: string;
  /** Maximum number of events to return (default: 50). */
  limit?: number;
  /** Filter events by type. */
  type?: string;
}

/** Options for registering a webhook. */
export interface WebhookOptions {
  /** Only deliver events matching these types. Omit for all events. */
  event_types?: string[];
  /** Webhook lifetime in seconds (default: 3 days, max: 30 days). */
  ttl_seconds?: number;
}

/** Subscribe transport mode. */
export type SubscribeMode = 'auto' | 'ws' | 'poll';

/** Options for the subscribe helper. */
export interface SubscribeOptions {
  /** Polling interval in milliseconds. Default: `5000`. */
  interval?: number;
  /** Transport mode. `'auto'` (default) tries WebSocket first, falls back to polling. */
  mode?: SubscribeMode;
  /** Event type filter — passed as `?types=` on WS, `?type=` on poll. */
  type?: string;
}

/** Options for the `tail()` method. Extends poll options with follow mode. */
export interface TailOptions extends PollOptions {
  /** When `true`, subscribe and stream events as they arrive. */
  follow?: boolean;
  /** Transport mode for follow mode. Default: `'auto'`. */
  mode?: SubscribeMode;
  /** Polling interval in ms for follow mode (poll transport). Default: `5000`. */
  interval?: number;
}

/**
 * An async iterable stream of events returned by `tail({ follow: true })`.
 * Call `close()` to stop the underlying subscription and end the stream.
 */
export interface TailStream extends AsyncIterable<ZooidEvent> {
  /** Stop the subscription and end the stream. */
  close(): void;
}

/** Result of generating a signed directory claim. */
export interface ClaimResult {
  /** Base64url-encoded JSON claim payload. */
  claim: string;
  /** Base64url-encoded Ed25519 signature of the claim. */
  signature: string;
}

/** Options for updating server identity metadata. */
export interface UpdateServerMetaOptions {
  /** Server display name. */
  name?: string;
  /** Server description (set to `null` to clear). */
  description?: string | null;
  /** Tags for categorization. */
  tags?: string[];
  /** Operator name (set to `null` to clear). */
  owner?: string | null;
  /** Company name (set to `null` to clear). */
  company?: string | null;
  /** Contact email (set to `null` to clear). */
  email?: string | null;
}
