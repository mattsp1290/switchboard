import type { HostAdapterError, Outcome } from '#switchboard';
import { piHostIdentity } from './contract.js';
import type { PiHostAdapter, PiHostOpenOptions } from './contract.js';

export { isPiHostSystemEntry, piHostIdentity, piHostLimits, piHostSessionStateSchema, validatePiHostSessionState } from './contract.js';
export type {
  PiHostAdapter, PiHostModelEvent, PiHostModelRequest, PiHostModelStream, PiHostOpenOptions, PiHostSessionState,
  PiHostToolCall, PiHostTurn,
} from './contract.js';

/**
 * In-process Pi host adapter. A host stream reaches the model with no socket and no credential.
 * Subscription passthrough is absent. This adapter does not admit a host route.
 */
export const piHostAdapter = Object.freeze({
  identity: piHostIdentity,
  open: async (options: PiHostOpenOptions, signal: AbortSignal): Promise<Outcome<PiHostAdapter, HostAdapterError>> => {
    const { openPiHostSession } = await import('./runtime.js');
    return openPiHostSession(options, signal);
  },
});
