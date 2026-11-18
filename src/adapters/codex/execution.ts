import { addAbortListener } from 'node:events';
import type { Outcome } from '../../core/contracts.js';
import { createDispatchOperation } from '../../core/dispatch.js';
import type { DispatchEvidence, DispatchHandle, DispatchIdentity, DispatchLifecycle, FreshDispatchOptions,
  NativeDispatchObservation, NativeOperationReference } from '../../core/dispatch.js';
import { createEventStream } from '../../core/events.js';
import type { EventObserver, EventStream } from '../../core/events.js';
import { copyBinding, parseSessionReference, sessionLimits } from '../../core/sessions.js';
import type { SessionBinding, SessionDiscoveryBounds, SessionOperationError, SessionReference,
  SessionReferenceError } from '../../core/sessions.js';
import { codexSessions } from './sessions.js';
import type { CodexResumePreparation, CodexSessionScope } from './sessions.js';
import { openCodexTransport } from './transport.js';
import type { BorrowedChannel, CloseReport, CodexTransport, EndReason, Observation, SendFailure, TransportBounds,
  TransportOptions } from './transport.js';
import type { RpcError } from './wire.js';

/**
 * Process-local writer reservations keyed by the complete validated canonical SessionReference. One registry spans
 * every execution that shares it (default: one per Node process), so a replacement app-server cannot admit a second
 * writer while an earlier generation still holds the session. Cross-process and durable admission stay host-owned.
 */
export interface CodexWriters { readonly held: () => number }
export interface CodexExecutionBounds {
  /** Open, opening and closed sessions on this execution until its transport ends (the thread stays loaded natively). */
  readonly maxSessions: number;
  /** Per-stream observer leases and capacity (core `createEventStream`). */
  readonly maxObservers: number;
  readonly eventCapacity: number;
  /** Turn-scoped notifications held while a `turn/start` reply (and so the turn id) is outstanding. */
  readonly maxEarlyNotifications: number;
  /** Deadline for one session's interrupt and unsubscribe. Expiry never releases a writer. */
  readonly cleanupTimeoutMs: number;
  /**
   * The only bound on a written `turn/start`: the caller's signal never cancels it after entry. Expiry is `uncertain`,
   * so core records `outcome-unknown`, the writer is retained and nothing is resent.
   */
  readonly acknowledgementTimeoutMs: number;
}
/**
 * The host owns the app-server process: executable, environment, native configuration, credentials and termination.
 * This module owns the transport it opens over the borrowed channel, the `initialize` handshake, routing, sessions and
 * writer reservations. It never spawns, kills, retries or answers a server request itself.
 */
export interface CodexExecutionOptions {
  readonly channel: BorrowedChannel;
  readonly transport: TransportBounds;
  readonly bounds: CodexExecutionBounds;
  /** Canonical absolute `$CODEX_HOME`; the native `initialize` reply's `codexHome` must equal it. */
  readonly home: string;
  /** Native `InitializeParams`, passed through unchanged. */
  readonly initialize: Readonly<Record<string, unknown>>;
  /** Every native server request (approvals and elicitations belong to 118i). Required: no adapter default policy. */
  readonly onServerRequest: TransportOptions['onRequest'];
  /** Startup only: abort during the handshake closes the owned transport. */
  readonly signal: AbortSignal;
  readonly writers?: CodexWriters;
  /**
   * Host attestation that the app-server process exited: the only release of this execution's reservations. Required:
   * after `close()` detaches the channel, a later channel `process-exit` can no longer be observed.
   */
  readonly processExit: PromiseLike<unknown>;
}
export type CodexOpenError = { readonly code: SessionOperationError['code'] | SessionReferenceError['code']
  | 'closed' | 'capacity' | 'outcome-unknown' | 'identity-mismatch' };
export type CodexEvidence = 'qualified' | 'unqualified';
/**
 * Per-method label carried on every decoded event. `qualified`: the pinned 0.169.0 binary emitted the method with this
 * meaning in a native run (probe.mjs; usage by execution proof X1 on linux/arm64 and x64). `unqualified`: decoded from
 * the generated bindings only; the adapter preserves it but promises no native meaning or completeness. Opaque `native`
 * events stay `unqualified` even when natively seen (`turn/started`), because the adapter decodes no meaning from them.
 */
export const codexNotificationEvidence = Object.freeze({
  'turn/completed': 'qualified',
  'item/agentMessage/delta': 'qualified',
  'thread/tokenUsage/updated': 'qualified',
} as const satisfies Record<string, CodexEvidence>);
const evidenceOf = (method: string): CodexEvidence => (Object.hasOwn(codexNotificationEvidence, method)
  ? codexNotificationEvidence[method as keyof typeof codexNotificationEvidence] : 'unqualified');
export interface CodexTokenUsage {
  readonly totalTokens: number; readonly inputTokens: number; readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number; readonly outputTokens: number; readonly reasoningOutputTokens: number;
}
export interface CodexTurnTerminal {
  readonly turnId: string;
  readonly status: 'completed' | 'interrupted' | 'failed';
  readonly error: unknown;
  readonly turn: unknown;
}
export type CodexTurnResult = ({ readonly kind: 'terminal' } & CodexTurnTerminal)
  | { readonly kind: 'rejected'; readonly error: RpcError };
export type CodexTurnCompletion =
  | { readonly kind: 'terminal'; readonly terminal: CodexTurnTerminal }
  | { readonly kind: 'rejected'; readonly error: RpcError }
  | { readonly kind: 'not-dispatched' }
  | { readonly kind: 'not-sent'; readonly reason: Extract<SendFailure, { kind: 'not-sent' }>['reason'] }
  | { readonly kind: 'unconcluded'; readonly accepted: boolean; readonly reason: EndReason };
export type CodexSessionEvent =
  | { readonly kind: 'turn-accepted'; readonly turnId: string; readonly evidence: 'qualified' }
  | { readonly kind: 'text-delta'; readonly turnId: string; readonly itemId: string; readonly delta: string;
    readonly evidence: CodexEvidence }
  /** Native `total` and `last` copied field by field; neither is per-request usage, and nothing is summed. */
  | { readonly kind: 'usage'; readonly turnId: string; readonly total: CodexTokenUsage; readonly last: CodexTokenUsage;
    readonly modelContextWindow: number | null; readonly evidence: CodexEvidence }
  | ({ readonly kind: 'turn-completed'; readonly evidence: CodexEvidence } & CodexTurnTerminal)
  /** `discarded` notifications went to the counted execution stream instead of this session. */
  | { readonly kind: 'early-overflow'; readonly turnId: string; readonly discarded: number }
  | CodexNativeEvent;
export type CodexNativeEvent = { readonly kind: 'native'; readonly method: string; readonly params: unknown;
  readonly evidence: 'unqualified' };
export type CodexExecutionEvent = CodexNativeEvent | { readonly kind: 'unmatched-reply' };
export interface CodexTurnOptions {
  readonly hostOperationId: string;
  /** Native `UserInput[]`, passed through. */
  readonly input: readonly unknown[];
  /** Other `TurnStartParams`, passed through; `threadId` and `input` are refused. */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly recordIntent: FreshDispatchOptions<CodexTurnResult>['recordIntent'];
  readonly lifecycle?: Pick<EventStream<DispatchLifecycle>, 'publish'>;
}
export interface CodexTurn extends DispatchHandle<CodexTurnResult> {
  /** Adapter evidence beside the dispatch snapshot; settles once. It never resends after uncertain entry. */
  readonly completion: Promise<CodexTurnCompletion>;
}
export type CleanupStep = 'not-needed' | 'replied' | 'rejected' | 'not-sent' | 'uncertain';
export interface CodexSessionCloseReport {
  readonly interrupt: CleanupStep;
  readonly unsubscribe: CleanupStep;
  /** False until host-attested process exit: neither the turn terminal nor `thread/unsubscribe` unloads the thread. */
  readonly released: boolean;
}
export interface CodexSession {
  readonly reference: SessionReference;
  readonly threadId: string;
  /** `created`: start-only until a first turn is accepted; such an ID is not durable across process exit. */
  readonly origin: 'created' | 'resumed';
  readonly native: unknown;
  readonly events: EventObserver<CodexSessionEvent>;
  readonly turn: (options: CodexTurnOptions) => Outcome<CodexTurn, { readonly code: 'busy' | 'closed' | 'invalid-input' }>;
  /** The session's event stream keeps delivering its thread's notifications until the transport ends. */
  readonly close: () => Promise<CodexSessionCloseReport>;
  /**
   * Cancel without close: at most one native `turn/interrupt` per turn, shared with `close`. Reports the request only;
   * termination is the turn's `completion`. `not-needed`: no active turn, it settled, or no native turn id within
   * `cleanupTimeoutMs`. Never closes the session, releases the writer or resends; unsubscribing is not cancellation.
   */
  readonly interrupt: () => Promise<CleanupStep>;
}
export type CodexResumeResult = { readonly kind: 'resumed'; readonly session: CodexSession }
  | Exclude<CodexResumePreparation, { readonly kind: 'ready' }>;
type Access = { readonly bounds: SessionDiscoveryBounds; readonly signal: AbortSignal;
  readonly params?: Readonly<Record<string, unknown>> };
export interface CodexExecution {
  /** pg51 scope over this connection, for `codexSessions` reads. Writer methods go only through this module. */
  readonly scope: CodexSessionScope;
  readonly events: EventObserver<CodexExecutionEvent>;
  readonly create: (options: Access) => Promise<Outcome<CodexSession, CodexOpenError>>;
  readonly resume: (options: Access & { readonly binding: SessionBinding; readonly reference: unknown })
    => Promise<Outcome<CodexResumeResult, CodexOpenError>>;
  readonly close: () => Promise<{ readonly transport: CloseReport; readonly retained: number }>;
  /** Saturating counts of notifications no session claimed and of unmatched replies; never dropped silently. */
  readonly counts: () => CodexExecutionCounts;
}
export interface CodexExecutionCounts {
  readonly unrouted: number;
  readonly unmatchedReplies: number;
  readonly earlyOverflow: number;
}

type Lease = { readonly key: string; readonly state: WriterState; released: boolean };
type WriterState = { readonly held: Map<string, Lease>; readonly max: number };
const registries = new WeakMap<CodexWriters, WriterState>();
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

export function createCodexWriters(maxReservations: number): CodexWriters {
  if (!positive(maxReservations)) throw new RangeError('Invalid writer bound');
  const state: WriterState = { held: new Map(), max: maxReservations };
  const writers = Object.freeze({ held: () => state.held.size });
  registries.set(writers, state);
  return writers;
}
const processWriters = createCodexWriters(1024);
/** Explicit field order: the key never depends on object key order or on unvalidated input. */
const writerKey = ({ kind, formatVersion, binding: b, opaque }: SessionReference) =>
  JSON.stringify([kind, formatVersion, b.engine, b.nativeVersion, b.account, b.authorizedScope, b.nativeFormat, opaque]);
function acquire(state: WriterState, reference: SessionReference): Lease | 'busy' | 'capacity' {
  const key = writerKey(reference);
  if (state.held.has(key)) return 'busy';
  if (state.held.size >= state.max) return 'capacity';
  const lease: Lease = { key, state, released: false };
  state.held.set(key, lease);
  return lease;
}
/** Compare-and-release: a late release from an earlier generation can never free a replacement's lease. */
function release(lease: Lease): void {
  if (lease.released) return;
  lease.released = true;
  if (lease.state.held.get(lease.key) === lease) lease.state.held.delete(lease.key);
}

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
type Early = { readonly method: string; readonly params: Record<string, unknown>; readonly turnId: string };
/**
 * `prepared`: no `turn/start` written. `pending`: written, reply outstanding; notifications naming an unknown turn are
 * buffered. `identified`: the reply named the native turn. `orphaned`: written without a usable acknowledgement; its
 * later notifications go to the execution stream, never a session.
 */
type TurnPhase = { readonly kind: 'prepared' } | { readonly kind: 'pending'; readonly early: Early[]; dropped: number }
  | { readonly kind: 'identified'; readonly id: string } | { readonly kind: 'orphaned' };
type Turn = {
  phase: TurnPhase;
  settled: boolean;
  readonly settle: (completion: CodexTurnCompletion) => void;
  readonly done: Promise<CodexTurnCompletion>;
  /** Settles when the native turn id is known or the turn settled without one. */
  readonly identified: Deferred<void>;
  interrupting: Promise<CleanupStep> | undefined;
};
type Session = {
  readonly threadId: string;
  readonly lease: Lease;
  readonly stream: EventStream<CodexSessionEvent>;
  readonly abort: AbortController;
  active: Turn | undefined;
  previous: Turn | undefined;
  state: 'open' | 'closing';
  closing: Promise<CodexSessionCloseReport> | undefined;
};
const turnStatuses = new Set(['completed', 'interrupted', 'failed']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= sessionLimits.identifierLength;
}
function usage(value: unknown): CodexTokenUsage | undefined {
  if (!record(value)) return undefined;
  const fields = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens',
    'reasoningOutputTokens'] as const satisfies readonly (keyof CodexTokenUsage)[];
  const copy: Partial<Record<keyof CodexTokenUsage, number>> = {};
  for (const field of fields) {
    const count = value[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
    copy[field] = count;
  }
  return Object.freeze(copy as CodexTokenUsage);
}
function passthrough(value: unknown, refused: readonly string[]): Record<string, unknown> | undefined {
  if (value === undefined) return {};
  if (!record(value) || refused.some((key) => Object.hasOwn(value, key))) return undefined;
  return { ...value };
}
function newTurn(): Turn {
  const { promise, resolve } = deferred<CodexTurnCompletion>();
  const turn: Turn = { phase: { kind: 'prepared' }, settled: false, done: promise, interrupting: undefined,
    identified: deferred<void>(), settle: (completion) => {
      if (turn.settled) return;
      turn.settled = true;
      turn.identified.resolve();
      resolve(Object.freeze(completion));
    } };
  return turn;
}
const invalid = { kind: 'error', error: Object.freeze({ code: 'invalid-input' }) } as const;
const fail = (code: CodexOpenError['code']) => ({ kind: 'error', error: Object.freeze({ code }) }) as const;

export async function openCodexExecution(options: CodexExecutionOptions):
Promise<Outcome<CodexExecution, { readonly code: 'invalid-input' | 'closed' | 'native-failure' }>> {
  let captured;
  try {
    const { channel, transport: transportBounds, bounds, home, initialize, onServerRequest, signal, processExit } = options;
    const state = registries.get(options.writers ?? processWriters);
    if (!state || !record(bounds) || !record(initialize) || typeof onServerRequest !== 'function'
      || !(signal instanceof AbortSignal) || typeof home !== 'string' || home.length === 0
      || typeof (processExit as { then?: unknown } | null)?.then !== 'function') return invalid;
    const { maxSessions, maxObservers, eventCapacity, maxEarlyNotifications, cleanupTimeoutMs, acknowledgementTimeoutMs } = bounds;
    if (![maxSessions, maxObservers, eventCapacity, maxEarlyNotifications].every((value) => positive(value))
      || ![cleanupTimeoutMs, acknowledgementTimeoutMs].every((value) => positive(value, 2147483647))
      || !positive(maxObservers * eventCapacity)) return invalid;
    captured = { channel, transportBounds, home, initialize: { ...initialize }, onServerRequest, signal, processExit, state,
      bounds: { maxSessions, maxObservers, eventCapacity, maxEarlyNotifications, cleanupTimeoutMs, acknowledgementTimeoutMs } };
  } catch { return invalid; }
  const { home, state: writers, bounds, signal } = captured;
  const streamBounds = { maxObservers: bounds.maxObservers, capacity: bounds.eventCapacity };
  const executionEvents = createEventStream<CodexExecutionEvent>(streamBounds);
  const sessions = new Set<Session>();
  const byThread = new Map<string, Session>();
  const opening = new AbortController();
  let pendingOpens = 0;
  let closed = false;
  let exited = false;
  /** Every reservation this execution took that may hold a natively loaded thread; released together on exit. */
  const leases = new Set<Lease>();
  let closing: ReturnType<CodexExecution['close']> | undefined;
  const counts = { unrouted: 0, unmatchedReplies: 0, earlyOverflow: 0 };
  const count = (name: keyof typeof counts, by = 1) => { counts[name] = Math.min(counts[name] + by, Number.MAX_SAFE_INTEGER); };

  const publishNative = (method: string, params: unknown) => {
    count('unrouted');
    executionEvents.publish(Object.freeze({ kind: 'native', method, params, evidence: 'unqualified' }));
  };
  /** The transport observer: synchronous, never awaits a consumer, so backpressure can never close the transport. */
  function observe(observation: Observation): void {
    if (observation.kind !== 'notification') {
      count('unmatchedReplies');
      executionEvents.publish(Object.freeze({ kind: 'unmatched-reply' }));
      return;
    }
    const { method, params } = observation;
    const owner = record(params) ? params : undefined;
    const thread = owner && record(owner.thread) ? owner.thread.id : owner?.threadId;
    const session = typeof thread === 'string' ? byThread.get(thread) : undefined;
    if (!owner || !session) { publishNative(method, params); return; }
    const turnId = record(owner.turn) ? owner.turn.id : owner.turnId;
    if (typeof turnId !== 'string') { session.stream.publish(Object.freeze({ kind: 'native', method, params, evidence: 'unqualified' })); return; }
    const turn = [session.active, session.previous]
      .find((candidate) => candidate?.phase.kind === 'identified' && candidate.phase.id === turnId);
    if (turn) { deliver(session, turn, turnId, method, owner); return; }
    const active = session.active;
    const pending = active && !active.settled && active.phase.kind === 'pending' ? active.phase : undefined;
    // One slot beyond the bound is reserved for a terminal, so overflow can never strand the pending turn.
    const room = bounds.maxEarlyNotifications + (method === 'turn/completed' ? 1 : 0);
    if (pending && pending.early.length < room) pending.early.push({ method, params: owner, turnId });
    else {
      if (pending) pending.dropped++;
      publishNative(method, params);
    }
  }
  function deliver(session: Session, turn: Turn, turnId: string, method: string, params: Record<string, unknown>): void {
    if (method === 'turn/completed' && !turn.settled && record(params.turn) && turnStatuses.has(params.turn.status as string)) {
      const terminal: CodexTurnTerminal = Object.freeze({ turnId, status: params.turn.status as CodexTurnTerminal['status'],
        error: params.turn.error ?? null, turn: params.turn });
      session.stream.publish(Object.freeze({ kind: 'turn-completed', evidence: evidenceOf(method), ...terminal }));
      conclude(session, turn, { kind: 'terminal', terminal });
      return;
    }
    if (method === 'item/agentMessage/delta' && text(params.itemId) && typeof params.delta === 'string') {
      session.stream.publish(Object.freeze({ kind: 'text-delta', turnId, itemId: params.itemId, delta: params.delta,
        evidence: evidenceOf(method) }));
      return;
    }
    if (method === 'thread/tokenUsage/updated' && record(params.tokenUsage)) {
      const { total, last, modelContextWindow: window } = params.tokenUsage;
      const totalUsage = usage(total);
      const lastUsage = usage(last);
      const modelContextWindow = window === null ? null : positive(window) ? window : undefined;
      if (totalUsage && lastUsage && modelContextWindow !== undefined) {
        session.stream.publish(Object.freeze({ kind: 'usage', turnId, total: totalUsage, last: lastUsage, modelContextWindow,
          evidence: evidenceOf(method) }));
        return;
      }
    }
    session.stream.publish(Object.freeze({ kind: 'native', method, params, evidence: 'unqualified' }));
  }
  const stopAdmission = () => { closed = true; opening.abort(); };
  /** A turn leaving `pending` without a native id: whatever it buffered is unrouted, never dropped silently. */
  function drain(turn: Turn): void {
    if (turn.phase.kind === 'pending') for (const early of turn.phase.early.splice(0)) publishNative(early.method, early.params);
  }
  function conclude(session: Session, turn: Turn, completion: CodexTurnCompletion): void {
    drain(turn);
    turn.settle(completion);
    if (session.active === turn) {
      session.active = undefined;
      if (turn.phase.kind === 'identified') session.previous = turn;
    }
  }
  /**
   * The only release path: host-attested exit of this app-server (`processExit` or a channel `process-exit`). A turn
   * terminal ends the turn, not the writer: the app-server keeps the thread loaded through `thread/unsubscribe`, and a
   * resume on another app-server fails natively while it lives (execution proof X4, X5). Deadlines and rejections never
   * release either.
   */
  function exit(): void {
    exited = true;
    stopAdmission();
    for (const lease of leases) release(lease);
    leases.clear();
  }
  const keep = (lease: Lease) => { if (exited) release(lease); else leases.add(lease); };

  const transport: CodexTransport = openCodexTransport({ channel: captured.channel, bounds: captured.transportBounds,
    onRequest: captured.onServerRequest, onObservation: observe });
  void transport.ended.then((report) => {
    stopAdmission();
    for (const session of sessions) {
      session.state = 'closing';
      session.abort.abort();
      const turn = session.active;
      if (turn && turn.phase.kind !== 'prepared' && !turn.settled) {
        drain(turn);
        turn.settle({ kind: 'unconcluded', accepted: turn.phase.kind === 'identified', reason: report.reason });
      }
      session.stream.close();
    }
    sessions.clear();
    byThread.clear();
    // A host channel signals `process-exit` only after the process exited (boundaries: Private Codex transport).
    if (report.reason === 'process-exit') exit();
    executionEvents.close();
  });
  void Promise.resolve(captured.processExit).then(exit, () => {});

  async function request(method: string, params: unknown, wait: AbortSignal): Promise<
    { readonly kind: 'result'; readonly value: unknown } | { readonly kind: 'error'; readonly error: RpcError } | SendFailure> {
    const exchange = await transport.request({ method, params }, wait);
    return exchange.kind === 'reply' ? exchange.envelope.reply : exchange;
  }
  const step = (reply: Awaited<ReturnType<typeof request>>): CleanupStep =>
    reply.kind === 'result' ? 'replied' : reply.kind === 'error' ? 'rejected' : reply.kind;

  // Handshake: the transport is ours, so the native `initialize` exchange is too.
  const abortStartup = addAbortListener(signal, () => { void transport.close(); });
  try {
    const reply = await request('initialize', captured.initialize, signal);
    if (reply.kind !== 'result') {
      await transport.close();
      return { kind: 'error', error: Object.freeze({ code: reply.kind === 'error' ? 'native-failure' : 'closed' }) };
    }
    if (!record(reply.value) || reply.value.codexHome !== home) {
      await transport.close();
      return { kind: 'error', error: Object.freeze({ code: 'native-failure' }) };
    }
    if ((await transport.notify({ method: 'initialized' }, signal)).kind !== 'written') {
      await transport.close();
      return { kind: 'error', error: Object.freeze({ code: 'closed' }) };
    }
  } finally { abortStartup[Symbol.dispose](); }
  const scope: CodexSessionScope = Object.freeze({ home, request: transport.request, initialize: Object.freeze({ codexHome: home }) });

  function admit(signalled: AbortSignal): CodexOpenError['code'] | undefined {
    if (closed) return 'closed';
    if (signalled.aborted) return 'cancelled';
    return sessions.size + pendingOpens >= bounds.maxSessions ? 'capacity' : undefined;
  }
  function attach(threadId: string, reference: SessionReference, lease: Lease, origin: CodexSession['origin'],
    native: unknown): CodexSession {
    const session: Session = { threadId, lease, stream: createEventStream(streamBounds), abort: new AbortController(),
      active: undefined, previous: undefined, state: 'open', closing: undefined };
    keep(lease);
    sessions.add(session);
    byThread.set(threadId, session);
    return Object.freeze({ reference, threadId, origin, native, events: Object.freeze({ subscribe: session.stream.subscribe }),
      turn: (turnOptions: CodexTurnOptions) => startTurn(session, reference, turnOptions),
      close: () => (session.closing ??= shutdown(session)),
      interrupt: async () => {
        const turn = session.active;
        return turn ? interrupt(session, turn, AbortSignal.timeout(bounds.cleanupTimeoutMs)) : 'not-needed';
      } });
  }
  async function create(access: Access): Promise<Outcome<CodexSession, CodexOpenError>> {
    let params;
    let wait;
    try {
      params = passthrough(access.params, ['ephemeral']);
      if (!params || !(access.signal instanceof AbortSignal)) return invalid;
      wait = AbortSignal.any([access.signal, opening.signal]);
    } catch { return invalid; }
    const refused = admit(wait);
    if (refused) return fail(refused);
    pendingOpens++;
    try {
      // The pg51 gate: private index precondition and the live native requester become the binding.
      const bound = await codexSessions.bind({ scope, bounds: access.bounds, signal: wait, nativeFormat: 'codex-thread/paginated' });
      if (bound.kind === 'error') return closed ? fail('closed') : bound;
      const reply = await request('thread/start', params, wait);
      if (reply.kind === 'not-sent') return fail(closed ? 'closed' : 'cancelled');
      if (reply.kind === 'uncertain') return fail('outcome-unknown');
      const thread = reply.kind === 'result' && record(reply.value) && record(reply.value.thread) ? reply.value.thread : undefined;
      if (!thread || !text(thread.id) || !uuid.test(thread.id) || thread.historyMode !== 'paginated' || thread.ephemeral !== false) {
        return fail('native-failure');
      }
      const reference: SessionReference = Object.freeze({ kind: 'session', formatVersion: 1, binding: bound.value, opaque: thread.id });
      const lease = acquire(writers, reference);
      if (typeof lease === 'string') return fail(lease === 'busy' ? 'native-failure' : 'capacity');
      // Close-during-open: a reply after close started never yields a session. Start-only IDs hold no writer.
      if (closed) { release(lease); return fail('closed'); }
      return { kind: 'ok', value: attach(thread.id, reference, lease, 'created', reply.kind === 'result' ? reply.value : null) };
    } finally { pendingOpens--; }
  }

  async function resume(access: Access & { readonly binding: SessionBinding; readonly reference: unknown }):
  Promise<Outcome<CodexResumeResult, CodexOpenError>> {
    let parsed;
    let params;
    let wait;
    try {
      const binding = copyBinding(access.binding);
      params = passthrough(access.params, ['threadId', 'history', 'path']);
      if (!binding || !params || !(access.signal instanceof AbortSignal)) return invalid;
      parsed = parseSessionReference({ value: access.reference, expected: binding });
      wait = AbortSignal.any([access.signal, opening.signal]);
    } catch { return invalid; }
    if (parsed.kind === 'error') return parsed;
    const reference = parsed.value;
    const refused = admit(wait);
    if (refused) return fail(refused);
    // Reserve first, keyed by the complete validated reference: preparation and resume run under the lease.
    const lease = acquire(writers, reference);
    if (lease === 'busy') return { kind: 'ok', value: Object.freeze({ kind: 'busy' }) };
    if (lease === 'capacity') return fail('capacity');
    pendingOpens++;
    let held = false;
    try {
      const prepared = await codexSessions.prepareResume({ scope, binding: reference.binding, bounds: access.bounds,
        signal: wait, reference });
      if (prepared.kind === 'error') return closed ? fail('closed') : prepared;
      if (prepared.value.kind !== 'ready') return { kind: 'ok', value: prepared.value };
      const { threadId } = prepared.value;
      const reply = await request('thread/resume', { ...params, threadId }, wait);
      if (reply.kind === 'not-sent') return fail(closed ? 'closed' : 'cancelled');
      if (reply.kind === 'error') return fail('native-failure');
      // Unrejected entry: this app-server may now hold the thread loaded, so the reservation follows its exit.
      held = true;
      const thread = reply.kind === 'result' && record(reply.value) && record(reply.value.thread) ? reply.value.thread : undefined;
      const refused = reply.kind === 'uncertain' ? (closed ? 'closed' : 'outcome-unknown')
        : thread?.id !== threadId ? 'identity-mismatch' : closed ? 'closed' : undefined;
      if (refused) { keep(lease); return fail(refused); }
      return { kind: 'ok', value: Object.freeze({ kind: 'resumed', session: attach(threadId, reference, lease, 'resumed',
        reply.kind === 'result' ? reply.value : null) }) };
    } finally {
      pendingOpens--;
      if (!held) release(lease);
    }
  }

  function startTurn(session: Session, reference: SessionReference, options: CodexTurnOptions): ReturnType<CodexSession['turn']> {
    if (session.state !== 'open' || closed) return { kind: 'error', error: Object.freeze({ code: 'closed' }) };
    if (session.active) return { kind: 'error', error: Object.freeze({ code: 'busy' }) };
    let handle: DispatchHandle<CodexTurnResult>;
    const turn = newTurn();
    try {
      const { hostOperationId, input, params: extra, signal: hostSignal, recordIntent, lifecycle } = options;
      const params = passthrough(extra, ['threadId', 'input']);
      if (!Array.isArray(input) || !params || !(hostSignal instanceof AbortSignal)) return invalid;
      const identity = { hostOperationId, target: { kind: 'session', reference } } as const;
      handle = createDispatchOperation<CodexTurnResult>({ mode: 'fresh', identity, recordIntent,
        signal: AbortSignal.any([hostSignal, session.abort.signal]), ...(lifecycle ? { events: lifecycle } : {}),
        // Host or session abort prevents entry (core checks it just before this call). Once entered, only the
        // acknowledgement deadline bounds the wait: the caller's signal never turns a written turn/start uncertain.
        dispatchNative: (canonical) => dispatch(session, turn, canonical,
          { ...params, threadId: session.threadId, input: [...input] }) });
    } catch { return invalid; }
    session.active = turn;
    void handle.run().then((snapshot) => {
      if (snapshot.observation.kind === 'not-dispatched') conclude(session, turn, { kind: 'not-dispatched' });
    });
    return { kind: 'ok', value: Object.freeze({ run: handle.run, reconcile: handle.reconcile, completion: turn.done }) };
  }
  /** One native `turn/start`, never resent. `not-sent` is adapter evidence; core still records `outcome-unknown`. */
  async function dispatch(session: Session, turn: Turn, identity: DispatchIdentity,
    params: Record<string, unknown>): Promise<NativeDispatchObservation<CodexTurnResult>> {
    const pending: Extract<TurnPhase, { kind: 'pending' }> = { kind: 'pending', early: [], dropped: 0 };
    turn.phase = pending;
    const reply = await request('turn/start', params, AbortSignal.timeout(bounds.acknowledgementTimeoutMs));
    if (reply.kind === 'not-sent') {
      conclude(session, turn, { kind: 'not-sent', reason: reply.reason });
      return { kind: 'outcome-unknown' };
    }
    if (reply.kind === 'uncertain') return orphan(turn);
    const evidence = (nativeOperation: NativeOperationReference | null, data: unknown): DispatchEvidence =>
      ({ identity, source: 'native-acknowledgement', nativeOperation,
        observation: { namespace: 'codex-app-server/turn-start', schemaVersion: 1, data } });
    if (reply.kind === 'error') {
      const result = { kind: 'rejected', error: reply.error } as const;
      conclude(session, turn, result);
      return { kind: 'conclusive', evidence: evidence(null, reply.error), result };
    }
    const turnId = record(reply.value) && record(reply.value.turn) ? reply.value.turn.id : undefined;
    if (!text(turnId)) return orphan(turn);
    turn.identified.resolve();
    turn.phase = { kind: 'identified', id: turnId };
    session.stream.publish(Object.freeze({ kind: 'turn-accepted', turnId, evidence: 'qualified' }));
    if (pending.dropped > 0) {
      count('earlyOverflow', pending.dropped);
      session.stream.publish(Object.freeze({ kind: 'early-overflow', turnId, discarded: pending.dropped }));
    }
    for (const early of pending.early.splice(0)) {
      if (early.turnId === turnId) deliver(session, turn, turnId, early.method, early.params);
      else publishNative(early.method, early.params);
    }
    const nativeOperation = { namespace: 'codex-turn', id: turnId };
    const settled = turn.settled ? await turn.done : undefined;
    return settled?.kind === 'terminal'
      ? { kind: 'conclusive', evidence: evidence(nativeOperation, reply.value), result: { kind: 'terminal', ...settled.terminal } }
      : { kind: 'accepted', evidence: evidence(nativeOperation, reply.value) };
  }

  /** Entered without a usable acknowledgement: the writer stays held and buffered notifications become unrouted. */
  function orphan(turn: Turn): NativeDispatchObservation<CodexTurnResult> {
    drain(turn);
    turn.phase = { kind: 'orphaned' };
    turn.identified.resolve();
    return { kind: 'outcome-unknown' };
  }

  const until = (promise: Promise<unknown>, deadline: AbortSignal) => new Promise<void>((resolve) => {
    if (deadline.aborted) { resolve(); return; }
    const listener = addAbortListener(deadline, () => resolve());
    void promise.then(() => { listener[Symbol.dispose](); resolve(); });
  });
  /** `turn/interrupt` then its `turn/completed{interrupted}` is the qualified native terminal (probe.mjs cancel). */
  function interrupt(session: Session, turn: Turn, deadline: AbortSignal): Promise<CleanupStep> {
    return (turn.interrupting ??= until(turn.identified.promise, deadline).then(async () => {
      const { phase } = turn;
      if (phase.kind !== 'identified' || turn.settled) return 'not-needed';
      return step(await request('turn/interrupt', { threadId: session.threadId, turnId: phase.id }, deadline));
    }));
  }
  async function shutdown(session: Session): Promise<CodexSessionCloseReport> {
    if (session.state === 'open') session.state = 'closing';
    session.abort.abort();
    const deadline = AbortSignal.timeout(bounds.cleanupTimeoutMs);
    let interrupted: CleanupStep = 'not-needed';
    const turn = session.active;
    if (turn) {
      interrupted = await interrupt(session, turn, deadline);
      // An orphaned turn settles only when the transport ends; waiting would only spend the cleanup deadline.
      if (turn.phase.kind !== 'orphaned') await until(turn.done, deadline);
    }
    // Stops this session's subscription only: natively the thread stays loaded until process exit (X5).
    const unsubscribe = step(await request('thread/unsubscribe', { threadId: session.threadId }, deadline));
    return Object.freeze({ interrupt: interrupted, unsubscribe, released: session.lease.released });
  }

  async function closeAll(): ReturnType<CodexExecution['close']> {
    stopAdmission();
    await Promise.all([...sessions].map((session) => (session.closing ??= shutdown(session))));
    const report = await transport.close();
    executionEvents.close();
    return Object.freeze({ transport: report, retained: leases.size });
  }
  return { kind: 'ok', value: Object.freeze({ scope, events: Object.freeze({ subscribe: executionEvents.subscribe }),
    create, resume, close: () => (closing ??= closeAll()), counts: () => Object.freeze({ ...counts }) }) };
}
