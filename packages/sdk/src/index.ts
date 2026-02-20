export { ZooidClient } from './client';
export { ZooidError } from './error';
export { verifyWebhook } from './verify';
export type { VerifyWebhookOptions } from './verify';
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
  TailOptions,
  TailStream,
  UpdateServerMetaOptions,
  ClaimResult,
} from './types';

// Deprecated aliases for backward compatibility
export type { ServerMetadata, ServerMeta } from './types';
