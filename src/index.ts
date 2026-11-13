export type { Capability } from './core/capabilities.js';
export type {
  AdapterError,
  AdapterIdentity,
  AdapterInstance,
  AdapterRegistration,
  NativeExtension,
  Outcome,
} from './core/contracts.js';
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
