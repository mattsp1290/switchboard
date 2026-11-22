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
  SessionDiscoveryDiagnostic,
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
  HostRouteCredential,
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
export {
  assessFrontendRestore, compareRestoreDecisions, decideFrontendRestore, frontendRestoreCapabilities,
  frontendRestoreDefaultRevision, frontendRestoreDelivery, frontendRestoreFact, frontendRestoreLimits,
  parsePendingFrontendBatch, validateRestoreDecision,
} from './core/frontend-restore.js';
export type {
  DeliveryClass, FrontendRestoreCapabilities, FrontendRestoreError, FrontendRestoreFact, FrontendRestoreFactInput,
  FrontendRestorePayload, FrontendRestorePolicy, IndeterminateReason, PendingFrontendBatch, PendingFrontendCall,
  RestoreAdapter, RestoreAdmission, RestoreChoice, RestoreDecision, RestoreDecisionComparison, RestoreMechanism,
  RestoreMechanismSupport, RestoreObservation, RestoreOption, RestoreQualification, RestoreSituation,
  RestoreSituationKind,
} from './core/frontend-restore.js';
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
export type {
  HostAdapter, HostAdapterCapabilities, HostAdapterError, HostAdapterEvent, HostAdapterRegistration, HostContinueInput,
  HostImageInput, HostImageInputApi, HostPendingSet, HostNativeError, HostModel, HostModelsApi,
  HostEnvironment, HostFingerprintApi, HostInspectApi, HostInterruptResult, HostLaunch, HostOpenOptions, HostResume,
  HostRunInput, HostSegmentRequest, HostSegmentResult, HostToolCall, HostToolDeclaration, HostUsage, HostWriteStatus,
} from './core/host-adapter.js';
export type {
  AuthenticationObservation, InstallationObservation, ReadinessActionCode, ReadinessFact, ReadinessFacts,
  ReadinessRemediationCode, ReadinessReport, ReadinessSource, ReadinessUnknownCode, UnobservedState,
  VersionObservation, WorkspaceObservation,
} from './core/readiness.js';
export {
  answeredToolObservations, createToolTracker, declaredToolObservations, emitObservation, emitRunStarted, isOptionalObservationListener, jsonString, normalizeUsage, normalizedUsageFromCounts,
  runObservationFamilies, runtimeOutcome, segmentTerminal, tokenCount, unobservedFamilies, usageFromCounts, usageFromUncachedCounts,
} from './core/run-observation.js';
export type {
  RunObservation, RunObservationFamily, RunObservationListener, RunObservationOutcome, RunObservationToolPhase,
  RunObservationUsage, ToolTracker,
} from './core/run-observation.js';

export { parseHostImages, hostImageLimits, hostImagesRequested } from './core/image-input.js';
export type { ValidatedHostImage } from './core/image-input.js';

export { callerModelId } from './core/model-input.js';
