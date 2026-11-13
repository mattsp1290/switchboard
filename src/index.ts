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
