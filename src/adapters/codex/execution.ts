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
import { resolveCodexFeatures } from './features.js';
import type { CodexStartFeatures, CodexThreadFeatures, CodexTurnFeatures } from './features.js';
import { admitCodexRoute } from './route.js';
import type { CodexHostRoute, CodexProxyRoute } from './route.js';
import { bindCodexRequester, codexSessions } from './sessions.js';
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
  /**
   * The route this app-server runs under, copied once at open: `litellm-proxy` or `host-route`. Absent is direct mode.
   * Sessions bind to the host-asserted route principal instead of a native login (sessions.ts). Invalid: `invalid-input`
   * with a `message` naming the failing rule. A host runs one mode per Codex home: the writer registry keys by the
   * complete reference, so a routed and a direct execution over one home would not exclude each other's writers.
   * A `litellm-proxy` thread on another model than `route.model` is `native-failure`; resume it with
   * `params.model = route.model`. A host route does not take that failure. Its outbound refusal is `modelProvider`
   * and `config` (`refuseHostRedirect`). Both kinds refuse a reply whose sandbox is outside read-only or
   * workspace-write without network, or whose approval policy is not never (`unconfined`). A host route does not
   * rewrite those fields on the way out and does not pin them in `codexHostRouteConfig`.
   */
  readonly route?: CodexProxyRoute | CodexHostRoute;
}
/**
 * `message` is present only on a typed-feature, proxy-route override or invalid-route `invalid-input` (features.ts,
 * routeOverride, admitCodexRoute), naming the rejected setting or rule; on a `litellm-proxy` off-model `native-failure`;
 * and on an `unconfined` `native-failure` for either route kind. A host route has no off-model failure.
 */
export type CodexOpenError = { readonly code: SessionOperationError['code'] | SessionReferenceError['code']
  | 'closed' | 'capacity' | 'outcome-unknown' | 'identity-mismatch'; readonly message?: string };
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
  readonly maxFrameBytes?: number;
  readonly hostOperationId: string;
  /** Native `UserInput[]`, passed through. */
  readonly input: readonly unknown[];
  /** Other `TurnStartParams`, passed through; `threadId` and `input` are refused. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Typed `turn/start` overrides merged into `params` (features.ts); a conflict is `invalid-input` and nothing is sent. */
  readonly features?: CodexTurnFeatures;
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
export interface CodexInterruptResult {
  readonly step: CleanupStep;
  readonly turnId: string | null;
  readonly rejection: { readonly code: number; readonly message: string } | null;
}
export interface CodexSession {
  readonly reference: SessionReference;
  readonly threadId: string;
  /** `created`: start-only until a first turn is accepted; such an ID is not durable across process exit. */
  readonly origin: 'created' | 'resumed';
  readonly native: unknown;
  readonly events: EventObserver<CodexSessionEvent>;
  readonly turn: (options: CodexTurnOptions) => Outcome<CodexTurn, { readonly code: 'busy' | 'closed' | 'invalid-input'; readonly message?: string }>;
  /** The session's event stream keeps delivering its thread's notifications until the transport ends. */
  readonly close: () => Promise<CodexSessionCloseReport>;
  /**
   * Cancel without close: at most one native `turn/interrupt` per turn, shared with `close`. Reports the request only;
   * termination is the turn's `completion`. `not-needed`: no active turn, it settled, or no native turn id within
   * `cleanupTimeoutMs`. Never closes the session, releases the writer or resends; unsubscribing is not cancellation.
   */
  readonly interrupt: () => Promise<CodexInterruptResult>;
}
export type CodexResumeResult = { readonly kind: 'resumed'; readonly session: CodexSession }
  | Exclude<CodexResumePreparation, { readonly kind: 'ready' }>;
/** `features` are typed native settings merged into `params` (features.ts); a conflict is `invalid-input`, unsent. */
type Access<Features = CodexThreadFeatures> = { readonly bounds: SessionDiscoveryBounds; readonly signal: AbortSignal;
  readonly params?: Readonly<Record<string, unknown>>; readonly features?: Features;
  /** Placed as native `developerInstructions` on thread/start and thread/resume. */
  readonly instructions?: string };
export interface CodexExecution {
  /** pg51 scope over this connection, for `codexSessions` reads. Writer methods go only through this module. */
  readonly scope: CodexSessionScope;
  readonly events: EventObserver<CodexExecutionEvent>;
  readonly create: (options: Access<CodexStartFeatures>) => Promise<Outcome<CodexSession, CodexOpenError>>;
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
  interrupting: Promise<CodexInterruptResult> | undefined;
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
const redirectKey = (params: Record<string, unknown>) =>
  ['modelProvider', 'config'].find((name) => Object.hasOwn(params, name));
/**
 * LiteLLM proxy only. A per-thread `modelProvider` or any `config` override redirects traffic off the proxy while the
 * binding still names it (codex-native-api.md, Proxy-routed requester), so either key is refused unsent. A host route
 * does not enter this function. `refuseHostRedirect` refuses only `modelProvider` and `config` for that route. This
 * function also fixes the model: `model` (thread/start, thread/resume, turn/start) unless it strictly equals `route.model`,
 * `collaborationMode` (turn/start; it takes precedence over `model`) unless its `settings.model` does, and
 * `allowProviderModelFallback` (thread/start) unless `false` are refused. TurnStartParams 0.169.0 has no provider or
 * config field; ThreadStartParams and ThreadResumeParams have no `collaborationMode`, which is refused there anyway.
 * A networked shell is always refused (features.ts `networked-shell-under-route`): `sandbox` `danger-full-access`, any
 * `permissions` profile, and a `sandboxPolicy` other than `readOnly` or `workspaceWrite` without `networkAccess` (snapshot).
 * Approvals are always off (features.ts `approvals-under-route`): an `approvalPolicy` other than `"never"`, granular and
 * `null` included, is refused, since an approved escalated command runs outside the sandbox. An absent one is sent as
 * `"never"`: natively a resumed thread keeps its persisted policy over the `codexProxyConfig` pin. `approvalsReviewer`
 * passes: under `never` native rejects an escalation before any reviewer or host is asked.
 * A thread/resume with neither `sandbox` nor `sandboxPolicy` is sent `sandbox: "read-only"`: natively a resumed thread
 * keeps a persisted unsandboxed profile (an out-of-band `danger-full-access` resume) over the `codexProxyConfig` pin.
 */
const routeOverride = (route: CodexProxyRoute | undefined, target: string, params: Record<string, unknown>) => {
  if (!route) return undefined;
  const refuse = (key: string, why: string) => ({ kind: 'error', error: Object.freeze({ code: 'invalid-input',
    message: `${target} ${key} is refused under a proxy route: ${why}` }) }) as const;
  const key = redirectKey(params);
  if (key) return refuse(key, 'a per-thread provider or config override can redirect traffic off the route');
  if (Object.hasOwn(params, 'model') && params.model !== route.model) return refuse('model', 'it differs from the route model');
  if (Object.hasOwn(params, 'allowProviderModelFallback') && params.allowProviderModelFallback !== false) {
    return refuse('allowProviderModelFallback', 'it can replace the route model');
  }
  const shell = 'a networked shell can take route tokens from the broker and use them on any model';
  if (params.sandbox === 'danger-full-access') return refuse('sandbox', shell);
  if (params.permissions != null) return refuse('permissions', shell);
  if (Object.hasOwn(params, 'approvalPolicy') && params.approvalPolicy !== 'never') {
    return refuse('approvalPolicy', 'an approved escalated command runs outside the sandbox and can take route tokens');
  }
  params.approvalPolicy = 'never';
  if (target === 'thread/resume' && params.sandbox == null && params.sandboxPolicy == null) params.sandbox = 'read-only';
  if (params.sandboxPolicy != null) {
    const policy = record(params.sandboxPolicy) ? { ...params.sandboxPolicy } : {};
    if (!['readOnly', 'workspaceWrite'].includes(policy.type as string) || (policy.networkAccess ?? false) !== false) {
      return refuse('sandboxPolicy', shell);
    }
    params.sandboxPolicy = policy;
  }
  if (!Object.hasOwn(params, 'collaborationMode')) return undefined;
  // Checked on a snapshot that replaces the host's object, so a later host mutation cannot change the sent model.
  const raw = params.collaborationMode;
  const mode = record(raw) && record(raw.settings) ? { ...raw, settings: { ...raw.settings } } : undefined;
  if (target !== 'turn/start' || !mode || mode.settings.model !== route.model) {
    return refuse('collaborationMode', 'its settings.model is not the route model');
  }
  params.collaborationMode = mode;
  return undefined;
};
/** A host route refuses the two keys that can send its credential to another endpoint. Model, sandbox and approvals stay the host's. */
const refuseHostRedirect = (_route: CodexHostRoute, target: string, params: Record<string, unknown>) => {
  const key = redirectKey(params);
  if (!key) return undefined;
  return { kind: 'error', error: Object.freeze({ code: 'invalid-input',
    message: `${target} ${key} is refused under a host route: a per-thread provider or config override can redirect traffic off the admitted provider` }) } as const;
};
/** Host `instructions` become native `developerInstructions`. An empty string leaves the native default. */
function placeInstructions(target: string, params: Record<string, unknown>, instructions: unknown) {
  if (instructions === undefined) return undefined;
  if (typeof instructions !== 'string') return fail('invalid-input', `${target} instructions must be a string`);
  if (params.developerInstructions != null && params.developerInstructions !== instructions) {
    return fail('invalid-input', `${target} developerInstructions conflicts with instructions`);
  }
  if (instructions.length > 0) params.developerInstructions = instructions;
  return undefined;
}
const fail = (code: CodexOpenError['code'], message?: string) =>
  ({ kind: 'error', error: Object.freeze(message === undefined ? { code } : { code, message }) }) as const;

export async function openCodexExecution(options: CodexExecutionOptions):
Promise<Outcome<CodexExecution, { readonly code: 'invalid-input' | 'closed' | 'native-failure'; readonly message?: string }>> {
  let captured;
  try {
    const { channel, transport: transportBounds, bounds, home, initialize, onServerRequest, signal, processExit, route: rawRoute } = options;
    const state = registries.get(options.writers ?? processWriters);
    let route: CodexProxyRoute | CodexHostRoute | undefined;
    if (rawRoute !== undefined) {
      const checked = admitCodexRoute(rawRoute);
      if ('problem' in checked) return { kind: 'error', error: Object.freeze({ code: 'invalid-input', message: checked.problem }) };
      route = checked.route;
    }
    if (!state || !record(bounds) || !record(initialize) || typeof onServerRequest !== 'function'
      || !(signal instanceof AbortSignal) || typeof home !== 'string' || home.length === 0
      || typeof (processExit as { then?: unknown } | null)?.then !== 'function') return invalid;
    const { maxSessions, maxObservers, eventCapacity, maxEarlyNotifications, cleanupTimeoutMs, acknowledgementTimeoutMs } = bounds;
    if (![maxSessions, maxObservers, eventCapacity, maxEarlyNotifications].every((value) => positive(value))
      || ![cleanupTimeoutMs, acknowledgementTimeoutMs].every((value) => positive(value, 2147483647))
      || !positive(maxObservers * eventCapacity)) return invalid;
    // Read once: a later host mutation of `initialize.capabilities` cannot change the features gate (features.ts).
    const experimentalApi = record(initialize.capabilities) && initialize.capabilities.experimentalApi === true;
    captured = { channel, transportBounds, home, initialize: { ...initialize }, experimentalApi, onServerRequest, signal, processExit, state, route,
      bounds: { maxSessions, maxObservers, eventCapacity, maxEarlyNotifications, cleanupTimeoutMs, acknowledgementTimeoutMs } };
  } catch { return invalid; }
  const { home, state: writers, bounds, signal, experimentalApi, route } = captured;
  /** LiteLLM pins apply only to that route. A host route keeps the host's sandbox, model and approvals. */
  const proxy = route?.kind === 'litellm-proxy' ? route : undefined;
  /**
   * LiteLLM proxy only. A start or resume reply whose `model` is not `proxy.model` is never a session: natively
   * (0.169.0) a resumed thread keeps its persisted model over the app-server's configured one unless `model` is passed.
   * A host route does not take this failure.
   */
  const offModel = (value: unknown) => proxy !== undefined && (!record(value) || value.model !== proxy.model);
  /**
   * Reply confinement for both route kinds. A host route still does not rewrite model, sandbox, or approvals
   * on the way out; `refuseHostRedirect` only blocks `modelProvider` and `config`. A start or resume reply whose
   * `sandbox` is outside `readOnly` or `workspaceWrite` without network, or whose `approvalPolicy` is not `"never"`,
   * is never a session.
   */
  function constrainRoute(target: string, params: Record<string, unknown>) {
    if (route === undefined) return undefined;
    switch (route.kind) {
      case 'host-route':
        return refuseHostRedirect(route, target, params);
      case 'litellm-proxy':
        return routeOverride(route, target, params);
      default: {
        const leftover: never = route;
        return leftover;
      }
    }
  }
  const unconfined = (value: unknown, verb: string) => {
    if (route === undefined) return undefined;
    const sandbox = record(value) && record(value.sandbox) ? value.sandbox : undefined;
    if (!sandbox || !['readOnly', 'workspaceWrite'].includes(sandbox.type as string) || (sandbox.networkAccess ?? false) !== false) {
      return `the thread ${verb} outside the route sandbox (read-only or workspace-write without network)`;
    }
    return record(value) && value.approvalPolicy === 'never' ? undefined : `the thread ${verb} with approvals on`;
  };
  // Natively a resumed thread keeps its persisted model unless thread/resume names one.
  const resumeOffModel = 'the thread is on another model than the route; resume it with params.model = route.model';
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

  async function request(method: string, params: unknown, wait: AbortSignal, maxFrameBytes?: number): Promise<
    { readonly kind: 'result'; readonly value: unknown } | { readonly kind: 'error'; readonly error: RpcError } | SendFailure> {
    const exchange = await transport.request({ method, params }, wait, maxFrameBytes === undefined ? undefined : { maxFrameBytes });
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
  const scope: CodexSessionScope = Object.freeze({ home, request: transport.request, initialize: Object.freeze({ codexHome: home }),
    ...(route ? { route } : {}) });

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
        return turn ? interrupt(session, turn, AbortSignal.timeout(bounds.cleanupTimeoutMs)) : { step: 'not-needed' as const, turnId: null, rejection: null };
      } });
  }
  async function create(access: Access<CodexStartFeatures>): Promise<Outcome<CodexSession, CodexOpenError>> {
    let params;
    let wait;
    try {
      params = passthrough(access.params, ['ephemeral']);
      if (!params || !(access.signal instanceof AbortSignal)) return invalid;
      const resolved = resolveCodexFeatures('thread/start', access.features, params, experimentalApi);
      if (resolved.kind === 'error') return resolved;
      params = resolved.value;
      const placed = placeInstructions('thread/start', params, access.instructions);
      if (placed) return placed;
      const blocked = constrainRoute('thread/start', params);
      if (blocked) return blocked;
      wait = AbortSignal.any([access.signal, opening.signal]);
    } catch { return invalid; }
    const refused = admit(wait);
    if (refused) return fail(refused);
    pendingOpens++;
    try {
      // The pg51 gate: private index precondition and the live native requester become the binding.
      const bound = await bindCodexRequester({ scope, bounds: access.bounds, signal: wait, nativeFormat: 'codex-thread/paginated' });
      if (bound.kind === 'error') return closed ? fail('closed') : bound;
      const reply = await request('thread/start', params, wait);
      if (reply.kind === 'not-sent') return fail(closed ? 'closed' : 'cancelled');
      if (reply.kind === 'uncertain') return fail('outcome-unknown');
      const thread = reply.kind === 'result' && record(reply.value) && record(reply.value.thread) ? reply.value.thread : undefined;
      // A thread on another provider than the bound requester's (routed or direct) runs off it: never a session.
      if (!thread || !text(thread.id) || !uuid.test(thread.id) || thread.historyMode !== 'paginated' || thread.ephemeral !== false
        || thread.modelProvider !== bound.value.provider) {
        return fail('native-failure');
      }
      if (offModel(reply.kind === 'result' ? reply.value : undefined)) {
        return fail('native-failure', 'the thread started on another model than the route model');
      }
      const escaped = unconfined(reply.kind === 'result' ? reply.value : undefined, 'started');
      if (escaped) return fail('native-failure', escaped);
      const reference: SessionReference = Object.freeze({ kind: 'session', formatVersion: 1, binding: bound.value.binding,
        opaque: thread.id });
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
      const resolved = resolveCodexFeatures('thread/resume', access.features, params, experimentalApi);
      if (resolved.kind === 'error') return resolved;
      params = resolved.value;
      const placed = placeInstructions('thread/resume', params, access.instructions);
      if (placed) return placed;
      const blocked = constrainRoute('thread/resume', params);
      if (blocked) return blocked;
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
      const { threadId, provider } = prepared.value;
      const reply = await request('thread/resume', { ...params, threadId }, wait);
      if (reply.kind === 'not-sent') return fail(closed ? 'closed' : 'cancelled');
      if (reply.kind === 'error') return fail('native-failure');
      // Unrejected entry: this app-server may now hold the thread loaded, so the reservation follows its exit.
      held = true;
      const value = reply.kind === 'result' ? reply.value : undefined;
      const thread = record(value) && record(value.thread) ? value.thread : undefined;
      const escaped = unconfined(value, 'resumed');
      const refused = reply.kind === 'uncertain' ? (closed ? 'closed' : 'outcome-unknown')
        : thread?.id !== threadId ? 'identity-mismatch'
          // A thread native resumed on another provider than the requester's runs off it; it never becomes a session.
          : thread.modelProvider !== provider || offModel(value) || escaped ? 'native-failure' : closed ? 'closed' : undefined;
      if (refused) {
        keep(lease);
        return fail(refused, refused !== 'native-failure' || thread?.modelProvider !== provider ? undefined
          : offModel(value) ? resumeOffModel : escaped);
      }
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
      const { hostOperationId, input, params: extra, features, signal: hostSignal, recordIntent, lifecycle } = options;
      const raw = passthrough(extra, ['threadId', 'input']);
      if (!Array.isArray(input) || !raw || !(hostSignal instanceof AbortSignal)) return invalid;
      const resolved = resolveCodexFeatures('turn/start', features, raw, experimentalApi);
      if (resolved.kind === 'error') return resolved;
      const params = resolved.value;
      const blocked = constrainRoute('turn/start', params);
      if (blocked) return blocked;
      const identity = { hostOperationId, target: { kind: 'session', reference } } as const;
      handle = createDispatchOperation<CodexTurnResult>({ mode: 'fresh', identity, recordIntent,
        signal: AbortSignal.any([hostSignal, session.abort.signal]), ...(lifecycle ? { events: lifecycle } : {}),
        // Host or session abort prevents entry (core checks it just before this call). Once entered, only the
        // acknowledgement deadline bounds the wait: the caller's signal never turns a written turn/start uncertain.
        dispatchNative: (canonical) => dispatch(session, turn, canonical,
          { ...params, threadId: session.threadId, input: [...input] }, options.maxFrameBytes) });
    } catch { return invalid; }
    session.active = turn;
    void handle.run().then((snapshot) => {
      if (snapshot.observation.kind === 'not-dispatched') conclude(session, turn, { kind: 'not-dispatched' });
    });
    return { kind: 'ok', value: Object.freeze({ run: handle.run, reconcile: handle.reconcile, completion: turn.done }) };
  }
  /** One native `turn/start`, never resent. `not-sent` is adapter evidence; core still records `outcome-unknown`. */
  async function dispatch(session: Session, turn: Turn, identity: DispatchIdentity,
    params: Record<string, unknown>, maxFrameBytes?: number): Promise<NativeDispatchObservation<CodexTurnResult>> {
    const pending: Extract<TurnPhase, { kind: 'pending' }> = { kind: 'pending', early: [], dropped: 0 };
    turn.phase = pending;
    const reply = await request('turn/start', params, AbortSignal.timeout(bounds.acknowledgementTimeoutMs), maxFrameBytes);
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
  async function interrupt(session: Session, turn: Turn, deadline: AbortSignal): Promise<CodexInterruptResult> {
    const result = await (turn.interrupting ??= until(turn.identified.promise, deadline).then(async () => {
      const { phase } = turn;
      if (phase.kind !== 'identified' || turn.settled || deadline.aborted) {
        // Nothing was written: a still-pending turn may yet be identified, so a later interrupt or close tries again.
        if (!turn.settled && phase.kind !== 'orphaned') turn.interrupting = undefined;
        return { step: 'not-needed' as const, turnId: phase.kind === 'identified' ? phase.id : null, rejection: null };
      }
      const reply = await request('turn/interrupt', { threadId: session.threadId, turnId: phase.id }, deadline);
      return { step: step(reply), turnId: phase.id,
        rejection: reply.kind === 'error' ? { code: reply.error.code, message: reply.error.message } : null };
    }));
    // A joined attempt ran on its starter's deadline; if that expired unwritten, retry within this caller's own.
    const retry = result.step === 'not-needed' && !deadline.aborted && !turn.settled && turn.phase.kind !== 'orphaned';
    return retry ? interrupt(session, turn, deadline) : result;
  }
  async function shutdown(session: Session): Promise<CodexSessionCloseReport> {
    if (session.state === 'open') session.state = 'closing';
    session.abort.abort();
    const deadline = AbortSignal.timeout(bounds.cleanupTimeoutMs);
    let interrupted: CleanupStep = 'not-needed';
    const turn = session.active;
    if (turn) {
      interrupted = (await interrupt(session, turn, deadline)).step;
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
