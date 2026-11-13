import { createDispatchOperation, createEventStream } from '@mattsp1290/switchboard';
import type {
  DispatchEvidence, DispatchHandle, DispatchIdentity, DispatchLifecycle, DispatchObservation,
  DispatchSnapshot, DispatchTarget, FreshDispatchOptions, NativeDispatchObservation, NativeOperationReference,
} from '@mattsp1290/switchboard';
import { sessionBinding, sessionReference } from './sessions.test.js';

export const dispatchTarget: DispatchTarget = { kind: 'new-session', binding: sessionBinding };
export const dispatchIdentity: DispatchIdentity = { hostOperationId: 'host-operation', target: dispatchTarget };
export const nativeOperation: NativeOperationReference = { namespace: 'native/command', id: 'receipt' };
export const dispatchEvidence: DispatchEvidence = {
  identity: dispatchIdentity, source: 'native-acknowledgement', nativeOperation,
  observation: { namespace: 'native/ack', schemaVersion: 1, data: undefined },
};
export const dispatchEvents = createEventStream<DispatchLifecycle>({ maxObservers: 2, capacity: 4 });
export const dispatchOptions: FreshDispatchOptions<{ readonly state: 'pending' | 'rejected' | 'cancelled' }> = {
  mode: 'fresh', identity: dispatchIdentity, signal: new AbortController().signal, events: dispatchEvents,
  recordIntent: async (_identity, _signal) => {},
  dispatchNative: (_identity, _signal) => ({ kind: 'conclusive', evidence: dispatchEvidence, result: { state: 'pending' } }),
};
export const dispatchHandle: DispatchHandle<{ readonly state: 'pending' | 'rejected' | 'cancelled' }> = createDispatchOperation(dispatchOptions);
export const dispatchPromise: Promise<DispatchSnapshot<{ readonly state: 'pending' | 'rejected' | 'cancelled' }>> = dispatchHandle.run();
export const existingTarget: DispatchTarget = { kind: 'session', reference: sessionReference };
export const nativeObservation: NativeDispatchObservation<unknown> = { kind: 'accepted', evidence: dispatchEvidence };
export declare const unknownObservation: DispatchObservation<unknown>;
export function dispatchState(value: DispatchObservation<{ readonly state: string }>): string {
  switch (value.kind) {
    case 'not-dispatched': return value.reason;
    case 'outcome-unknown': return value.kind;
    case 'accepted': return value.evidence.source;
    case 'conclusive': return value.result.state;
    default: { const exhaustive: never = value; return exhaustive; }
  }
}
