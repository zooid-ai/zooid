// Re-export shared API types
export type {
  ZooidEvent,
  PollResult,
  ChannelListItem,
  Webhook,
  ServerDiscovery,
  ServerIdentity,
} from '@zooid/types';

// Deprecated aliases for backward compatibility
export type { ServerMetadata, ServerMeta } from '@zooid/types';

// Server-internal types

import type { ChannelDO } from './do/channel';

export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  CHANNEL_DO: DurableObjectNamespace<ChannelDO>;
  ZOOID_JWT_SECRET: string;
  ZOOID_SIGNING_KEY?: string;
  ZOOID_PUBLIC_KEY?: string;
  ZOOID_SERVER_ID?: string;
  ZOOID_SERVER_NAME?: string;
  ZOOID_SERVER_DESC?: string;
  ZOOID_TOKEN_EXPIRY?: string;
  ZOOID_POLL_INTERVAL?: string;
}

export interface ZooidJWT {
  scope: 'admin' | 'publish' | 'subscribe';
  channel?: string;
  sub?: string; // Publisher ID (standard JWT subject claim)
  iat: number;
  exp?: number;
}

/** Raw DB row — is_public and strict are stored as INTEGER (0/1) */
export interface Channel {
  id: string;
  name: string;
  description: string | null;
  tags: string | null;
  is_public: number;
  schema: string | null;
  strict: number;
  max_subscribers: number;
  created_at: string;
}

export interface Publisher {
  id: string;
  channel_id: string;
  name: string;
  created_at: string;
}

export interface Variables {
  jwtPayload: ZooidJWT;
  channelIsPublic?: boolean;
}
