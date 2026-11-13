import { types } from 'node:util';
import type { NativeExtension, Outcome } from './contracts.js';
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
    | 'reconciling' | 'not-dispatched' | 'outcome-unknown' | 'accepted' | 'conclusive';
};
export type ReconcileResult<T> = Outcome<DispatchSnapshot<T>, {
  readonly code: 'not-ready' | 'unsupported' | 'aborted'
    | 'lookup-failed' | 'invalid-evidence' | 'evidence-conflict';
}>;
export interface ReconciliationHandle<T> {
  readonly reconcile: (signal: AbortSignal) => Promise<ReconcileResult<T>>;
}
export interface DispatchHandle<T> extends ReconciliationHandle<T> {
  readonly run: () => Promise<DispatchSnapshot<T>>;
}
export type ReconcileNative<T> = (
  previous: DispatchSnapshot<T>, signal: AbortSignal,
) => NativeDispatchObservation<T> | PromiseLike<NativeDispatchObservation<T>>;
export interface SharedDispatchOptions<T> {
  readonly identity: DispatchIdentity;
  readonly events?: Pick<EventStream<DispatchLifecycle>, 'publish'>;
  readonly reconcileNative?: ReconcileNative<T>;
}
export interface RecoveryDispatchOptions<T> extends SharedDispatchOptions<T> {
  readonly mode: 'recovery';
  readonly previous?: NativeDispatchObservation<T>;
}
export interface FreshDispatchOptions<T> extends SharedDispatchOptions<T> {
  readonly mode: 'fresh';
  readonly signal: AbortSignal;
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
const evidenceConflict = Symbol('evidence-conflict');
function copyEvidence(value: unknown, expected: DispatchIdentity,
  expectedSource: DispatchEvidence['source'] | null): DispatchEvidence {
  const { identity: rawIdentity, source, nativeOperation: rawOperation, observation: rawObservation } = record(value);
  const identity = copyIdentity(rawIdentity);
  if ((source !== 'native-acknowledgement' && source !== 'authoritative-native-lookup')
    || (expectedSource !== null && source !== expectedSource)) throw new TypeError();
  if (JSON.stringify(identity) !== JSON.stringify(expected)) throw evidenceConflict;
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
function copyObservation<T>(value: NativeDispatchObservation<T>, identity: DispatchIdentity,
  source: DispatchEvidence['source'] | null = 'native-acknowledgement'): NativeDispatchObservation<T> {
  record(value);
  const { kind } = value;
  if (kind === 'outcome-unknown') return Object.freeze({ kind });
  if (kind !== 'accepted' && kind !== 'conclusive') throw new TypeError();
  const evidence = copyEvidence(value.evidence, identity, source);
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
function validSignal(signal: AbortSignal): void {
  if (types.isProxy(signal)) throw new TypeError('Invalid dispatch signal.');
  aborted(signal);
}
function copyOptions<T>(options: FreshDispatchOptions<T> | RecoveryDispatchOptions<T>) {
  try {
    record(options);
    const { mode, identity: rawIdentity, events, reconcileNative } = options;
    const identity = copyIdentity(rawIdentity);
    if (events !== undefined) record(events);
    const publish = events?.publish;
    if (events !== undefined && typeof publish !== 'function') throw new TypeError();
    if (reconcileNative !== undefined && typeof reconcileNative !== 'function') throw new TypeError();
    const shared = { identity, events, publish, reconcileNative };
    if (mode === 'recovery') {
      const previous = options.previous;
      const observation: NativeDispatchObservation<T> = previous === undefined ? Object.freeze({ kind: 'outcome-unknown' })
        : copyObservation(previous, identity, null);
      return Object.freeze({ ...shared, mode, previous: Object.freeze({ identity, observation }) });
    }
    if (mode !== 'fresh') throw new TypeError();
    const { signal, recordIntent, dispatchNative } = options;
    if (typeof recordIntent !== 'function' || typeof dispatchNative !== 'function') throw new TypeError();
    validSignal(signal);
    return Object.freeze({ ...shared, mode, signal, recordIntent, dispatchNative });
  } catch {
    throw new TypeError('Invalid dispatch options.');
  }
}
type CapturedOptions<T> = ReturnType<typeof copyOptions<T>>;

function createReconciler<T>(options: CapturedOptions<T>, emit: (phase: DispatchLifecycle['phase']) => void) {
  let current: DispatchSnapshot<T> | undefined = options.mode === 'recovery' ? options.previous : undefined;
  let pending: Promise<ReconcileResult<T>> | undefined;
  async function lookup(previous: DispatchSnapshot<T>, signal: AbortSignal): Promise<ReconcileResult<T>> {
    if (previous.observation.kind === 'conclusive' || previous.observation.kind === 'not-dispatched') {
      return Object.freeze({ kind: 'ok', value: previous });
    }
    const { reconcileNative } = options;
    if (reconcileNative === undefined) return fail('unsupported');
    validSignal(signal);
    if (aborted(signal)) return fail('aborted');
    emit('reconciling');
    if (aborted(signal)) return fail('aborted');
    let raw: NativeDispatchObservation<T>;
    try { raw = await reconcileNative(previous, signal); }
    catch { return fail(aborted(signal) ? 'aborted' : 'lookup-failed'); }
    let observation: NativeDispatchObservation<T>;
    try {
      observation = copyObservation(raw, options.identity, 'authoritative-native-lookup');
      if (observation.kind !== 'outcome-unknown' && previous.observation.kind === 'accepted') {
        const known = previous.observation.evidence.nativeOperation;
        const next = observation.evidence.nativeOperation;
        if (known !== null && next !== null && (known.id !== next.id || known.namespace !== next.namespace)) {
          return fail('evidence-conflict');
        }
        if (known !== null && next === null) observation = Object.freeze({ ...observation,
          evidence: Object.freeze({ ...observation.evidence, nativeOperation: known }) });
      }
    } catch (error) { return fail(error === evidenceConflict ? 'evidence-conflict' : 'invalid-evidence'); }
    if (observation.kind === 'outcome-unknown') {
      if (aborted(signal)) return fail('aborted');
    }
    const snapshot = observation.kind === 'outcome-unknown' ? previous
      : Object.freeze({ identity: options.identity, observation });
    current = snapshot;
    emit(snapshot.observation.kind);
    return Object.freeze({ kind: 'ok', value: snapshot });
  }
  function fail(code: Extract<ReconcileResult<T>, { kind: 'error' }>['error']['code']): ReconcileResult<T> {
    return Object.freeze({ kind: 'error', error: Object.freeze({ code }) });
  }
  function reconcile(signal: AbortSignal): Promise<ReconcileResult<T>> {
    const previous = current;
    if (previous === undefined) return Promise.resolve(fail('not-ready'));
    pending ??= Promise.resolve().then(() => lookup(previous, signal)).finally(() => { pending = undefined; });
    return pending;
  }
  return { reconcile, observe(snapshot: DispatchSnapshot<T>) { current = snapshot; } };
}

/**
 * Fresh execution makes one native attempt. Recovery only observes. The host must
 * persist the exact command and acquire durable admission before recordIntent
 * resolves. Uniqueness across handles and
 * processes belongs to the host. Evidence confirms correspondence, not authority.
 * Callbacks are cooperative. Awaiting this handle's run inside a callback creates
 * a dependency cycle. Reconciliation is explicit and never dispatches or polls.
 */
export function createDispatchOperation<T>(options: FreshDispatchOptions<T>): DispatchHandle<T>;
export function createDispatchOperation<T>(options: RecoveryDispatchOptions<T>): ReconciliationHandle<T>;
export function createDispatchOperation<T>(options: FreshDispatchOptions<T> | RecoveryDispatchOptions<T>) {
  const captured = copyOptions(options);
  const { events, publish } = captured;
  function emit(phase: DispatchLifecycle['phase']): void {
    try { publish?.call(events, Object.freeze({ phase })); } catch {}
  }
  const reconciler = createReconciler(captured, emit);
  if (captured.mode === 'recovery') return Object.freeze({ reconcile: reconciler.reconcile });
  return createFreshOperation(captured, reconciler, emit);
}
function createFreshOperation<T>(options: Extract<CapturedOptions<T>, { mode: 'fresh' }>,
  reconciler: ReturnType<typeof createReconciler<T>>, emit: (phase: DispatchLifecycle['phase']) => void): DispatchHandle<T> {
  const { identity, signal, recordIntent, dispatchNative } = options;
  let pending: Promise<DispatchSnapshot<T>> | undefined;

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
    pending ??= Promise.resolve().then(execute).then((snapshot) => {
      reconciler.observe(snapshot);
      return snapshot;
    });
    return pending;
  }
  return Object.freeze({ run, reconcile: reconciler.reconcile });
}
