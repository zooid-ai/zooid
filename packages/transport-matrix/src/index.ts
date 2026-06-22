export { MatrixClient } from './matrix-client.js'
export type { MatrixClientOptions, SendMessageInput, SendCustomEventInput } from './matrix-client.js'
export { MatrixContextProvider } from './context-provider.js'
export type { MatrixContextProviderOpts } from './context-provider.js'
export { renderRegistration } from './registration.js'
export type { MatrixTransportConfig } from './registration.js'
export {
  isValidSlug,
  isValidAgentKey,
  agentMxid,
  splitAgentLocalpart,
  slugUserNamespace,
  SLUG_RE,
  AGENT_KEY_RE,
} from './identity.js'
export { extractMentions } from './mentions.js'
export type { MaybeMessage } from './mentions.js'
export { route, isMediaMsgtype, MEDIA_MSGTYPES } from './router.js'
export type { AgentBinding, RouteMatch } from './router.js'
export { BotPool } from './bot-pool.js'
export { createMatrixTransport } from './transport.js'
export type { CreateMatrixTransportOptions, MediaClientLike } from './transport.js'
export { ensureDefaultChannel, ensureWorkforceSpace, serverNameFromMxid } from './space-provisioner.js'
export type { EnsureDefaultChannelOpts, EnsureSpaceOpts } from './space-provisioner.js'
export {
  buildWorkforceRoster,
  publishWorkforce,
  startWorkforcePublisher,
} from './workforce-publisher.js'
export type {
  WorkforceRoster,
  PublishOpts,
  PublisherHandle,
  StartOpts as StartWorkforcePublisherOpts,
} from './workforce-publisher.js'
export { MediaClient, parseMxcUri, MAX_INLINE_IMAGE_BYTES, INLINE_IMAGE_MIMES, MAX_DOWNLOAD_BYTES } from './media-client.js'
export type { MediaClientOptions } from './media-client.js'
export { PendingMediaStore, MAX_MEDIA_PER_TURN } from './pending-media.js'
export type { PendingMediaItem } from './pending-media.js'
export { writeAttachment } from './attachments.js'
export type { WriteAttachmentInput } from './attachments.js'
