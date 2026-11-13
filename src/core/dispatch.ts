import { types } from 'node:util';
import type { NativeExtension } from './contracts.js';
import type { EventStream } from './events.js';
import { parseSessionReference, sessionLimits } from './sessions.js';
import type { SessionBinding, SessionReference } from './sessions.js';

export type DispatchTarget =
  | { readonly kind: 'session'; readonly reference: SessionReference }
  | { readonly kind: 'new-session'; readonly binding: SessionBinding };
export interface DispatchIdentity {
  readonly hostOperationId: string;
  readonly target: DispatchTarget;
}
export interface NativeOperationReference {
  readonly namespace: string;
  readonly id: string;
}
export interface DispatchEvidence {
  readonly identity: DispatchIdentity;
  readonly source: 'native-acknowledgement' | 'authoritative-native-lookup';
  readonly nativeOperation: NativeOperationReference | null;
  readonly observation: NativeExtension;
}
export type NativeDispatchObservation<T> =
  | { readonly kind: 'outcome-unknown' }
  | { readonly kind: 'accepted'; readonly evidence: DispatchEvidence }
  | { readonly kind: 'conclusive'; readonly evidence: DispatchEvidence; readonly result: T };
export type DispatchObservation<T> = NativeDispatchObservation<T>
  | { readonly kind: 'not-dispatched'; readonly reason: 'aborted' | 'intent-failed' };
export interface DispatchSnapshot<T> {
  readonly identity: DispatchIdentity;
  readonly observation: DispatchObservation<T>;
}
export type DispatchLifecycle = {
  readonly phase: 'recording-intent' | 'dispatching'
    | 'not-dispatched' | 'outcome-unknown' | 'accepted' | 'conclusive';
};
export interface DispatchHandle<T> {
  readonly run: () => Promise<DispatchSnapshot<T>>;
}
export interface FreshDispatchOptions<T> {
  readonly mode: 'fresh';
  readonly identity: DispatchIdentity;
  readonly signal: AbortSignal;
  readonly events?: Pick<EventStream<DispatchLifecycle>, 'publish'>;
  readonly recordIntent: (identity: DispatchIdentity, signal: AbortSignal) => void | PromiseLike<void>;
  readonly dispatchNative: (identity: DispatchIdentity, signal: AbortSignal)
    => NativeDispatchObservation<T> | PromiseLike<NativeDispatchObservation<T>>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0
    || value.length > sessionLimits.identifierLength) throw new TypeError();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) throw new TypeError();
  }
  return value;
}
function copyBinding(value: unknown): SessionBinding {
  const { engine, nativeVersion, account, authorizedScope, nativeFormat } = record(value);
  return Object.freeze({ engine: text(engine), nativeVersion: text(nativeVersion), account: text(account),
    authorizedScope: text(authorizedScope), nativeFormat: text(nativeFormat) });
}
function copyIdentity(value: unknown): DispatchIdentity {
  const { hostOperationId, target: rawTarget } = record(value);
  const target = record(rawTarget);
  const { kind } = target;
  if (kind === 'new-session') {
    return Object.freeze({ hostOperationId: text(hostOperationId),
      target: Object.freeze({ kind, binding: copyBinding(target.binding) }) });
  }
  if (kind !== 'session') throw new TypeError();
  const { kind: referenceKind, formatVersion, binding: rawBinding, opaque } = record(target.reference);
  const binding = copyBinding(rawBinding);
  const parsed = parseSessionReference({
    value: { kind: referenceKind, formatVersion, binding, opaque }, expected: binding,
  });
  if (parsed.kind === 'error') throw new TypeError();
  return Object.freeze({ hostOperationId: text(hostOperationId),
    target: Object.freeze({ kind, reference: parsed.value }) });
}
function copyEvidence(value: unknown, expected: DispatchIdentity): DispatchEvidence {
  const { identity: rawIdentity, source, nativeOperation: rawOperation, observation: rawObservation } = record(value);
  const identity = copyIdentity(rawIdentity);
  if (source !== 'native-acknowledgement' || JSON.stringify(identity) !== JSON.stringify(expected)) throw new TypeError();
  let nativeOperation: NativeOperationReference | null = null;
  if (rawOperation !== null) {
    const { namespace, id } = record(rawOperation);
    nativeOperation = Object.freeze({ namespace: text(namespace), id: text(id) });
  }
  const observation = record(rawObservation);
  const { namespace, schemaVersion, data } = observation;
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion)
    || schemaVersion < 1 || !Object.hasOwn(observation, 'data')) throw new TypeError();
  return Object.freeze({ identity, source, nativeOperation,
    observation: Object.freeze({ namespace: text(namespace), schemaVersion, data }) });
}
function copyObservation<T>(value: NativeDispatchObservation<T>, identity: DispatchIdentity): NativeDispatchObservation<T> {
  record(value);
  const { kind } = value;
  if (kind === 'outcome-unknown') return Object.freeze({ kind });
  if (kind !== 'accepted' && kind !== 'conclusive') throw new TypeError();
  const evidence = copyEvidence(value.evidence, identity);
  if (kind === 'accepted') return Object.freeze({ kind, evidence });
  if (!Object.hasOwn(value, 'result')) throw new TypeError();
  return Object.freeze({ kind, evidence, result: value.result });
}
function aborted(signal: AbortSignal): boolean {
  try {
    return Reflect.get(AbortSignal.prototype, 'aborted', signal) === true;
  } catch {
    throw new TypeError('Invalid dispatch signal.');
  }
}
function copyOptions<T>(options: FreshDispatchOptions<T>) {
  try {
    record(options);
    const { mode, identity: rawIdentity, signal, recordIntent, dispatchNative, events } = options;
    if (mode !== 'fresh' || typeof recordIntent !== 'function' || typeof dispatchNative !== 'function') throw new TypeError();
    if (types.isProxy(signal)) throw new TypeError();
    aborted(signal);
    const identity = copyIdentity(rawIdentity);
    if (events !== undefined) record(events);
    const publish = events?.publish;
    if (events !== undefined && typeof publish !== 'function') throw new TypeError();
    return Object.freeze({ identity, signal, recordIntent, dispatchNative, events, publish });
  } catch {
    throw new TypeError('Invalid dispatch options.');
  }
}

/**
 * One fresh native attempt. The host must persist the exact command and acquire
 * durable admission before recordIntent resolves. Uniqueness across handles and
 * processes belongs to the host. Evidence confirms correspondence, not authority.
 * Callbacks are cooperative. Awaiting this handle's run inside a callback creates
 * a dependency cycle. No timeout, retry, polling, or recovery executor is provided.
 */
export function createDispatchOperation<T>(options: FreshDispatchOptions<T>): DispatchHandle<T> {
  const { identity, signal, recordIntent, dispatchNative, events, publish } = copyOptions(options);
  let pending: Promise<DispatchSnapshot<T>> | undefined;

  function emit(phase: DispatchLifecycle['phase']): void {
    try { publish?.call(events, Object.freeze({ phase })); } catch {}
  }
  function finish(observation: DispatchObservation<T>): DispatchSnapshot<T> {
    const snapshot = Object.freeze({ identity, observation: Object.freeze(observation) });
    emit(observation.kind);
    return snapshot;
  }
  async function execute(): Promise<DispatchSnapshot<T>> {
    if (aborted(signal)) return finish({ kind: 'not-dispatched', reason: 'aborted' });
    emit('recording-intent');
    if (aborted(signal)) return finish({ kind: 'not-dispatched', reason: 'aborted' });
    try {
      await recordIntent(identity, signal);
    } catch {
      return finish({ kind: 'not-dispatched', reason: 'intent-failed' });
    }
    if (aborted(signal)) return finish({ kind: 'not-dispatched', reason: 'aborted' });
    emit('dispatching');
    if (aborted(signal)) return finish({ kind: 'not-dispatched', reason: 'aborted' });
    try {
      const observation = await dispatchNative(identity, signal);
      return finish(copyObservation(observation, identity));
    } catch {
      return finish({ kind: 'outcome-unknown' });
    }
  }
  function run(): Promise<DispatchSnapshot<T>> {
    pending ??= Promise.resolve().then(execute);
    return pending;
  }
  return Object.freeze({ run });
}
