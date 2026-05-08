export { MatrixClient } from './matrix-client.js'
export type { MatrixClientOptions, SendMessageInput, SendCustomEventInput } from './matrix-client.js'
export { renderRegistration } from './registration.js'
export type { MatrixTransportConfig } from './registration.js'
export { extractMentions } from './mentions.js'
export type { MaybeMessage } from './mentions.js'
export { route } from './router.js'
export type { AgentBinding, RouteMatch } from './router.js'
export { BotPool } from './bot-pool.js'
export { createMatrixTransport } from './transport.js'
export type { CreateMatrixTransportOptions } from './transport.js'
export { ensureWorkforceSpace } from './space-provisioner.js'
export type { EnsureSpaceOpts } from './space-provisioner.js'
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
