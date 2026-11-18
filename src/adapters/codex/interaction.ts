import type { NativeExtension, Outcome } from '../../core/contracts.js';
import { createEventStream } from '../../core/events.js';
import type { EventObserver } from '../../core/events.js';
import { interactionLimits, parseInteractionContinuation } from '../../core/interaction.js';
import type { ApprovalTarget, InteractionError, NativeDelivery, PendingApproval, ToolEffect } from '../../core/interaction.js';
import type { CodexEvidence, CodexSession, CodexSessionEvent } from './execution.js';
import type { RequestId } from './protocol/RequestId.js';
import type { EndReason, TransportBounds, TransportOptions } from './transport.js';
import type { IncomingCall, RpcReply } from './wire.js';

/**
 * Every server request method in the pinned 0.169.0 bindings (plain and experimental) and this bridge's handling.
 * `approval`: held as authority-owned pending state until the host continues it or native evidence withdraws it.
 * `refused`: reported, then answered with JSON-RPC `-32601`, never a permit; unlisted methods are refused too. A host
 * that owns a refused method (for example auth token refresh) composes its own hook in front of `onServerRequest`.
 */
export const codexServerRequestSupport = Object.freeze({
  'item/commandExecution/requestApproval': 'approval',
  'item/fileChange/requestApproval': 'approval',
  /** A granted permission profile with scope: not a finite native choice. */
  'item/permissions/requestApproval': 'refused',
  /** Free-text answers. */
  'item/tool/requestUserInput': 'refused',
  'mcpServer/elicitation/request': 'refused',
  /** Dynamic tools register only through the experimental API; tool continuations are unsupported. */
  'item/tool/call': 'refused',
  'account/chatgptAuthTokens/refresh': 'refused',
  'attestation/generate': 'refused',
  'applyPatchApproval': 'refused',
  'execCommandApproval': 'refused',
  'currentTime/read': 'refused',
} as const satisfies Record<string, 'approval' | 'refused'>);
/** `qualified`: the pinned binary sent this request to a v2 client in a native run (probe.mjs decline). */
export const codexApprovalEvidence = Object.freeze({
  'item/commandExecution/requestApproval': 'qualified',
  'item/fileChange/requestApproval': 'unqualified',
} as const satisfies Record<string, CodexEvidence>);
export interface CodexInteractionOptions {
  /** Interaction event stream leases and per-observer capacity. */
  readonly maxObservers: number;
  readonly eventCapacity: number;
  /** Settled approvals remembered for duplicate and stale detection and late native evidence (oldest evicted first). */
  readonly maxSettled: number;
  /**
   * Approvals held at once. Must be below `transport.maxHandlers`, so a request beyond it is refused at once with a
   * decision-free `-32000` while a handler slot remains; a burst that still exceeds `maxHandlers` ends the transport.
   */
  readonly maxPending: number;
  /** The transport bounds passed to `openCodexExecution`. */
  readonly transport: Pick<TransportBounds, 'maxHandlers' | 'handlerTimeoutMs'>;
  /**
   * Host-selected, default `null`: an approval still unanswered `afterMs` after it arrived is answered with a
   * decision-free `-32000` and settles `expired`, before `handlerTimeoutMs` would end the whole transport. With `null`
   * the bridge never answers on its own clock.
   */
  readonly expiry?: { readonly afterMs: number } | null;
}
export type CodexSettlement =
  /** The reply was handed to the transport once. No native evidence confirms delivery, so it stays unknown. */
  | { readonly kind: 'replied'; readonly nativeChoiceId: string; readonly delivery: NativeDelivery }
  /**
   * Native ended the request before any host reply; a JSON-RPC error freed the transport lease, never a decision. `by` is
   * whichever native signal arrived first, so it follows arrival order (not pinned natively).
   */
  | { readonly kind: 'withdrawn'; readonly by: 'serverRequest/resolved' | 'item/completed' | 'turn/completed';
    readonly evidence: 'unqualified' }
  /** The host-selected expiry answered a decision-free error; its native fate is unqualified. */
  | { readonly kind: 'expired'; readonly delivery: NativeDelivery }
  /** The transport ended first (`cause`, e.g. `handler-timeout`): no decision was written, and none ever will be. */
  | { readonly kind: 'lost'; readonly reply: 'not-sent'; readonly cause: EndReason | 'aborted' };
export type CodexInteractionEvent =
  | { readonly kind: 'pending'; readonly pending: PendingApproval; readonly evidence: CodexEvidence }
  | { readonly kind: 'refused'; readonly method: string; readonly threadId: string | null;
    readonly reason: 'unsupported' | 'unattached' | 'malformed' | 'capacity'; readonly code: number;
    readonly request: NativeExtension }
  | { readonly kind: 'settled'; readonly target: ApprovalTarget; readonly settlement: CodexSettlement }
  /** Native evidence after settlement; it never changes the settlement's delivery. */
  | { readonly kind: 'observed'; readonly target: ApprovalTarget; readonly method: 'serverRequest/resolved' | 'item/completed';
    readonly effect: ToolEffect; readonly evidence: CodexEvidence }
  /** The bridge lost its session observer (overflow): native withdrawals for this thread are no longer seen. */
  | { readonly kind: 'blind'; readonly threadId: string };
export type CodexReplyError = InteractionError
  | { readonly code: 'stale-interaction' | 'duplicate-interaction' | 'intent-failed' | 'aborted' }
  | { readonly code: 'unsupported'; readonly feature: 'tool' | 'delegation' };
export interface CodexReplyOptions {
  readonly value: unknown;
  /**
   * Host durability before the single native write. A throw or abort returns the approval to pending with nothing
   * written; once it resolves the reply is written once, and a crash after that leaves the intent as evidence.
   */
  readonly recordIntent: (intent: { readonly target: ApprovalTarget; readonly nativeChoiceId: string },
    signal: AbortSignal) => void | PromiseLike<void>;
  readonly signal: AbortSignal;
}
export interface CodexInteraction {
  /** Pass as `openCodexExecution`'s `onServerRequest`; one bridge per execution. */
  readonly onServerRequest: TransportOptions['onRequest'];
  /** Before its first turn: binds the thread to the session reference and observes it (one observer lease). */
  readonly attach: (session: CodexSession) => Outcome<void, { readonly code: 'busy' | 'capacity' | 'closed' }>;
  /** Single use: the first valid continuation for a live target is the only native reply ever written for it. */
  readonly reply: (options: CodexReplyOptions) => Promise<Outcome<{ readonly nativeChoiceId: string;
    readonly delivery: NativeDelivery }, CodexReplyError>>;
  readonly pending: () => readonly PendingApproval[];
  readonly events: EventObserver<CodexInteractionEvent>;
}

type Entry = {
  readonly id: string;
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly method: keyof typeof codexApprovalEvidence;
  readonly pending: PendingApproval;
  readonly decisions: ReadonlyMap<string, unknown>;
  /** `reserved`: the host is recording intent; the entry is still unanswered. */
  state: 'live' | 'reserved' | CodexSettlement['kind'];
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly finish: (reply: RpcReply) => void;
};
type Attached = { readonly session: CodexSession; readonly policy: NativeExtension; readonly ended: string[] };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const refusal = (code: number, message: string): RpcReply =>
  Object.freeze({ kind: 'error', error: Object.freeze({ code, message, data: null }) });
const withdrawnReply = refusal(-32000, 'Request no longer pending');
const expiredReply = refusal(-32000, 'Approval expired unanswered');
const unknown = Object.freeze({ kind: 'unknown' } as const);
const fail = <E>(error: E) => Object.freeze({ kind: 'error', error: Object.freeze(error) }) as { kind: 'error'; error: E };
/** The file-change request carries no `availableDecisions` in the 0.169 bindings; its decision enum is this set. */
const fileChangeDecisions = ['accept', 'acceptForSession', 'decline', 'cancel'] as const;
const unanswered = (entry: Entry) => entry.state === 'live' || entry.state === 'reserved';

/**
 * Choices are exactly the request's own `availableDecisions` (0.169 command approvals under `untrusted`/`read-only` offer
 * `accept`, `{acceptWithExecpolicyAmendment}` and `cancel`, never `decline`). A string decision is its own choice. A
 * single-key object decision is passed through opaque as `<key>:<index>`: the reply writes a copy of the request's object
 * verbatim, so the bridge never builds or edits a proposal. Anything else, or a command approval without the list, is
 * `undefined` (refused malformed): the bridge never synthesizes a decision native did not offer.
 */
function decisions(method: Entry['method'], params: Record<string, unknown>): Map<string, unknown> | undefined {
  const offered: unknown = params.availableDecisions ?? (method === 'item/fileChange/requestApproval' ? fileChangeDecisions : null);
  if (!Array.isArray(offered)) return undefined;
  const choices = new Map<string, unknown>();
  for (const [index, decision] of offered.entries()) {
    const name = typeof decision === 'string' ? decision
      : record(decision) && Object.keys(decision).length === 1 ? `${Object.keys(decision)[0]}:${index}` : undefined;
    if (name === undefined || choices.has(name)) return undefined;
    choices.set(name, structuredClone(decision));
  }
  return choices;
}

export function createCodexInteraction(options: CodexInteractionOptions):
Outcome<CodexInteraction, { readonly code: 'invalid-input' }> {
  let bounds;
  try {
    const { maxObservers, eventCapacity, maxSettled, maxPending, transport, expiry = null } = options;
    const { maxHandlers, handlerTimeoutMs } = transport;
    if (![maxObservers, eventCapacity, maxSettled, maxPending, maxHandlers].every((value) => positive(value))
      || !positive(maxObservers * eventCapacity) || maxPending >= maxHandlers || !positive(handlerTimeoutMs, 2147483647)
      || (expiry !== null && !(record(expiry) && positive(expiry.afterMs) && expiry.afterMs < handlerTimeoutMs))) {
      return fail({ code: 'invalid-input' });
    }
    bounds = { maxObservers, eventCapacity, maxSettled, maxPending, expiryMs: expiry === null ? null : expiry.afterMs };
  } catch { return fail({ code: 'invalid-input' }); }
  const { maxSettled, maxPending, expiryMs } = bounds;
  const stream = createEventStream<CodexInteractionEvent>({ maxObservers: bounds.maxObservers, capacity: bounds.eventCapacity });
  const publish = (event: CodexInteractionEvent) => { stream.publish(Object.freeze(event)); };
  const threads = new Map<string, Attached>();
  /** Authority-owned pending state, keyed by the native approval identity; at most `maxPending` entries. */
  const live = new Map<string, Entry>();
  const settled = new Map<string, Entry>();

  function settle(entry: Entry, settlement: CodexSettlement, reply: RpcReply): void {
    clearTimeout(entry.timer);
    entry.state = settlement.kind;
    live.delete(entry.id);
    settled.set(entry.id, entry);
    for (const oldest of settled.keys()) {
      if (settled.size <= maxSettled) break;
      settled.delete(oldest);
    }
    publish({ kind: 'settled', target: entry.pending.target, settlement: Object.freeze(settlement) });
    entry.finish(reply);
  }
  const withdraw = (entry: Entry, by: Extract<CodexSettlement, { kind: 'withdrawn' }>['by']) =>
    settle(entry, { kind: 'withdrawn', by, evidence: 'unqualified' }, withdrawnReply);
  function refuse(request: IncomingCall, reason: Extract<CodexInteractionEvent, { kind: 'refused' }>['reason']): RpcReply {
    const code = reason === 'malformed' ? -32602 : reason === 'capacity' ? -32000 : -32601;
    const threadId = record(request.params) && typeof request.params.threadId === 'string' ? request.params.threadId : null;
    publish({ kind: 'refused', method: request.method, threadId, reason, code,
      request: Object.freeze({ namespace: 'codex-app-server/server-request', schemaVersion: 1,
        data: { method: request.method, id: request.id, params: request.params } }) });
    return refusal(code, reason === 'malformed' ? 'Malformed server request' : reason === 'capacity'
      ? 'Too many pending approvals' : 'Unsupported by switchboard Codex interaction');
  }

  /** Native evidence routed to the attached session by execution (thread, turn, item and request IDs, never order). */
  function observe(threadId: string, attached: Attached, event: CodexSessionEvent): void {
    const entries = () => [...live.values(), ...settled.values()].filter((entry) => entry.threadId === threadId);
    if (event.kind === 'turn-completed') {
      attached.ended.push(event.turnId);
      if (attached.ended.length > 4) attached.ended.shift();
      for (const entry of entries()) if (unanswered(entry) && entry.turnId === event.turnId) withdraw(entry, 'turn/completed');
      return;
    }
    if (event.kind !== 'native' || !record(event.params)) return;
    const params = event.params;
    if (event.method === 'serverRequest/resolved') {
      const matches = entries().filter((candidate) => Object.is(candidate.requestId, params.requestId));
      const entry = matches.find(unanswered) ?? matches.at(-1);
      if (entry && unanswered(entry)) withdraw(entry, 'serverRequest/resolved');
      else if (entry?.state === 'replied') {
        publish({ kind: 'observed', target: entry.pending.target, method: event.method, effect: unknown, evidence: 'unqualified' });
      }
    } else if (event.method === 'item/completed' && record(params.item)) {
      const { item } = params;
      const entry = entries().find((candidate) => candidate.itemId === item.id && candidate.turnId === params.turnId);
      if (!entry) return;
      if (unanswered(entry)) { withdraw(entry, 'item/completed'); return; }
      // Only a declined command is natively qualified to have no effect (probe.mjs); every other status stays unknown.
      const declined = entry.method === 'item/commandExecution/requestApproval' && item.status === 'declined';
      publish({ kind: 'observed', target: entry.pending.target, method: event.method, evidence: declined ? 'qualified' : 'unqualified',
        effect: declined ? Object.freeze({ kind: 'known', effect: 'none',
          evidence: Object.freeze({ namespace: 'codex-app-server/item-completed', schemaVersion: 1, data: item }) }) : unknown });
    }
  }

  async function onServerRequest(request: IncomingCall, signal: AbortSignal): Promise<RpcReply> {
    const support: string | undefined = Object.hasOwn(codexServerRequestSupport, request.method)
      ? codexServerRequestSupport[request.method as keyof typeof codexServerRequestSupport] : undefined;
    if (support !== 'approval') return refuse(request, 'unsupported');
    const method = request.method as Entry['method'];
    const params = record(request.params) ? request.params : {};
    const { threadId, turnId, itemId } = params;
    const approvalId = params.approvalId ?? null;
    if (typeof threadId !== 'string' || typeof turnId !== 'string' || typeof itemId !== 'string'
      || (approvalId !== null && typeof approvalId !== 'string')) return refuse(request, 'malformed');
    const attached = threads.get(threadId);
    if (!attached) return refuse(request, 'unattached');
    // Typed and lossless: the JSON-RPC id keeps its type, and the turn makes it unique across app-server generations.
    const id = JSON.stringify([request.id, turnId, itemId, approvalId]);
    const choices = decisions(method, params);
    if (!choices) return refuse(request, 'malformed');
    const target: ApprovalTarget = Object.freeze({ kind: 'approval', session: attached.session.reference, nativeApprovalId: id,
      tool: Object.freeze({ nativeToolCallId: itemId }) });
    const pending: PendingApproval = Object.freeze({ kind: 'approval', target, nativePolicy: attached.policy,
      request: Object.freeze({ namespace: 'codex-app-server/server-request', schemaVersion: 1, data: { method, id: request.id, params } }),
      choices: Object.freeze([...choices.keys()].slice(0, interactionLimits.maxChoices + 1)
        .map((nativeChoiceId) => Object.freeze({ nativeChoiceId, label: nativeChoiceId }))) });
    // Self-check through the core validator: a pending record the host could never answer is refused now, not held.
    const first = pending.choices[0]?.nativeChoiceId;
    const checked = parseInteractionContinuation({ value: { formatVersion: 1, kind: 'approval', target, nativeChoiceId: first },
      expected: pending });
    if (checked.kind === 'error' || live.has(id) || settled.has(id)) return refuse(request, 'malformed');
    // Refused while a transport handler slot remains (maxPending < maxHandlers), so a burst never reaches overflow.
    if (live.size >= maxPending) return refuse(request, 'capacity');
    if (signal.aborted) return withdrawnReply;
    let finish!: (reply: RpcReply) => void;
    const answered = new Promise<RpcReply>((resolve) => { finish = resolve; });
    const entry: Entry = { id, requestId: request.id, threadId, turnId, itemId, method, decisions: choices,
      pending, state: 'live', timer: undefined, finish };
    const onAbort = () => {
      if (unanswered(entry)) settle(entry, { kind: 'lost', reply: 'not-sent',
        cause: typeof signal.reason === 'string' ? signal.reason as EndReason : 'aborted' }, withdrawnReply);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    live.set(id, entry);
    publish({ kind: 'pending', pending: entry.pending, evidence: codexApprovalEvidence[method] });
    if (expiryMs !== null) {
      entry.timer = setTimeout(() => {
        if (unanswered(entry)) settle(entry, { kind: 'expired', delivery: unknown }, expiredReply);
      }, expiryMs);
    }
    // A late request for a turn whose terminal was already observed can never be answered usefully.
    if (attached.ended.includes(turnId)) withdraw(entry, 'turn/completed');
    try { return await answered; } finally { signal.removeEventListener('abort', onAbort); }
  }

  function attach(session: CodexSession): ReturnType<CodexInteraction['attach']> {
    if (threads.has(session.threadId)) return fail({ code: 'busy' });
    const native = record(session.native) ? session.native : {};
    const attached: Attached = { session, ended: [], policy: Object.freeze({ namespace: 'codex-app-server/thread-policy',
      schemaVersion: 1, data: Object.freeze({ approvalPolicy: native.approvalPolicy ?? null,
        approvalsReviewer: native.approvalsReviewer ?? null, sandbox: native.sandbox ?? null }) }) };
    const subscribed = session.events.subscribe((event) => observe(session.threadId, attached, event));
    if (subscribed.kind === 'error') return fail({ code: subscribed.error.code });
    threads.set(session.threadId, attached);
    void subscribed.value.ended.then((end) => {
      if (end === 'overflow' || end === 'listener-error') publish({ kind: 'blind', threadId: session.threadId });
    });
    return { kind: 'ok', value: undefined };
  }

  async function reply(options: CodexReplyOptions): ReturnType<CodexInteraction['reply']> {
    let value;
    let recordIntent;
    let signal;
    let kind;
    let id;
    try {
      ({ value, recordIntent, signal } = options);
      kind = record(value) ? value.kind : undefined;
      const target = record(value) && record(value.target) ? value.target : undefined;
      id = target?.nativeApprovalId;
    } catch { return fail({ code: 'invalid-input' }); }
    if (typeof recordIntent !== 'function' || !(signal instanceof AbortSignal)) return fail({ code: 'invalid-input' });
    if (kind === 'tool' || kind === 'delegation') return fail({ code: 'unsupported', feature: kind });
    if (kind !== 'approval' || typeof id !== 'string') return fail({ code: 'invalid-input' });
    // Lookup is by native identity only; a host correlation ID never names a target.
    const entry = live.get(id) ?? settled.get(id);
    if (!entry) return fail({ code: 'stale-interaction' });
    const parsed = parseInteractionContinuation({ value, expected: entry.pending });
    if (parsed.kind === 'error') return parsed;
    if (parsed.value.kind !== 'approval') return fail({ code: 'invalid-input' });
    if (entry.state === 'replied' || entry.state === 'reserved') return fail({ code: 'duplicate-interaction' });
    if (entry.state !== 'live') return fail({ code: 'stale-interaction' });
    const { nativeChoiceId } = parsed.value;
    entry.state = 'reserved';
    try {
      if (signal.aborted) throw new Error('aborted');
      await recordIntent(Object.freeze({ target: entry.pending.target, nativeChoiceId }), signal);
      if (signal.aborted) throw new Error('aborted');
    } catch {
      if (entry.state !== 'reserved') return fail({ code: 'stale-interaction' });
      entry.state = 'live';
      return fail({ code: signal.aborted ? 'aborted' : 'intent-failed' });
    }
    // Withdrawn, expired or lost while the host recorded intent: nothing is written.
    if (entry.state !== 'reserved') return fail({ code: 'stale-interaction' });
    settle(entry, { kind: 'replied', nativeChoiceId, delivery: unknown },
      { kind: 'result', value: { decision: entry.decisions.get(nativeChoiceId) } });
    return { kind: 'ok', value: Object.freeze({ nativeChoiceId, delivery: unknown }) };
  }

  return { kind: 'ok', value: Object.freeze({ onServerRequest, attach, reply, events: Object.freeze({ subscribe: stream.subscribe }),
    pending: () => Object.freeze([...live.values()].map((entry) => entry.pending)) }) };
}
