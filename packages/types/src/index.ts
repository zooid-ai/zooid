/**
 * A published event as returned by the API.
 *
 * Events are the core unit of data in Zooid. Each event belongs to a channel
 * and is identified by a time-ordered ULID.
 */
export interface ZooidEvent {
  /** Time-ordered ULID that uniquely identifies this event. */
  id: string;
  /** The channel this event was published to. */
  channel_id: string;
  /** ID of the publisher that created this event, or `null` for admin publishes. */
  publisher_id: string | null;
  /** Optional event type string for filtering (e.g. `"trade"`, `"alert"`). */
  type: string | null;
  /** JSON-serialized event payload (max 64 KB). */
  data: string;
  /** ISO 8601 timestamp when the event was created. */
  created_at: string;
}

/**
 * Cursor-paginated poll response.
 *
 * Returned by `GET /api/v1/channels/:id/events`. Use `cursor` in subsequent
 * requests to fetch the next page.
 */
export interface PollResult {
  /** Array of events in this page, ordered by ID ascending. */
  events: ZooidEvent[];
  /** Opaque cursor for the next page, or `null` if no more events. */
  cursor: string | null;
  /** `true` if there are additional events beyond this page. */
  has_more: boolean;
}

/**
 * Public channel listing returned by `GET /api/v1/channels`.
 *
 * Includes aggregate stats (event count, publishers) alongside
 * the channel's configuration.
 */
export interface ChannelListItem {
  /** URL-safe slug identifier (lowercase + hyphens, 3-64 chars). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Optional description of the channel's purpose. */
  description: string | null;
  /** Arbitrary tags for categorization. */
  tags: string[];
  /** Whether the channel is publicly accessible without a token. */
  is_public: boolean;
  /** Optional JSON Schema that published events must conform to. */
  schema: Record<string, unknown> | null;
  /** When `true`, events are rejected if they don't match `schema`. */
  strict: boolean;
  /** Total number of events currently stored in this channel. */
  event_count: number;
  /** ISO 8601 timestamp of the most recent event, or `null` if empty. */
  last_event_at: string | null;
  /** Names of publishers registered on this channel. */
  publishers: string[];
}

/**
 * A registered webhook subscription.
 *
 * Webhooks receive POST requests for each new event published
 * to the subscribed channel.
 */
export interface Webhook {
  /** ULID identifier for this webhook registration. */
  id: string;
  /** Channel this webhook is subscribed to. */
  channel_id: string;
  /** URL that receives event POST requests. */
  url: string;
  /** JSON-encoded array of event types to filter, or `null` for all events. */
  event_types: string | null;
  /** ISO 8601 timestamp when this webhook expires. */
  expires_at: string;
  /** ISO 8601 timestamp when this webhook was created. */
  created_at: string;
}

/**
 * Server discovery metadata from `GET /.well-known/zooid.json`.
 *
 * Contains the information needed by agents to discover and verify
 * a Zooid server: its public signing key, supported delivery mechanisms,
 * and recommended poll interval.
 */
export interface ServerDiscovery {
  /** Zooid protocol version (semver). */
  version: string;
  /** Base64-encoded Ed25519 public key for webhook signature verification. */
  public_key: string;
  /** Key encoding format (e.g. `"raw"`). */
  public_key_format: string;
  /** Signing algorithm (e.g. `"Ed25519"`). */
  algorithm: string;
  /** Unique identifier for this server instance. */
  server_id: string;
  /** Recommended poll interval in seconds. */
  poll_interval: number;
  /** Supported delivery mechanisms (e.g. `["polling", "webhooks", "rss"]`). */
  delivery: string[];
}

/**
 * Editable server identity from `GET /api/v1/server` and `PUT /api/v1/server`.
 *
 * Human-readable metadata about who operates this Zooid instance.
 * Editable by admins.
 */
export interface ServerIdentity {
  /** Display name for this server. */
  name: string;
  /** Optional description of this server's purpose. */
  description: string | null;
  /** Arbitrary tags for categorization. */
  tags: string[];
  /** Name of the server operator. */
  owner: string | null;
  /** Company or organization name. */
  company: string | null;
  /** Contact email address. */
  email: string | null;
  /** ISO 8601 timestamp of the last update. */
  updated_at: string;
}

// Deprecated aliases for backward compatibility

/** @deprecated Use {@link ServerDiscovery} instead. */
export type ServerMetadata = ServerDiscovery;

/** @deprecated Use {@link ServerIdentity} instead. */
export type ServerMeta = ServerIdentity;
