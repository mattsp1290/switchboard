export type { Capability } from './core/capabilities.js';
export type {
  AdapterError,
  AdapterIdentity,
  AdapterInstance,
  AdapterRegistration,
  NativeExtension,
  Outcome,
} from './core/contracts.js';
export { createEventStream } from './core/events.js';
export type {
  EventListener,
  EventObserver,
  EventStream,
  EventStreamBounds,
  PublishResult,
  SubscribeError,
  Subscription,
  SubscriptionEnd,
} from './core/events.js';
export {
  parseCheckpointReference,
  parseSessionReference,
  sessionLimits,
  validateSessionDiscoveryBounds,
} from './core/sessions.js';
export type {
  CheckpointReference,
  SessionAccess,
  SessionBinding,
  SessionCorrelation,
  SessionDiscovery,
  SessionDiscoveryBounds,
  SessionDiscoveryPage,
  SessionInspection,
  SessionInspectionResult,
  SessionOperationError,
  SessionReference,
  SessionReferenceError,
} from './core/sessions.js';
export { createAuthContext } from './core/auth.js';
export type {
  AuthBoundary,
  AuthConfiguration,
  AuthError,
  AuthResolutionContext,
  AuthRoute,
  AuthScope,
  CredentialResolver,
  ProxyCredential,
  ResolvedAuthentication,
  ScopedAuth,
} from './core/auth.js';
export { interactionLimits, parseInteractionContinuation } from './core/interaction.js';
export type {
  ApprovalTarget,
  DelegatedOutcome,
  DelegationTarget,
  HostApprovalIntent,
  HostApprovalPolicy,
  InteractionContinuation,
  InteractionError,
  InteractionTarget,
  NativeDelivery,
  PendingApproval,
  PendingInteraction,
  ToolEffect,
  ToolOutcome,
  ToolTarget,
} from './core/interaction.js';
export { discoverFiles, fileDiscoveryLimits } from './core/discovery.js';
export type {
  FileDecode,
  FileDiscoveryBounds,
  FileDiscoveryError,
  FileDiscoveryPage,
  FileDiscoveryScope,
} from './core/discovery.js';

export { createSafeError, normalizeError, summarizeDiagnostic, serializeDiagnostic } from './core/diagnostics.js';
export type { DiagnosticCode, DiagnosticCategory, SafeError, SafeDiagnostic } from './core/diagnostics.js';
export { createDispatchOperation } from './core/dispatch.js';
export type {
  DispatchTarget, DispatchIdentity, NativeOperationReference, DispatchEvidence,
  NativeDispatchObservation, DispatchObservation, DispatchSnapshot, DispatchLifecycle,
  DispatchHandle, FreshDispatchOptions, ReconcileResult, ReconciliationHandle,
  ReconcileNative, SharedDispatchOptions, RecoveryDispatchOptions,
} from './core/dispatch.js';
