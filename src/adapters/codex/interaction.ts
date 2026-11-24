import { addAbortListener } from 'node:events';
import type { NativeExtension, Outcome } from '../../core/contracts.js';
import { createEventStream } from '../../core/events.js';
import type { EventObserver } from '../../core/events.js';
import { interactionLimits, parseInteractionContinuation } from '../../core/interaction.js';
import type { ApprovalTarget, InteractionContinuation, InteractionError, NativeDelivery, PendingApproval, ToolEffect, ToolTarget } from '../../core/interaction.js';
import type { CodexEvidence, CodexSession, CodexSessionEvent } from './execution.js';
import type { DynamicToolCallOutputContentItem } from './protocol/DynamicToolCallOutputContentItem.js';
import type { ToolRequestUserInputResponse } from './protocol/ToolRequestUserInputResponse.js';
import type { RequestId } from './protocol/RequestId.js';
import type { EndReason, IncomingRequestIntake, TransportBounds, TransportOptions } from './transport.js';
import { encodeEnvelope } from './wire.js';
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
  /** Free-text answers. Refused unless the host set `userInput`. */
  'item/tool/requestUserInput': 'refused',
  'mcpServer/elicitation/request': 'refused',
  /** Dynamic tool calls. Refused unless the host passed `declaredTools`. */
  'item/tool/call': 'refused',
  'account/chatgptAuthTokens/refresh': 'refused',
  'attestation/generate': 'refused',
  'applyPatchApproval': 'refused',
  'execCommandApproval': 'refused',
  'currentTime/read': 'refused',
} as const satisfies Record<string, 'approval' | 'refused'>);
/** `item/tool/call` and `item/tool/requestUserInput` stay refused in the table unless the host admits them. */
function admittedHostMethod(method: string, admitted: { readonly tools: boolean; readonly userInput: boolean }): 'host' | undefined {
  if (admitted.tools && method === 'item/tool/call') return 'host';
  if (admitted.userInput && method === 'item/tool/requestUserInput') return 'host';
  return undefined;
}
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
  readonly transport: Pick<TransportBounds, 'maxHandlers' | 'handlerTimeoutMs' | 'maxFrameBytes'>;
  readonly approvals?: boolean;
  /**
   * Host-selected, default `null`: an approval still unanswered `afterMs` after it arrived is answered with a
   * decision-free `-32000` and settles `expired`, before `handlerTimeoutMs` would end the whole transport. With `null`
   * the bridge never answers on its own clock. Expiry stops when a recorded host answer is staged; it does not bound
   * queued native delivery or establish native receipt.
   */
  readonly expiry?: { readonly afterMs: number } | null;
  /**
   * Host dynamic tools, keyed by namespace and name. Present (even empty) admits `item/tool/call` for those tools and
   * tool continuations. Absent keeps the historical refusal, so a tool continuation stays `unsupported`.
   */
  readonly declaredTools?: readonly { readonly name: string; readonly namespace: string | null }[];
  /** When true, `item/tool/requestUserInput` is held for the host instead of refused. */
  readonly userInput?: boolean;
}
export interface CodexHostCall {
  readonly method: 'item/tool/call' | 'item/tool/requestUserInput';
  readonly name: string;
  readonly arguments: unknown;
  readonly pending: { readonly kind: 'tool'; readonly target: ToolTarget };
}
export type CodexSettlement =
  /** The reply was handed to the transport once. No native evidence confirms delivery, so it stays unknown. */
  | { readonly kind: 'replied'; readonly nativeChoiceId: string; readonly delivery: NativeDelivery }
  /**
   * Native ended the request before any host reply; a JSON-RPC error freed the transport lease, never a decision. `by` is
   * whichever native signal arrived first, so it follows arrival order (not pinned natively).
   */
  | { readonly kind: 'withdrawn'; readonly by: 'serverRequest/resolved' | 'item/completed' | 'turn/completed' | 'turn/interrupt';
    readonly evidence: 'unqualified' }
  /** The host-selected expiry answered a decision-free error; its native fate is unqualified. */
  | { readonly kind: 'expired'; readonly delivery: NativeDelivery }
  /** Native transport loss or local batch retirement: no positive decision was written for this target. */
  | { readonly kind: 'lost'; readonly reply: 'not-sent'; readonly cause: EndReason | 'aborted' | 'stale-interaction' };
export type CodexInteractionEvent =
  | { readonly kind: 'pending'; readonly pending: PendingApproval; readonly evidence: CodexEvidence }
  | { readonly kind: 'refused'; readonly method: string; readonly threadId: string | null;
    readonly reason: 'unsupported' | 'unattached' | 'malformed' | 'capacity'; readonly code: number;
    readonly request: NativeExtension }
  | { readonly kind: 'settled'; readonly target: ApprovalTarget; readonly settlement: CodexSettlement }
  /** Native evidence after settlement; it never changes the settlement's delivery. */
  | { readonly kind: 'observed'; readonly target: ApprovalTarget; readonly method: 'serverRequest/resolved' | 'item/completed';
    readonly effect: ToolEffect; readonly evidence: CodexEvidence }
  | { readonly kind: 'host-settled'; readonly target: ToolTarget;
    readonly settlement: Extract<CodexSettlement, { kind: 'withdrawn' | 'lost' }> }
  | { readonly kind: 'host-call'; readonly call: CodexHostCall; readonly argumentsJson: string }
  | { readonly kind: 'host-delivery'; readonly target: ToolTarget; readonly delivery: NativeDelivery };
export type CodexReplyError = InteractionError
  | { readonly code: 'stale-interaction' | 'duplicate-interaction' | 'intent-failed' | 'aborted' }
  | { readonly code: 'unsupported'; readonly feature: 'tool' | 'delegation' };
export interface CodexReplyOptions {
  readonly value: unknown;
  /**
   * Host durability before the single native write. A throw or abort during recording returns the approval to pending
   * with nothing written. After recording succeeds, caller cancellation cannot retract the queued reply; native
   * withdrawal or transport loss can still prevent entry. A crash leaves the durable intent as evidence.
   */
  readonly recordIntent: (intent: { readonly target: ApprovalTarget | ToolTarget; readonly nativeChoiceId: string },
    signal: AbortSignal) => void | PromiseLike<void>;
  readonly signal: AbortSignal;
}
export interface CodexPreparedBatch {
  /** The selected replies are single use; admission means the first positive reply entered the channel writer. */
  readonly entry: Promise<Outcome<void, { readonly code: 'aborted' | 'stale-interaction' }>>;
  /** Every selected positive reply entered the writer, or the batch was withheld; still no native receipt claim. */
  readonly written: CodexPreparedBatch['entry'];
  readonly entered: () => boolean;
  /** Synchronous commit: no native request can join between the final set check and the first reply. */
  readonly commit: (signal: AbortSignal, onReply: (answer: InteractionContinuation, call: CodexHostCall | undefined) => void, beforeReply: () => void)
    => Outcome<{ readonly replies: number }, { readonly code: 'aborted' | 'stale-interaction'; readonly replies: number }>;
}
interface PreparedReply {
  readonly key: string;
  readonly requestId: RequestId;
  readonly answer: InteractionContinuation;
  readonly call: CodexHostCall | undefined;
  readonly nativeChoiceId: string;
  readonly reply: RpcReply;
  readonly isLive: () => boolean;
  readonly nativeLive: () => boolean;
  readonly signal: AbortSignal;
  readonly beforeWrite: (callbacks: Parameters<Admission['beforeWrite']>[0]) => void;
  readonly record: (intent: CodexReplyOptions['recordIntent'], signal: AbortSignal) => ReturnType<typeof recordChoice>;
  readonly commit: () => boolean;
  readonly stage: (expected?: 'live' | 'reserved') => boolean;
  readonly staged: () => boolean;
  readonly discard: (cause: 'aborted' | 'stale-interaction') => void;
  readonly release: () => void;
  readonly fault: () => void;
}
function preparedState(input: {
  readonly entry: Readonly<Pick<Entry, 'state' | 'finish'>>;
  readonly admission: Admission;
  readonly reserve: () => void;
  readonly owns: () => boolean;
  readonly reply: RpcReply;
  readonly onDiscard: (cause: 'aborted' | 'stale-interaction') => void;
  readonly onCommit: () => void;
  readonly onRecord: PreparedReply['record'];
}): Pick<PreparedReply, 'isLive' | 'staged' | 'stage' | 'discard' | 'commit' | 'beforeWrite' | 'release' | 'fault' | 'record'> {
  const { entry, admission, reserve, owns, reply, onDiscard, onCommit, onRecord } = input;
  let reservation: 'none' | 'recorded' | 'staged' = 'none';
  let release = () => {};
  return {
    isLive: () => reservation === 'none' && entry.state === 'live' && owns(),
    staged: () => reservation === 'staged' && entry.state === 'reserved' && owns(),
    stage: (expected = 'live') => {
      if (reservation !== (expected === 'live' ? 'none' : 'recorded') || entry.state !== expected || !owns()) return false;
      reserve(); reservation = 'staged'; entry.finish(reply); return true;
    },
    discard: (cause) => {
      if (reservation !== 'none' && entry.state === 'reserved' && owns()) {
        reservation = 'none'; onDiscard(cause);
      }
    },
    commit: () => {
      if (reservation !== 'staged' || entry.state !== 'reserved' || !owns()) return false;
      reservation = 'none'; onCommit(); return true;
    },
    beforeWrite(callbacks) { release(); release = admission.beforeWrite(callbacks); },
    release() { release(); release = () => {}; },
    fault: admission.fault,
    async record(intent, signal) {
      if (!owns()) return 'stale-interaction';
      const result = await onRecord(intent, signal);
      if (result === 'ok') {
        if (entry.state !== 'reserved' || !owns()) return 'stale-interaction';
        reservation = 'recorded';
      }
      return result;
    },
  };
}

function discardPrepared(entries: readonly PreparedReply[], cause: 'aborted' | 'stale-interaction'): void {
  for (const entry of entries) {
    try { entry.discard(cause); } catch { /* refusal is already settled; reclaim the remaining peers */ }
    finally { entry.release(); }
  }
}

export interface CodexInteraction {
  /** One trusted host projection; public diagnostic observers remain independently bounded. */
  readonly project: (listener: (event: CodexInteractionEvent) => void) => () => void;
  readonly beginTurn: () => void;
  readonly capacityRefused: () => boolean;
  readonly prepareBatch: (values: unknown) => Outcome<CodexPreparedBatch, CodexReplyError>;
  /** Pass as `openCodexExecution`'s `onServerRequest`; one bridge per execution. */
  readonly onServerRequest: TransportOptions['onRequest'];
  /** Before its first turn: binds the thread to the session reference and registers one trusted bounded intake. */
  readonly attach: (session: CodexSession) => Outcome<void, { readonly code: 'busy' | 'capacity' | 'closed' }>;
  /** Single use: the first valid continuation for a live target is the only native reply ever written for it. */
  readonly reply: (options: CodexReplyOptions) => Promise<Outcome<{ readonly nativeChoiceId: string;
    readonly delivery: NativeDelivery }, CodexReplyError>>;
  readonly pending: () => readonly PendingApproval[];
  /** Unanswered host tool calls and `request_user_input` requests. Empty unless those options were set. */
  readonly hostCalls: () => readonly CodexHostCall[];
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
  expiresAt: number | null;
  readonly finish: (reply: RpcReply) => void;
  readonly admission: Admission;
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
};
type Attached = { readonly session: CodexSession; readonly policy: NativeExtension };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const refusal = (code: number, message: string): Extract<RpcReply, { readonly kind: 'error' }> =>
  Object.freeze({ kind: 'error', error: Object.freeze({ code, message, data: null }) });
const withdrawnReply = refusal(-32000, 'Request no longer pending');
const expiredReply = refusal(-32000, 'Approval expired unanswered');
const unknown = Object.freeze({ kind: 'unknown' } as const);
const fail = <E>(error: E) => Object.freeze({ kind: 'error', error: Object.freeze(error) }) as { kind: 'error'; error: E };
/** The file-change request carries no `availableDecisions` in the 0.169 bindings; its decision enum is this set. */
const fileChangeDecisions = ['accept', 'acceptForSession', 'decline', 'cancel'] as const;
const endReasons = {
  'malformed-frame': 'malformed-frame',
  'oversized-frame': 'oversized-frame',
  'input-overflow': 'input-overflow',
  'invalid-envelope': 'invalid-envelope',
  'caller-close': 'caller-close',
  'eof': 'eof',
  'transport-error': 'transport-error',
  'process-exit': 'process-exit',
  'listen-error': 'listen-error',
  'handler-overflow': 'handler-overflow',
  'duplicate-request': 'duplicate-request',
  'handler-error': 'handler-error',
  'invalid-handler-reply': 'invalid-handler-reply',
  'handler-timeout': 'handler-timeout',
  'observation-overflow': 'observation-overflow',
  'observation-error': 'observation-error',
  'observation-timeout': 'observation-timeout',
  'write-error': 'write-error',
  'write-timeout': 'write-timeout',
  'aborted': 'aborted',
} as const satisfies Record<EndReason | 'aborted', EndReason | 'aborted'>;
const isEndReason = (value: unknown): value is keyof typeof endReasons => typeof value === 'string' && Object.hasOwn(endReasons, value);
const endReason = (value: unknown): EndReason | 'aborted' => isEndReason(value) ? endReasons[value] : 'aborted';
const unanswered = (entry: Entry) => entry.state === 'live' || entry.state === 'reserved';

/**
 * The four native bodies a host tool reply may write. An empty `data` object is an explicit success.
 * Anything else is refused before a reply is written.
 */
export function codexNativeToolReply(call: CodexHostCall, answer: InteractionContinuation): RpcReply | undefined {
  if (answer.kind !== 'tool') return undefined;
  try {
    const { outcome } = answer;
    const extension = outcome.result.kind === 'ok' ? outcome.result.value : outcome.result.error;
    if (!record(extension) || !record(extension.data)) return undefined;
    const { data } = extension;
    if (call.method === 'item/tool/requestUserInput') {
      if (!record(data.answers)) return undefined;
      const entries: [string, { answers: string[] }][] = [];
      for (const [id, value] of Object.entries(data.answers)) {
        if (!record(value) || !Array.isArray(value.answers)) return undefined;
        const answers: unknown[] = Array.from(value.answers);
        if (!answers.every((answer): answer is string => typeof answer === 'string')) return undefined;
        entries.push([id, { answers }]);
      }
      const value: ToolRequestUserInputResponse = { answers: Object.fromEntries(entries) };
      return { kind: 'result', value };
    }
    const success = outcome.result.kind === 'ok';
    if (Array.isArray(data.contentItems)) {
      const contentItems: DynamicToolCallOutputContentItem[] = [];
      const rawItems: readonly unknown[] = data.contentItems;
      for (const item of rawItems) {
        if (!record(item)) return undefined;
        const { type } = item;
        if (type === 'inputText') {
          const text = item.text; if (typeof text !== 'string') return undefined;
          contentItems.push({ type, text });
        } else if (type === 'inputImage') {
          const imageUrl = item.imageUrl; if (typeof imageUrl !== 'string') return undefined;
          contentItems.push({ type, imageUrl });
        } else if (type === 'inputAudio') {
          const audioUrl = item.audioUrl; if (typeof audioUrl !== 'string') return undefined;
          contentItems.push({ type, audioUrl });
        } else return undefined;
      }
      return { kind: 'result', value: { contentItems, success } };
    }
    if (typeof data.text === 'string') {
      return { kind: 'result', value: { contentItems: [{ type: 'inputText', text: data.text }], success } };
    }
    if (success && Object.keys(data).length === 0) return { kind: 'result', value: { contentItems: [], success: true } };
    return undefined;
  } catch { return undefined; }
}
type RefusalReason = Extract<CodexInteractionEvent, { kind: 'refused' }>['reason'];
const refusals: Readonly<Record<RefusalReason, readonly [number, string]>> = Object.freeze({
  malformed: [-32602, 'Malformed server request'], capacity: [-32000, 'Too many pending approvals'],
  unsupported: [-32601, 'Unsupported by switchboard Codex interaction'],
  unattached: [-32601, 'Unsupported by switchboard Codex interaction'] });

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

async function recordChoice(entry: { state: string }, target: ApprovalTarget | ToolTarget, nativeChoiceId: string,
  recordIntent: CodexReplyOptions['recordIntent'], signal: AbortSignal): Promise<'ok' | 'stale-interaction' | 'aborted' | 'intent-failed'> {
  entry.state = 'reserved';
  try {
    if (signal.aborted) throw new Error('aborted');
    await recordIntent(Object.freeze({ target, nativeChoiceId }), signal);
    if (signal.aborted) throw new Error('aborted');
  } catch {
    if (entry.state !== 'reserved') return 'stale-interaction';
    entry.state = 'live';
    return signal.aborted ? 'aborted' : 'intent-failed';
  }
  return entry.state === 'reserved' ? 'ok' : 'stale-interaction';
}

type Admission = { readonly matched: boolean | Promise<boolean>; readonly withdrawn: () => boolean; readonly stop: () => void;
  readonly live: () => boolean; readonly beforeWrite: (callbacks: { readonly allowed: () => boolean; readonly entered: () => void; readonly withheld: () => void }) => () => void; readonly retire: () => void; readonly fault: () => void };
/** Preserve primitive native identity and a withdrawal guard through queued writer admission. */
function matchesLiveTurn(attached: Attached, request: IncomingCall, turnId: string, signal: AbortSignal,
intake: IncomingRequestIntake): Admission {
  const params = record(request.params) ? request.params : {};
  const { threadId, itemId, callId } = params;
  const requestId = request.id;
  let callbacks: Parameters<Admission['beforeWrite']>[0] | undefined;
  let withdrawn = false;
  let endWait = () => {};
  const withdrawal = new Promise<false>(resolve => { endWait = () => resolve(false); });
  const stop = intake.watchNotification(({ method, params: raw }) => {
    if (!record(raw) || raw.threadId !== threadId) return;
    if (method === 'serverRequest/resolved' && Object.is(raw.requestId, requestId)) withdrawn = true;
    if (method === 'turn/completed' && record(raw.turn) && raw.turn.id === turnId
      && (raw.turn.status === 'completed' || raw.turn.status === 'failed' || raw.turn.status === 'interrupted')) withdrawn = true;
    if (method === 'item/completed' && raw.turnId === turnId && record(raw.item)
      && raw.item.id === (itemId ?? callId)) withdrawn = true;
    if (withdrawn) endWait();
  });
  const live = () => !withdrawn && attached.session.matchesTurn(turnId, signal) === true;
  intake.replyAllowed(() => callbacks ? callbacks.allowed() : live(), withdrawnReply.error, () => callbacks?.entered());
  const nativeMatch = attached.session.matchesTurn(turnId, signal);
  const matched = typeof nativeMatch === 'boolean' ? nativeMatch : Promise.race([nativeMatch, withdrawal]);
  return { matched, withdrawn: () => withdrawn, stop, live, beforeWrite: (value) => { callbacks = value; return () => { if (callbacks === value) callbacks = undefined; }; }, retire: () => { withdrawn = true; const lost = callbacks?.withheld; callbacks = undefined; lost?.(); }, fault: intake.fault };
}

/** Tool requests use a separate ledger because their reply bodies and settlement identities differ from approvals. */
function createHostLedger(deps: {
  readonly publish: (event: CodexInteractionEvent, onError?: () => void) => void;
  readonly threads: Map<string, Attached>;
  readonly declared: Set<string>;
  readonly maxSettled: number;
  readonly maxPending: number;
  readonly live: { readonly size: number };
  readonly refuse: (request: IncomingCall, reason: RefusalReason) => RpcReply;
}) {
  const { publish, threads, declared, maxSettled, maxPending, live, refuse } = deps;
  type HostEntry = { readonly id: string; readonly threadId: string; readonly turnId: string; readonly requestId: IncomingCall['id'];
    readonly callId: string; readonly call: CodexHostCall; state: 'live' | 'reserved' | 'replied' | 'lost'; delivered: boolean;
    readonly finish: (reply: RpcReply) => void; readonly admission: Admission; readonly signal: AbortSignal; readonly cleanup: () => void };
  const hostLive = new Map<string, HostEntry>();
  const hostSettled = new Map<string, HostEntry>();
  const hostByRequest = new Map<IncomingCall['id'], HostEntry>();
  const hostByItem = new Map<string, HostEntry>();
  const hostItemKey = (turnId: string, callId: string) => `${turnId}\0${callId}`;
  function forgetHost(entry: HostEntry): void {
    if (hostByRequest.get(entry.requestId) === entry) hostByRequest.delete(entry.requestId);
    const itemKey = hostItemKey(entry.turnId, entry.callId);
    if (hostByItem.get(itemKey) === entry) hostByItem.delete(itemKey);
  }
  function rememberHost(entry: HostEntry): void {
    hostSettled.set(entry.id, entry);
    for (const oldest of hostSettled.keys()) {
      if (hostSettled.size <= maxSettled) break;
      const evicted = hostSettled.get(oldest);
      hostSettled.delete(oldest);
      if (evicted) forgetHost(evicted);
    }
  }
  function deliverHost(entry: HostEntry): void {
    if (entry.delivered) return;
    entry.delivered = true;
    publish({ kind: 'host-delivery', target: entry.call.pending.target, delivery: { kind: 'unknown' } }, entry.admission.fault);
  }
  function loseHost(entry: HostEntry, settlement: Extract<CodexSettlement, { kind: 'withdrawn' | 'lost' }>): void {
    if (entry.state === 'replied' || entry.state === 'lost') return;
    entry.state = 'lost';
    entry.cleanup();
    hostLive.delete(entry.id);
    rememberHost(entry);
    entry.finish(withdrawnReply);
    entry.admission.retire();
    publish({ kind: 'host-settled', target: entry.call.pending.target, settlement: Object.freeze(settlement) }, entry.admission.fault);
  }
  function onEvent(threadId: string, event: CodexSessionEvent): void {
    if (event.kind === 'turn-completed') {
      for (const entry of [...hostLive.values()]) {
        if (entry.threadId === threadId && entry.turnId === event.turnId) loseHost(entry, { kind: 'withdrawn', by: 'turn/completed', evidence: 'unqualified' });
      }
      return;
    }
    if (event.kind !== 'native' || !record(event.params)) return;
    const params = event.params;
    if (event.method === 'serverRequest/resolved') {
      const requestId = typeof params.requestId === 'string' || typeof params.requestId === 'number' ? params.requestId : undefined;
      const host = requestId === undefined ? undefined : hostByRequest.get(requestId);
      if (host && host.threadId === threadId && hostLive.has(host.id)) loseHost(host, { kind: 'withdrawn', by: 'serverRequest/resolved', evidence: 'unqualified' });
      return;
    }
    if (event.method !== 'item/completed' || !record(params.item)) return;
    const itemId = params.item.id;
    if (typeof params.turnId !== 'string' || typeof itemId !== 'string') return;
    const host = hostByItem.get(hostItemKey(params.turnId, itemId));
    if (!host || host.threadId !== threadId) return;
    if (host.state === 'replied') deliverHost(host);
    if (hostLive.has(host.id)) loseHost(host, { kind: 'withdrawn', by: 'item/completed', evidence: 'unqualified' });
  }
  async function take(request: IncomingCall, signal: AbortSignal, intake: IncomingRequestIntake): Promise<RpcReply> {
    const params = record(request.params) ? request.params : {};
    const { threadId, turnId } = params;
    if (typeof threadId !== 'string' || typeof turnId !== 'string') return refuse(request, 'malformed');
    const attached = threads.get(threadId);
    if (!attached) return refuse(request, 'unattached');
    const user = request.method === 'item/tool/requestUserInput';
    const callId = user ? params.itemId : params.callId;
    const name = user ? 'request_user_input' : params.tool;
    const namespace = user ? null : params.namespace === null || typeof params.namespace === 'string' ? params.namespace : undefined;
    if (typeof callId !== 'string' || typeof name !== 'string' || namespace === undefined) return refuse(request, 'malformed');
    if (!user && !declared.has(`${namespace ?? ''}\0${name}`)) return refuse(request, 'unsupported');
    const argumentsValue = user ? params.questions : params.arguments;
    let argumentsJson: string | undefined;
    try { argumentsJson = JSON.stringify(argumentsValue ?? null); } catch { return refuse(request, 'malformed'); }
    if (argumentsJson === undefined) return refuse(request, 'malformed');
    const id = JSON.stringify([request.id, turnId, callId]);
    if (hostLive.has(id) || hostSettled.has(id)) return refuse(request, 'malformed');
    const matches = matchesLiveTurn(attached, request, turnId, signal, intake);
    if (!(typeof matches.matched === 'boolean' ? matches.matched : await matches.matched) || matches.withdrawn() || !matches.live() || signal.aborted) { matches.stop(); return withdrawnReply; }
    if (live.size + hostLive.size >= maxPending) { matches.stop(); return refuse(request, 'capacity'); }
    const target: ToolTarget = Object.freeze({ kind: 'tool', session: attached.session.reference, nativeToolCallId: id });
    if (parseInteractionContinuation({ value: { formatVersion: 1, kind: 'tool', outcome: { target, result: { kind: 'ok', value: { namespace: 'codex/target-check', schemaVersion: 1, data: null } }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } }, expected: { kind: 'tool', target } }).kind === 'error') { matches.stop(); return refuse(request, 'malformed'); }
    const call: CodexHostCall = Object.freeze({ method: user ? 'item/tool/requestUserInput' : 'item/tool/call', name,
      arguments: argumentsValue, pending: Object.freeze({ kind: 'tool', target }) });
    if (signal.aborted) return withdrawnReply;
    let finish!: (reply: RpcReply) => void;
    const answered = new Promise<RpcReply>((resolve) => { finish = resolve; });
    const entry: HostEntry = { id, threadId, turnId, requestId: request.id, callId, call, state: 'live', delivered: false, finish, admission: matches, signal, cleanup: () => signal.removeEventListener('abort', onAbort) };
    const onAbort = () => loseHost(entry, { kind: 'lost', reply: 'not-sent', cause: endReason(signal.reason) });
    signal.addEventListener('abort', onAbort, { once: true });
    hostLive.set(id, entry);
    hostByRequest.set(request.id, entry);
    hostByItem.set(hostItemKey(turnId, callId), entry);
    publish({ kind: 'host-call', call, argumentsJson });
    try { return await answered; } finally { if (entry.state !== 'reserved') entry.cleanup(); }
  }
  function prepare(value: unknown): Outcome<PreparedReply, CodexReplyError> {
    const outcome = record(value) && record(value.outcome) ? value.outcome : undefined;
    const target = outcome && record(outcome.target) ? outcome.target : undefined;
    const id = target && typeof target.nativeToolCallId === 'string' ? target.nativeToolCallId : undefined;
    const entry = id === undefined ? undefined : hostLive.get(id) ?? hostSettled.get(id);
    if (!entry) return fail({ code: 'stale-interaction' });
    const parsed = parseInteractionContinuation({ value, expected: entry.call.pending });
    if (parsed.kind === 'error') return parsed;
    if (parsed.value.kind !== 'tool') return fail({ code: 'invalid-input' });
    if (entry.state === 'replied' || entry.state === 'reserved') return fail({ code: 'duplicate-interaction' });
    if (entry.state !== 'live') return fail({ code: 'stale-interaction' });
    const replyValue = codexNativeToolReply(entry.call, parsed.value);
    if (!replyValue) return fail({ code: 'invalid-input' });
    return { kind: 'ok', value: {
      key: `tool:${entry.id}`, requestId: entry.requestId, answer: parsed.value, call: entry.call,
      nativeChoiceId: entry.id, reply: replyValue, nativeLive: entry.admission.live, signal: entry.signal,
      ...preparedState({ entry, admission: entry.admission, reserve: () => { entry.state = 'reserved'; },
        owns: () => hostLive.get(entry.id) === entry, reply: replyValue,
        onRecord: (intent, signal) => recordChoice(entry, entry.call.pending.target, entry.id, intent, signal),
        onDiscard: (cause) => loseHost(entry, { kind: 'lost', reply: 'not-sent', cause }), onCommit: () => {
          entry.state = 'replied';
          entry.cleanup();
          hostLive.delete(entry.id);
          rememberHost(entry);
          entry.finish(replyValue);
        } }),
    } };
  }
  return { get size() { return hostLive.size; }, onEvent, take, prepare,
    withdrawTurn(threadId: string, turnId: string) {
      for (const entry of [...hostLive.values()]) {
        if (entry.threadId === threadId && entry.turnId === turnId) {
          loseHost(entry, { kind: 'withdrawn', by: 'turn/interrupt', evidence: 'unqualified' });
        }
      }
    },
    calls: () => Object.freeze([...hostLive.values()].map((entry) => entry.call)) };
}

export function createCodexInteraction(options: CodexInteractionOptions):
Outcome<CodexInteraction, { readonly code: 'invalid-input' }> {
  let bounds: { readonly maxObservers: number; readonly eventCapacity: number; readonly maxSettled: number;
    readonly maxPending: number; readonly maxReplyFrameBytes: number; readonly approvals: boolean; readonly expiryMs: number | null };
  const declared = new Set<string>();
  let capacityRefused = false;
  let userInput = false;
  try {
    const { maxObservers, eventCapacity, maxSettled, maxPending, transport, expiry = null } = options;
    const { maxHandlers, handlerTimeoutMs } = transport;
    const maxReplyFrameBytes = transport.maxFrameBytes;
    if (![maxObservers, eventCapacity, maxSettled, maxPending, maxHandlers].every((value) => positive(value))
      || !positive(maxReplyFrameBytes) || maxReplyFrameBytes > 2147483647
      || !positive(maxObservers * eventCapacity) || maxPending >= maxHandlers || !positive(handlerTimeoutMs, 2147483647)
      || (expiry !== null && !(record(expiry) && positive(expiry.afterMs) && expiry.afterMs < handlerTimeoutMs))) {
      return fail({ code: 'invalid-input' });
    }
    if (options.declaredTools !== undefined) {
      if (!Array.isArray(options.declaredTools)) return fail({ code: 'invalid-input' });
      for (const tool of options.declaredTools) {
        if (!record(tool) || typeof tool.name !== 'string' || tool.name.length === 0
          || (tool.namespace !== null && typeof tool.namespace !== 'string')) return fail({ code: 'invalid-input' });
        declared.add(`${tool.namespace ?? ''}\0${tool.name}`);
      }
    }
    if (options.approvals !== undefined && typeof options.approvals !== 'boolean') return fail({ code: 'invalid-input' });
    if (options.userInput !== undefined && typeof options.userInput !== 'boolean') return fail({ code: 'invalid-input' });
    userInput = options.userInput === true;
    bounds = { maxObservers, eventCapacity, maxSettled, maxPending, maxReplyFrameBytes, approvals: options.approvals !== false, expiryMs: expiry === null ? null : expiry.afterMs };
  } catch { return fail({ code: 'invalid-input' }); }
  const { maxSettled, maxPending, expiryMs } = bounds;
  const stream = createEventStream<CodexInteractionEvent>({ maxObservers: bounds.maxObservers, capacity: bounds.eventCapacity });
  let projector: ((event: CodexInteractionEvent) => void) | undefined;
  const project: CodexInteraction['project'] = (listener) => {
    if (projector) throw new Error('Interaction projector already attached');
    projector = listener; return () => { if (projector === listener) projector = undefined; };
  };
  const publish = (event: CodexInteractionEvent, onError?: () => void) => {
    const fact = Object.freeze(event);
    queueMicrotask(() => { stream.publish(fact); });
    try { projector?.(fact); }
    catch (error) { if (onError) onError(); else throw error; }

  };
  const threads = new Map<string, Attached>();
  /** Authority-owned pending state, keyed by the native approval identity; at most `maxPending` entries. */
  const live = new Map<string, Entry>();
  const settled = new Map<string, Entry>();
  const hostTools = options.declaredTools !== undefined || userInput;
  function supportFor(method: string): 'approval' | 'host' | 'refused' {
    const admitted = admittedHostMethod(method, { tools: options.declaredTools !== undefined, userInput });
    if (admitted) return admitted;
    return Object.hasOwn(codexServerRequestSupport, method)
      ? codexServerRequestSupport[method as keyof typeof codexServerRequestSupport] : 'refused';
  }
  function settle(entry: Entry, settlement: CodexSettlement, reply: RpcReply): void {
    clearTimeout(entry.timer);
    entry.cleanup();
    entry.state = settlement.kind;
    live.delete(entry.id);
    settled.set(entry.id, entry);
    for (const oldest of settled.keys()) {
      if (settled.size <= maxSettled) break;
      settled.delete(oldest);
    }
    entry.finish(reply);
    if (settlement.kind !== 'replied') entry.admission.retire();
    publish({ kind: 'settled', target: entry.pending.target, settlement: Object.freeze(settlement) }, entry.admission.fault);
  }
  const withdraw = (entry: Entry, by: Extract<CodexSettlement, { kind: 'withdrawn' }>['by']) =>
    settle(entry, { kind: 'withdrawn', by, evidence: 'unqualified' }, withdrawnReply);
  function refuse(request: IncomingCall, reason: RefusalReason): RpcReply {
    if (reason === 'capacity') capacityRefused = true;
    const [code, message] = refusals[reason];
    const threadId = record(request.params) && typeof request.params.threadId === 'string' ? request.params.threadId : null;
    publish({ kind: 'refused', method: request.method, threadId, reason, code,
      request: Object.freeze({ namespace: 'codex-app-server/server-request', schemaVersion: 1,
        data: Object.freeze({ method: request.method, id: request.id, params: request.params }) }) });
    return refusal(code, message);
  }
  const hostLedger = createHostLedger({ publish, threads, declared, maxSettled, maxPending, live, refuse });

  /** Native evidence routed to the attached session by execution (thread, turn, item and request IDs, never order). */
  function observe(threadId: string, attached: Attached, event: CodexSessionEvent): void {
    hostLedger.onEvent(threadId, event);
    const entries = () => [...live.values(), ...settled.values()].filter((entry) => entry.threadId === threadId);
    if (event.kind === 'turn-completed') {
      for (const entry of [...live.values()]) {
        if (entry.threadId === threadId && entry.turnId === event.turnId) withdraw(entry, 'turn/completed');
      }
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
      const matching = entries().filter((candidate) => candidate.itemId === item.id && candidate.turnId === params.turnId);
      for (const entry of matching) {
      if (unanswered(entry)) { withdraw(entry, 'item/completed'); continue; }
      // Only a declined command is natively qualified to have no effect (probe.mjs); every other status stays unknown.
      const declined = entry.method === 'item/commandExecution/requestApproval' && item.status === 'declined';
      publish({ kind: 'observed', target: entry.pending.target, method: event.method, evidence: declined ? 'qualified' : 'unqualified',
        effect: declined ? Object.freeze({ kind: 'known', effect: 'none',
          evidence: Object.freeze({ namespace: 'codex-app-server/item-completed', schemaVersion: 1, data: item }) }) : unknown });
      }
    }
  }

  async function onServerRequest(request: IncomingCall, signal: AbortSignal, intake: IncomingRequestIntake): Promise<RpcReply> {
    const support = supportFor(request.method);
    if (support === 'host') return hostLedger.take(request, signal, intake);
    if (support !== 'approval' || !bounds.approvals) return refuse(request, 'unsupported');
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
    if (!choices || choices.size > interactionLimits.maxChoices) return refuse(request, 'malformed');
    const target: ApprovalTarget = Object.freeze({ kind: 'approval', session: attached.session.reference, nativeApprovalId: id,
      tool: Object.freeze({ nativeToolCallId: itemId }) });
    const pending: PendingApproval = Object.freeze({ kind: 'approval', target, nativePolicy: attached.policy,
      request: Object.freeze({ namespace: 'codex-app-server/server-request', schemaVersion: 1, data: Object.freeze({ method, id: request.id, params }) }),
      choices: Object.freeze([...choices.keys()].map((nativeChoiceId) => Object.freeze({ nativeChoiceId, label: nativeChoiceId }))) });
    // Self-check through the core validator: a pending record the host could never answer is refused now, not held.
    const first = pending.choices[0]?.nativeChoiceId;
    const checked = parseInteractionContinuation({ value: { formatVersion: 1, kind: 'approval', target, nativeChoiceId: first },
      expected: pending });
    if (checked.kind === 'error' || live.has(id) || settled.has(id)) return refuse(request, 'malformed');
    const expiresAt = expiryMs === null ? null : performance.now() + expiryMs;
    const matches = matchesLiveTurn(attached, request, turnId, signal, intake);
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let matched: boolean | 'expired';
    try {
      matched = typeof matches.matched === 'boolean' ? matches.matched : expiryMs === null ? await matches.matched : await Promise.race([matches.matched,
        new Promise<'expired'>(resolve => { expiryTimer = setTimeout(() => resolve('expired'), expiryMs); })]);
    } finally { clearTimeout(expiryTimer); }
    if (matched === 'expired' || (expiresAt !== null && performance.now() >= expiresAt)) { matches.stop(); return expiredReply; }
    if (!matched || matches.withdrawn() || !matches.live() || signal.aborted) { matches.stop(); return withdrawnReply; }
    // Refused while a transport handler slot remains (maxPending < maxHandlers), so a burst never reaches overflow.
    if (live.size + hostLedger.size >= maxPending) { matches.stop(); return refuse(request, 'capacity'); }
    if (signal.aborted) return withdrawnReply;
    let finish!: (reply: RpcReply) => void;
    const answered = new Promise<RpcReply>((resolve) => { finish = resolve; });
    const entry: Entry = { id, requestId: request.id, threadId, turnId, itemId, method, decisions: choices,
      pending, state: 'live', timer: undefined, expiresAt, finish, admission: matches, signal, cleanup: () => signal.removeEventListener('abort', onAbort) };
    const onAbort = () => {
      if (unanswered(entry)) settle(entry, { kind: 'lost', reply: 'not-sent',
        cause: endReason(signal.reason) }, withdrawnReply);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    live.set(id, entry);
    if (expiryMs !== null) {
      entry.timer = setTimeout(() => {
        if (unanswered(entry)) settle(entry, { kind: 'expired', delivery: unknown }, expiredReply);
      }, Math.max(0, (expiresAt ?? performance.now()) - performance.now()));
    }
    publish({ kind: 'pending', pending: entry.pending, evidence: codexApprovalEvidence[method] });
    try { return await answered; } finally { if (entry.state !== 'reserved') entry.cleanup(); }
  }

  function attach(session: CodexSession): ReturnType<CodexInteraction['attach']> {
    if (threads.has(session.threadId)) return fail({ code: 'busy' });
    const native = record(session.native) ? session.native : {};
    const attached: Attached = { session, policy: Object.freeze({ namespace: 'codex-app-server/thread-policy',
      schemaVersion: 1, data: Object.freeze({ approvalPolicy: native.approvalPolicy ?? null,
        approvalsReviewer: native.approvalsReviewer ?? null, sandbox: native.sandbox ?? null }) }) };
    const subscribed = session.intake({ interrupted: (turnId) => { withdrawTurn(session.threadId, turnId); }, notification: (method, raw) => {
      const params = record(raw) ? raw : {};
      if (method === 'turn/completed' && record(params.turn) && typeof params.turn.id === 'string'
        && (params.turn.status === 'completed' || params.turn.status === 'failed' || params.turn.status === 'interrupted')) {
        observe(session.threadId, attached, { kind: 'turn-completed', evidence: 'qualified', turnId: params.turn.id,
          status: params.turn.status, error: params.turn.error ?? null, turn: params.turn });
      } else observe(session.threadId, attached, { kind: 'native', method, params, evidence: 'unqualified' });
    } });
    if (subscribed.kind === 'error') return fail({ code: subscribed.error.code });
    threads.set(session.threadId, attached);

    return { kind: 'ok', value: undefined };
  }

  function prepareOne(value: unknown): Outcome<PreparedReply, CodexReplyError> {
    const kind = record(value) ? value.kind : undefined;
    if (kind === 'tool') return hostTools ? hostLedger.prepare(value) : fail({ code: 'unsupported', feature: 'tool' });
    if (kind === 'delegation') return fail({ code: 'unsupported', feature: 'delegation' });
    const target = record(value) && record(value.target) ? value.target : undefined;
    const id = target?.nativeApprovalId;
    if (kind !== 'approval' || typeof id !== 'string') return fail({ code: 'invalid-input' });
    const entry = live.get(id) ?? settled.get(id);
    if (!entry) return fail({ code: 'stale-interaction' });
    const parsed = parseInteractionContinuation({ value, expected: entry.pending });
    if (parsed.kind === 'error') return parsed;
    if (parsed.value.kind !== 'approval') return fail({ code: 'invalid-input' });
    if (entry.state === 'replied' || entry.state === 'reserved') return fail({ code: 'duplicate-interaction' });
    if (entry.state !== 'live') return fail({ code: 'stale-interaction' });
    const { nativeChoiceId } = parsed.value;
    const replyValue: RpcReply = { kind: 'result', value: { decision: structuredClone(entry.decisions.get(nativeChoiceId)) } };
    return { kind: 'ok', value: {
      key: `approval:${entry.id}`, requestId: entry.requestId, answer: parsed.value, call: undefined,
      nativeChoiceId, reply: replyValue, nativeLive: entry.admission.live, signal: entry.signal,
      ...preparedState({ entry, admission: entry.admission, reserve: () => { clearTimeout(entry.timer); entry.timer = undefined; entry.expiresAt = null; entry.state = 'reserved'; },
        owns: () => {
          if (unanswered(entry) && entry.expiresAt !== null && performance.now() >= entry.expiresAt) {
            settle(entry, { kind: 'expired', delivery: unknown }, expiredReply);
          }
          return live.get(entry.id) === entry;
        }, reply: replyValue,
        onRecord: (intent, signal) => recordChoice(entry, entry.pending.target, nativeChoiceId, intent, signal),
        onDiscard: (cause) => settle(entry, { kind: 'lost', reply: 'not-sent', cause }, withdrawnReply),
        onCommit: () => settle(entry, { kind: 'replied', nativeChoiceId, delivery: unknown }, replyValue) }),
    } };
  }
  function checkedReply(value: unknown): Outcome<PreparedReply, CodexReplyError> {
    try {
      const prepared = prepareOne(value);
      if (prepared.kind === 'error') return prepared;
      const { requestId: id, reply } = prepared.value;
      const envelope = reply.kind === 'result' ? { id, result: reply.value } : { id, error: reply.error };
      return encodeEnvelope(envelope, bounds.maxReplyFrameBytes) ? prepared : fail({ code: 'invalid-input' });
    } catch { return fail({ code: 'invalid-input' }); }
  }
  function prepareBatch(raw: unknown): Outcome<CodexPreparedBatch, CodexReplyError> {
    try {
      if (!Array.isArray(raw) || raw.length === 0 || raw.length !== live.size + hostLedger.size) return fail({ code: 'invalid-input' });
      const values: unknown[] = structuredClone(raw);
      const entries: PreparedReply[] = [];
      for (let index = 0; index < values.length; index++) {
        const prepared = checkedReply(values[index]);
        if (prepared.kind === 'error') return prepared;
        if (entries.some((entry) => entry.key === prepared.value.key)) return fail({ code: 'duplicate-interaction' });
        entries.push(prepared.value);
      }
      let used = false;
      let entered = false;
      let finished = false;
      let remaining = entries.length;
      let blocked: 'aborted' | 'stale-interaction' | undefined;
      let admit!: (value: Awaited<CodexPreparedBatch['entry']>) => void;
      const admission: CodexPreparedBatch['entry'] = new Promise((resolve) => { admit = resolve; });
      let written!: (value: Awaited<CodexPreparedBatch['entry']>) => void;
      const completion: CodexPreparedBatch['entry'] = new Promise((resolve) => { written = resolve; });
      let abort: ReturnType<typeof addAbortListener> | undefined;
      const refuseEntry = (code: 'aborted' | 'stale-interaction', afterIntake = false) => {
        if (finished) return;
        finished = true; blocked = code; abort?.[Symbol.dispose]();
        if (!entered) admit(fail({ code }));
        written(fail({ code }));
        const release = () => { discardPrepared(entries, code); entries.length = 0; };
        // Native turn/item retirement must finish classifying all peers before batch-only losses are applied.
        if (afterIntake) queueMicrotask(release); else release();
      };
      return { kind: 'ok', value: Object.freeze({ entry: admission, written: completion, entered: () => entered, commit(signal, onReply, beforeReply) {
        let replies = 0;
        const refused = (code: 'aborted' | 'stale-interaction') => { refuseEntry(code); return fail({ code, replies }); };
        if (used) return fail({ code: 'stale-interaction', replies });
        used = true;
        if (signal.aborted) return refused('aborted');
        if (entries.length !== live.size + hostLedger.size || entries.some((entry) => !entry.isLive())) return refused('stale-interaction');
        const lifetime = AbortSignal.any([signal, ...entries.map((entry) => entry.signal)]);
        abort = addAbortListener(lifetime, () => queueMicrotask(() => {
          if (!entered || !signal.aborted || entries.some(entry => entry.signal.aborted)) refuseEntry(signal.aborted ? 'aborted' : 'stale-interaction', !signal.aborted);
        }));
        for (const entry of entries) {
          try { beforeReply(); }
          catch { const result = refused('stale-interaction'); entry.fault(); return result; }
          if (capacityRefused) return refused('stale-interaction');
          if (signal.aborted) return refused('aborted');
          if (!entry.stage()) return refused('stale-interaction');
          replies++;
        }
        for (const entry of entries) entry.beforeWrite({ allowed: () => {
          if (blocked) return false;
          if (!entered) {
            if (lifetime.aborted || capacityRefused || live.size + hostLedger.size !== entries.length || entries.some((member) => !member.staged() || !member.nativeLive())) {
              const code = signal.aborted ? 'aborted' : 'stale-interaction';
              queueMicrotask(() => refuseEntry(code)); return false;
            }
          }
          if (!entry.nativeLive() || entry.signal.aborted || (!entered && signal.aborted)) { const code = signal.aborted ? 'aborted' : 'stale-interaction';
              queueMicrotask(() => refuseEntry(code)); return false; }
          return true;
        }, entered: () => {
          if (!entered) { entered = true; admit({ kind: 'ok', value: undefined }); }
          if (!entry.commit()) { refuseEntry('stale-interaction'); return; }
          entry.release();
          // The transport invoked the writer before publishing these entry and reply facts.
          queueMicrotask(() => { try { onReply(entry.answer, entry.call); } catch { entry.fault(); } });
          remaining--;
          if (remaining === 0) { finished = true; abort?.[Symbol.dispose](); entries.length = 0; written({ kind: 'ok', value: undefined }); }
        }, withheld: () => refuseEntry('stale-interaction', true) });
        return { kind: 'ok', value: { replies } };
      } } satisfies CodexPreparedBatch) };
    } catch { return fail({ code: 'invalid-input' }); }
  }
  async function reply(options: CodexReplyOptions): ReturnType<CodexInteraction['reply']> {
    let prepared;
    let recordIntent;
    let signal;
    try {
      ({ recordIntent, signal } = options);
      prepared = checkedReply(structuredClone(options.value));
    } catch { return fail({ code: 'invalid-input' }); }
    if (typeof recordIntent !== 'function' || !(signal instanceof AbortSignal)) return fail({ code: 'invalid-input' });
    if (prepared.kind === 'error') return prepared;
    const recorded = await prepared.value.record(recordIntent, signal);
    if (recorded !== 'ok') return fail({ code: recorded });
    const entry = prepared.value;
    const lifetime = entry.signal;
    return new Promise((resolve) => {
      let completed = false;
      let abort: ReturnType<typeof addAbortListener> | undefined;
      const refuse = (code: 'aborted' | 'stale-interaction') => {
        if (completed) return;
        completed = true; abort?.[Symbol.dispose]();
        resolve(fail({ code }));
        discardPrepared([entry], code);
      };
      entry.beforeWrite({
        allowed: () => {
          if (lifetime.aborted || !entry.staged() || !entry.nativeLive()) {
            queueMicrotask(() => refuse('stale-interaction')); return false;
          }
          return true;
        },
        entered: () => {
          completed = true; abort?.[Symbol.dispose]();
          resolve({ kind: 'ok', value: Object.freeze({ nativeChoiceId: entry.nativeChoiceId, delivery: unknown }) });
          try { entry.commit(); } finally { entry.release(); }
        },
        withheld: () => refuse('stale-interaction'),
      });
      abort = addAbortListener(lifetime, () => queueMicrotask(() => refuse('stale-interaction')));
      if (lifetime.aborted) refuse('stale-interaction');
      else if (!entry.stage('reserved')) refuse('stale-interaction');
    });
  }

  function withdrawTurn(threadId: string, turnId: string): void {
      hostLedger.withdrawTurn(threadId, turnId);
      for (const entry of [...live.values()]) {
        if (entry.threadId === threadId && entry.turnId === turnId && unanswered(entry)) {
          withdraw(entry, 'turn/interrupt');
        }
      }
    }

  return { kind: 'ok', value: Object.freeze({ onServerRequest, attach, reply, prepareBatch, project, events: Object.freeze({ subscribe: stream.subscribe }),
    beginTurn: () => { capacityRefused = false; }, capacityRefused: () => capacityRefused,
    pending: () => Object.freeze([...live.values()].map((entry) => entry.pending)),
    hostCalls: () => hostLedger.calls() }) };
}
