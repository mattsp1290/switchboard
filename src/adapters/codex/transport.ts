import { constants } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { createEventStream } from '../../core/events.js';
import { createWireReader, encodeEnvelope } from './wire.js';
import type { Envelope, IncomingCall, Notification, ReplyEnvelope, RpcReply, WireFault } from './wire.js';
import type { RequestId } from './protocol/RequestId.js';

export type Call = { readonly method: string; readonly params?: unknown };
export type Observation =
  | ({ readonly kind: 'notification' } & Notification)
  | { readonly kind: 'unmatched-reply'; readonly envelope: ReplyEnvelope };
export type SendFailure =
  | { readonly kind: 'not-sent'; readonly reason: 'closed' | 'capacity' | 'aborted' | 'invalid-outgoing' | 'id-exhausted' }
  | { readonly kind: 'uncertain'; readonly reason: 'closed' | 'aborted' };
export type Exchange = { readonly kind: 'reply'; readonly envelope: ReplyEnvelope } | SendFailure;
export type SendOutcome = { readonly kind: 'written' } | SendFailure;
export type EndReason = WireFault
  | 'caller-close' | 'eof' | 'transport-error' | 'process-exit' | 'listen-error'
  | 'handler-overflow' | 'duplicate-request' | 'handler-error' | 'invalid-handler-reply'
  | 'handler-timeout' | 'observation-overflow' | 'observation-error'
  | 'observation-timeout' | 'write-error' | 'write-timeout';
export interface CloseReport {
  readonly reason: EndReason;
  readonly diagnostics: Uint8Array;
  readonly detachFailed: boolean;
  readonly unsettled: { readonly handlers: number; readonly observer: boolean; readonly write: boolean };
  readonly discarded: { readonly observations: number; readonly requests: number };
}
export interface ChannelSink {
  readonly data: (bytes: Uint8Array) => void;
  readonly diagnostic: (bytes: Uint8Array) => void;
  readonly ended: (reason: 'eof' | 'transport-error' | 'process-exit') => void;
}
export interface BorrowedChannel {
  readonly listen: (sink: ChannelSink) => () => void;
  readonly write: (frame: Uint8Array, signal: AbortSignal) => PromiseLike<void>;
}
export interface TransportBounds {
  readonly maxFrameBytes: number;
  readonly maxChunkBytes: number;
  readonly maxDiagnosticBytes: number;
  readonly maxPending: number;
  readonly maxHandlers: number;
  readonly maxWrites: number;
  readonly observationCapacity: number;
  readonly handlerTimeoutMs: number;
  readonly observationTimeoutMs: number;
  readonly writeTimeoutMs: number;
}
export interface TransportOptions {
  readonly channel: BorrowedChannel;
  readonly bounds: TransportBounds;
  /** `signal` aborts only when the transport ends, with that `EndReason` as `signal.reason`. */
  readonly onRequest: (request: IncomingCall, signal: AbortSignal) => RpcReply | PromiseLike<RpcReply>;
  readonly onObservation: (observation: Observation, signal: AbortSignal) => void | PromiseLike<void>;
}
export interface CodexTransport {
  readonly request: (call: Call, signal: AbortSignal) => Promise<Exchange>;
  readonly notify: (call: Call, signal: AbortSignal) => Promise<SendOutcome>;
  readonly close: () => Promise<CloseReport>;
  readonly ended: Promise<CloseReport>;
}
type Wait<T> = {
  phase: 'queued' | 'entered' | 'settled';
  readonly signal: AbortSignal;
  readonly settle: (outcome: T) => void;
};
type Caller =
  | { readonly kind: 'request'; readonly id: string; readonly wait: Wait<Exchange> }
  | { readonly kind: 'notify'; readonly wait: Wait<SendOutcome> };
type HandlerLease = {
  readonly id: RequestId;
  readonly controller: AbortController;
  phase: 'scheduled' | 'callback' | 'reply';
  timer: ReturnType<typeof setTimeout> | undefined;
};
type WriteEntry = { readonly bytes: Uint8Array; readonly owner: Caller | { readonly kind: 'reply'; readonly handler: HandlerLease } };
type Registration = { readonly kind: 'installing' } | { readonly kind: 'attached'; readonly detach: () => void }
  | { readonly kind: 'detached'; readonly failed: boolean };
type Phase = { readonly kind: 'open' } | { readonly kind: 'closed'; readonly reason: EndReason;
  readonly unsettled: CloseReport['unsettled']; readonly discarded: CloseReport['discarded'] };

export function openCodexTransport(options: TransportOptions): CodexTransport {
  const { channel, onRequest, onObservation } = options;
  const bounds = { ...options.bounds };
  const { maxFrameBytes, maxChunkBytes, maxDiagnosticBytes, maxPending, maxHandlers, maxWrites,
    observationCapacity, handlerTimeoutMs, observationTimeoutMs, writeTimeoutMs } = bounds;
  const counts = [maxFrameBytes, maxChunkBytes, maxDiagnosticBytes, maxPending, maxHandlers, maxWrites,
    observationCapacity, (maxWrites + maxHandlers) * (maxFrameBytes + 1), observationCapacity * maxFrameBytes];
  if (counts.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || maxFrameBytes >= constants.MAX_LENGTH || maxChunkBytes > constants.MAX_LENGTH
    || maxDiagnosticBytes > constants.MAX_LENGTH
    || [handlerTimeoutMs, observationTimeoutMs, writeTimeoutMs].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 2147483647)) {
    throw new RangeError('Invalid transport bounds');
  }
  const pending = new Map<string, Extract<Caller, { kind: 'request' }>>();
  const handlers = new Map<RequestId, HandlerLease>();
  const queue: WriteEntry[] = [];
  const prefix = randomUUID();
  const writerController = new AbortController();
  const observerController = new AbortController();
  const events = createEventStream<Observation>({ maxObservers: 1, capacity: observationCapacity });
  let sequence = 0;
  let phase: Phase = { kind: 'open' };
  let registration: Registration = { kind: 'installing' };
  let active: WriteEntry | undefined;
  let pumpScheduled = false;
  let observerActive = false;
  let queuedObservations = 0;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let observerTimer: ReturnType<typeof setTimeout> | undefined;
  let diagnostics: Uint8Array = new Uint8Array();
  let settleReport: (report: CloseReport) => void;
  const ended = new Promise<CloseReport>((resolve) => { settleReport = resolve; });
  const reader = createWireReader({ maxFrameBytes, maxChunkBytes, onEnvelope: route, onFault: finish });
  const isClosed = () => phase.kind === 'closed';

  function report(): void {
    if (phase.kind === 'open' || registration.kind === 'installing') return;
    if (registration.kind === 'attached') {
      const detach = registration.detach;
      registration = { kind: 'detached', failed: false };
      try { detach(); } catch { registration = { kind: 'detached', failed: true }; }
    }
    settleReport(Object.freeze({ reason: phase.reason, diagnostics: diagnostics.slice(),
      detachFailed: registration.failed, unsettled: phase.unsettled, discarded: phase.discarded }));
  }
  function failWait(owner: Caller, reason: 'closed' | 'aborted'): void {
    if (owner.wait.phase === 'settled') return;
    if (owner.kind === 'request') pending.delete(owner.id);
    const index = queue.findIndex((entry) => entry.owner === owner);
    if (index >= 0) queue.splice(index, 1);
    owner.wait.settle({ kind: owner.wait.phase === 'entered' ? 'uncertain' : 'not-sent', reason });
  }
  function finish(reason: EndReason): void {
    if (phase.kind === 'closed') return;
    phase = { kind: 'closed', reason, unsettled: Object.freeze({
      handlers: [...handlers.values()].filter((handler) => handler.phase === 'callback').length,
      observer: observerActive, write: active !== undefined,
    }), discarded: Object.freeze({
      observations: queuedObservations,
      requests: [...handlers.values()].filter((handler) => handler.phase === 'scheduled').length,
    }) };
    reader.close();
    for (const owner of pending.values()) failWait(owner, 'closed');
    if (active && active.owner.kind !== 'reply') failWait(active.owner, 'closed');
    for (const entry of [...queue]) {
      if (entry.owner.kind !== 'reply') failWait(entry.owner, 'closed');
    }
    queue.length = 0;
    clearTimeout(writeTimer);
    clearTimeout(observerTimer);
    events.close();
    observerController.abort();
    writerController.abort();
    for (const handler of handlers.values()) {
      clearTimeout(handler.timer);
      if (handler.phase === 'scheduled' || (handler.phase === 'reply'
        && !(active?.owner.kind === 'reply' && active.owner.handler === handler))) handlers.delete(handler.id);
      handler.controller.abort(reason);
    }
    report();
  }
  function makeWait<T>(signal: AbortSignal, abort: () => void): { readonly wait: Wait<T>; readonly promise: Promise<T> } {
    let resolve: (outcome: T) => void;
    const promise = new Promise<T>((settle) => { resolve = settle; });
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const wait: Wait<T> = { phase: 'queued', signal, settle: (outcome) => {
      if (wait.phase === 'settled') return;
      wait.phase = 'settled';
      listener?.[Symbol.dispose]();
      resolve(outcome);
    } };
    listener = addAbortListener(signal, abort);
    return { wait, promise };
  }
  function refusal(signal: AbortSignal, request: boolean): SendFailure | undefined {
    if (phase.kind === 'closed') return { kind: 'not-sent', reason: 'closed' };
    if (signal.aborted) return { kind: 'not-sent', reason: 'aborted' };
    const callerWrites = queue.reduce((count, entry) => count + Number(entry.owner.kind !== 'reply'),
      Number(active !== undefined && active.owner.kind !== 'reply'));
    if (callerWrites >= maxWrites || (request && pending.size >= maxPending)) {
      return { kind: 'not-sent', reason: 'capacity' };
    }
    if (request && sequence >= Number.MAX_SAFE_INTEGER) return { kind: 'not-sent', reason: 'id-exhausted' };
    return undefined;
  }
  function request(call: Call, signal: AbortSignal): Promise<Exchange> {
    const before = refusal(signal, true);
    if (before) return Promise.resolve(before);
    const id = `${prefix}:${++sequence}`;
    const bytes = encodeEnvelope({ id, method: call.method, params: call.params }, maxFrameBytes);
    const after = refusal(signal, true);
    if (after) return Promise.resolve(after);
    if (!bytes) return Promise.resolve({ kind: 'not-sent', reason: 'invalid-outgoing' });
    const { wait, promise } = makeWait<Exchange>(signal, () => failWait(owner, 'aborted'));
    const owner: Extract<Caller, { kind: 'request' }> = { kind: 'request', id, wait };
    pending.set(id, owner);
    queue.push({ bytes, owner });
    schedulePump();
    return promise;
  }
  function notify(call: Call, signal: AbortSignal): Promise<SendOutcome> {
    const before = refusal(signal, false);
    if (before) return Promise.resolve(before);
    const bytes = encodeEnvelope({ method: call.method, params: call.params }, maxFrameBytes);
    const after = refusal(signal, false);
    if (after) return Promise.resolve(after);
    if (!bytes) return Promise.resolve({ kind: 'not-sent', reason: 'invalid-outgoing' });
    const { wait, promise } = makeWait<SendOutcome>(signal, () => failWait(owner, 'aborted'));
    const owner: Caller = { kind: 'notify', wait };
    queue.push({ bytes, owner });
    schedulePump();
    return promise;
  }
  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      if (phase.kind === 'open' && !active) void pump();
    });
  }
  async function pump(): Promise<void> {
    const entry = queue.shift();
    if (!entry) return;
    const owner = entry.owner;
    if (owner.kind !== 'reply' && owner.wait.signal.aborted) {
      failWait(owner, 'aborted');
      schedulePump();
      return;
    }
    active = entry;
    if (owner.kind !== 'reply') owner.wait.phase = 'entered';
    writeTimer = setTimeout(() => finish('write-timeout'), writeTimeoutMs);
    let failed = false;
    try {
      await channel.write(entry.bytes, writerController.signal);
      if (owner.kind === 'notify') owner.wait.settle({ kind: 'written' });
    } catch { failed = true; }
    finally {
      clearTimeout(writeTimer);
      if (owner.kind === 'reply') handlers.delete(owner.handler.id);
      else if (failed) failWait(owner, 'closed');
      active = undefined;
      if (failed) finish('write-error');
      schedulePump();
    }
  }
  async function runHandler(request: IncomingCall, handler: HandlerLease): Promise<void> {
    if (isClosed()) return;
    handler.phase = 'callback';
    handler.timer = setTimeout(() => finish('handler-timeout'), handlerTimeoutMs);
    let reply: RpcReply;
    try { reply = await onRequest(request, handler.controller.signal); }
    catch {
      clearTimeout(handler.timer);
      handlers.delete(handler.id);
      finish('handler-error');
      return;
    }
    clearTimeout(handler.timer);
    handler.phase = 'reply';
    if (isClosed()) { handlers.delete(handler.id); return; }
    let bytes: Uint8Array | undefined;
    try {
      bytes = encodeEnvelope(reply.kind === 'result' ? { id: handler.id, result: reply.value }
        : reply.kind === 'error' ? { id: handler.id, error: reply.error } : {}, maxFrameBytes);
    } catch { bytes = undefined; }
    if (isClosed()) { handlers.delete(handler.id); return; }
    if (!bytes) { finish('invalid-handler-reply'); return; }
    queue.push({ bytes, owner: { kind: 'reply', handler } });
    schedulePump();
  }
  function route(envelope: Envelope): void {
    if (phase.kind === 'closed') return;
    if (envelope.kind === 'request') {
      const request = envelope.request;
      if (handlers.has(request.id)) { finish('duplicate-request'); return; }
      if (handlers.size >= maxHandlers) { finish('handler-overflow'); return; }
      const handler: HandlerLease = { id: request.id, controller: new AbortController(), phase: 'scheduled', timer: undefined };
      handlers.set(request.id, handler);
      queueMicrotask(() => { void runHandler(request, handler); });
      return;
    }
    if (envelope.kind === 'reply') {
      const owner = typeof envelope.envelope.id === 'string' ? pending.get(envelope.envelope.id) : undefined;
      if (owner?.wait.phase === 'entered') {
        pending.delete(owner.id);
        owner.wait.settle({ kind: 'reply', envelope: envelope.envelope });
        return;
      }
    }
    const observation: Observation = envelope.kind === 'notification'
      ? { kind: 'notification', ...envelope.notification } : { kind: 'unmatched-reply', envelope: envelope.envelope };
    queuedObservations++;
    const result = events.publish(observation);
    if (result.kind === 'closed' || result.disconnected || result.enqueued !== 1) finish('observation-overflow');
  }
  events.subscribe(async (observation) => {
    if (phase.kind === 'closed') return;
    queuedObservations--;
    observerActive = true;
    observerTimer = setTimeout(() => finish('observation-timeout'), observationTimeoutMs);
    try { await onObservation(observation, observerController.signal); }
    catch { observerActive = false; finish('observation-error'); }
    finally { clearTimeout(observerTimer); observerActive = false; }
  });
  try {
    const detach = channel.listen({
      data: reader.push,
      diagnostic: (bytes) => {
        if (phase.kind === 'closed') return;
        const tail = bytes.subarray(Math.max(0, bytes.length - maxDiagnosticBytes));
        const kept = diagnostics.subarray(Math.max(0, diagnostics.length + tail.length - maxDiagnosticBytes));
        diagnostics = Buffer.concat([kept, tail]);
      },
      ended: (reason) => {
        if (reason === 'eof') reader.end();
        finish(reason);
      },
    });
    registration = { kind: 'attached', detach };
  } catch {
    registration = { kind: 'detached', failed: false };
    finish('listen-error');
  }
  report();
  return { request, notify, ended, close: () => {
    finish('caller-close');
    return ended;
  } };
}
