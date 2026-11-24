import type { HostAdapterError, Outcome } from '#switchboard';
import { capturePiHostOptions, piHostIdentity } from './contract.js';
import type { PiHostAdapter, PiHostOpenOptions } from './contract.js';

export { isPiHostSystemEntry, piHostIdentity, piHostLimits, piHostSessionStateSchema, validatePiHostSessionState } from './contract.js';
export type {
  PiHostAdapter, PiHostModelEvent, PiHostModelRequest, PiHostModelStream, PiHostOpenOptions, PiHostSessionState,
  PiHostToolCall, PiHostTurn,
} from './contract.js';

/**
 * In-process Pi host adapter. A host stream reaches the model with no socket and no credential.
 * A host-declared route is admitted only when the host supplies no stream. Subscription passthrough is absent.
 */
export const piHostAdapter = Object.freeze({
  identity: piHostIdentity,
  open: async (options: PiHostOpenOptions, signal: AbortSignal): Promise<Outcome<PiHostAdapter, HostAdapterError>> => {
    const captured = capturePiHostOptions(options, signal);
    if (captured.kind === 'error') return captured;
    try {
      const { openPiHostSession } = await import('./runtime.js');
      return await openPiHostSession(captured.value, signal);
    } catch { return { kind: 'error', error: { code: 'native-failure', message: 'The Pi host session could not be opened.' } }; }
  },
});
