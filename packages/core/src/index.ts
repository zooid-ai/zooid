export {
  loadZooidConfig,
  mergeCliFlags,
  findTransport,
  findMatrixTransport,
  findHttpTransport,
  findConfigFile,
} from './config.js'
export type { LoadZooidConfigOptions } from './config.js'
export { renderTemplate } from './render-template.js'
export { compileMatch, evaluateMatch } from './match-expression.js'
export type { MatchContext } from './match-expression.js'
export { AcpAgentRegistry, resolveAcpAgentSpec } from './acp-registry.js'
export { resolveAgentRuntime, isContainerRuntime, containerEngineOf } from './runtime-resolve.js'
export {
  ApprovalCorrelator,
  type RegisteredApproval,
  type RegisterOptions,
} from './approval-correlator.js'
export type {
  AcpRegistry,
  AcpAgentRegistryOptions,
  AcpRegistryEventHandler,
  AcpRegistryApprovalHandler,
  ContextSpawnFactory,
} from './acp-registry.js'
export type { TapEvent } from '@zooid/acp-client'
export type { SessionLifecycleEvent } from '@zooid/acp-client'
export type { AcpAgentSpec, AcpMount, AcpRuntime, AcpSpawnSpec } from './acp-types.js'
export type {
  AgentConfig,
  ContainerConfig,
  MountConfig,
  ZooidContainerConfig,
  RuntimeKind,
  VmConfig,
  MatrixBinding,
  RoomBinding,
  HttpBinding,
  ZooidConfig,
  TransportConfig,
  MatrixTransportConfig,
  HttpTransportConfig,
  CliFlags,
  Transport,
  InboundMessage,
  ThreadRef,
  TriggerConfig,
  TriggerMessage,
  WebhookTriggerConfig,
} from './types.js'
export type {
  HistoryOptions,
  HistoryPage,
  Message,
  Member,
  RoomInfo,
  SendMessageInput,
  SendMessageResult,
  ThreadOverview,
  ThreadOverviewPage,
  TransportContextProvider,
} from './transport-context.js'
export * from './task-actions.js'

export { ElicitationCorrelator } from './elicitation-correlator.js'
export type { ElicitationResolution, ElicitationStatus, PendingElicitation, RegisterElicitationInput } from './elicitation-correlator.js'
export { unsupportedSchemaReasons, validateElicitationContent } from './elicitation-schema.js'
export type { ElicitationContent, ElicitationValidation } from './elicitation-schema.js'
export type { AcpRegistryElicitationHandler } from './acp-registry.js'
