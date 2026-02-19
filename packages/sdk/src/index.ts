export { ZooidClient } from './client';
export { ZooidError } from './error';
export type {
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
  SubscribeMode,
  SubscribeOptions,
  UpdateServerMetaOptions,
} from './types';

// Deprecated aliases for backward compatibility
export type { ServerMetadata, ServerMeta } from './types';
