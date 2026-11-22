import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { parseCheckpointReference } from '../index.js';
import type {
  DispatchIdentity, HostAdapter, HostAdapterEvent, HostAdapterRegistration, HostLaunch, HostOpenOptions,
  HostSegmentResult, HostToolCall, HostToolDeclaration, InteractionContinuation, Outcome,
} from '../index.js';

export interface HostConformanceSubject {
  readonly registration: HostAdapterRegistration<HostOpenOptions>;
  /** A host launch whose launcher allows or refuses every launch. */
  readonly launch: (mode: 'allow' | 'deny') => HostLaunch;
  /** `attempts` counts host launcher calls; `signals` counts signals sent to host-owned processes. */
  readonly launches: () => { readonly attempts: number; readonly signals: number };
  readonly tool: HostToolDeclaration;
  /** Prompts the subject's model answers with text, one call of `tool`, or two calls of `tool` in one message. */
  readonly prompts: { readonly text: string; readonly toolCall: string; readonly twoToolCalls: string };
  readonly dispose: () => Promise<void>;
}
export type HostConformanceFactory = () => HostConformanceSubject | PromiseLike<HostConformanceSubject>;
export type HostConformanceContract = (factory: HostConformanceFactory, signal: AbortSignal) => Promise<void>;
export type HostConformanceContracts = Readonly<Record<
  'segments' | 'interaction' | 'history' | 'interrupt' | 'host-launcher', HostConformanceContract
>>;

interface Harness {
  readonly subject: HostConformanceSubject;
  readonly signal: AbortSignal;
  open(options?: Partial<HostOpenOptions>): Promise<HostAdapter>;
  segment(adapter: HostAdapter, prompt: string, intents?: DispatchIdentity[]): Promise<HostSegmentResult>;
  answer(adapter: HostAdapter, answers: readonly InteractionContinuation[], intents?: DispatchIdentity[]): Promise<HostSegmentResult>;
}

async function withSubject(factory: HostConformanceFactory, signal: AbortSignal, body: (harness: Harness) => Promise<void>) {
  const subject = await factory();
  const opened: HostAdapter[] = [];
  let operation = 0;
  const harness: Harness = {
    subject, signal,
    async open(options = {}) {
      const adapter = ok(await subject.registration.open({ launch: subject.launch('allow'), tools: [subject.tool], ...options }, signal));
      opened.push(adapter);
      return adapter;
    },
    segment: (adapter, prompt, intents = []) => adapter.run({ prompt, signal, hostOperationId: `operation-${++operation}`,
      recordIntent: (identity) => { intents.push(identity); } }),
    answer: (adapter, answers, intents = []) => adapter.continue({ answers, signal, hostOperationId: `operation-${++operation}`,
      recordIntent: (identity) => { intents.push(identity); } }),
  };
  try {
    await body(harness);
  } finally {
    await Promise.allSettled(opened.map((adapter) => adapter.close()));
    await subject.dispose();
  }
}

function ok<T, E>(outcome: Outcome<T, E>): T {
  assert.equal(outcome.kind, 'ok', `expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.value;
}
function kind<K extends HostSegmentResult['kind']>(result: HostSegmentResult, expected: K): Extract<HostSegmentResult, { kind: K }> {
  assert.equal(result.kind, expected, `expected ${expected}, got ${JSON.stringify(result)}`);
  return result as Extract<HostSegmentResult, { kind: K }>;
}
function answer(call: HostToolCall): InteractionContinuation {
  const evidence = { namespace: 'host-conformance', schemaVersion: 1, data: {} };
  return { formatVersion: 1, kind: 'tool', outcome: { target: call.pending.target,
    result: { kind: 'ok', value: evidence }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
}
async function collect(adapter: HostAdapter, until: (events: readonly HostAdapterEvent[]) => boolean, signal: AbortSignal) {
  const events: HostAdapterEvent[] = [];
  const subscription = ok(adapter.events.subscribe((event) => { events.push(event); }, { signal }));
  return {
    events,
    async settled() {
      for (let turn = 0; turn < 100 && !until(events); turn++) await setImmediate(undefined, { signal });
      subscription.dispose();
      assert(until(events), `expected events not observed: ${JSON.stringify(events)}`);
      return events;
    },
  };
}

async function segments(factory: HostConformanceFactory, signal: AbortSignal) {
  await withSubject(factory, signal, async (harness) => {
    const adapter = await harness.open();
    const { capabilities } = adapter;
    assert.deepEqual(adapter.identity, harness.subject.registration.identity);
    assert.equal(capabilities.toolDeclarations, 'fixed-at-creation');
    assert(Number.isSafeInteger(capabilities.maxPendingPerMessage) && capabilities.maxPendingPerMessage >= 1);
    if (capabilities.imageInput.kind !== 'supported') {
      const before = harness.subject.launches().attempts;
      const refused = kind(await adapter.run({ prompt: harness.subject.prompts.text, signal, hostOperationId: 'image-refusal',
        images: [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }],
        recordIntent: () => { throw new Error('Unsupported images must not record intent.'); } }), 'failed');
      assert.equal(refused.write.kind, 'not-attempted');
      assert.equal(harness.subject.launches().attempts, before);
    }
    const observed = await collect(adapter, (events) => events.some((event) => event.kind === 'text-delta'), signal);
    const intents: DispatchIdentity[] = [];
    let releaseRecorded = () => {};
    const recordedGate = new Promise<void>((resolve) => { releaseRecorded = resolve; });
    const pending = adapter.run({
      prompt: harness.subject.prompts.text, signal, hostOperationId: 'intent-order',
      recordIntent: (identity) => { intents.push(identity); return recordedGate; },
    });
    for (let turn = 0; turn < 10 && intents.length === 0; turn++) await setImmediate(undefined, { signal });
    assert.equal(intents.length, 1, 'recordIntent runs before dispatch');
    assert.equal(observed.events.some((event) => event.kind === 'text-delta'), false,
      'no segment fact is published before recordIntent resolves');
    releaseRecorded();
    const complete = kind(await pending, 'complete');
    assert.equal(intents.length, 1, 'intent is recorded once before dispatch');
    assert.equal(intents[0]?.target.kind, 'new-session');
    assert.equal(complete.session.kind, 'session');
    assert.equal(typeof complete.text, 'string');
    assert.equal(complete.usage.scope, capabilities.usage);
    await observed.settled();
    const next: DispatchIdentity[] = [];
    kind(await harness.segment(adapter, harness.subject.prompts.text, next), 'complete');
    assert.deepEqual(next[0]?.target, { kind: 'session', reference: complete.session });

    const changedTools = await harness.subject.registration.open({
      launch: harness.subject.launch('allow'),
      tools: [{ ...harness.subject.tool, description: 'changed after creation' }],
      resume: { session: complete.session },
    }, signal);
    if (changedTools.kind === 'ok') {
      await changedTools.value.close();
      assert.fail('tool declarations changed after session creation');
    }
    assert.equal(changedTools.error.code, 'invalid-input');

    let releaseIntent = () => {};
    const gate = new Promise<void>((resolve) => { releaseIntent = resolve; });
    const overlapping = adapter.run({ prompt: harness.subject.prompts.text, signal, hostOperationId: 'overlap',
      recordIntent: () => gate });
    const busy = kind(await adapter.run({ prompt: harness.subject.prompts.text, signal, hostOperationId: 'overlap-2',
      recordIntent: () => { throw new Error('The busy segment must not record intent.'); } }), 'failed');
    assert.equal(busy.error.code, 'busy');
    assert.deepEqual(busy.write, { kind: 'not-attempted' });
    releaseIntent();
    kind(await overlapping, 'complete');

    const refused = kind(await adapter.run({ prompt: harness.subject.prompts.text, signal, hostOperationId: 'refused',
      recordIntent: () => { throw new Error('Host refused the intent.'); } }), 'failed');
    assert.deepEqual(refused.write, { kind: 'not-dispatched', reason: 'intent-failed' });
    let called = false;
    const aborted = kind(await adapter.run({ prompt: harness.subject.prompts.text, signal: AbortSignal.abort(),
      hostOperationId: 'aborted', recordIntent: () => { called = true; } }), 'failed');
    assert.deepEqual(aborted.write, { kind: 'not-dispatched', reason: 'aborted' });
    assert.equal(called, false);

    const closing = adapter.close();
    assert.deepEqual(await adapter.close(), await closing);
    ok(await closing);
    const closed = kind(await harness.segment(adapter, harness.subject.prompts.text), 'failed');
    assert.equal(closed.error.code, 'closed');
    assert.deepEqual(closed.write, { kind: 'not-attempted' });
  });
}

async function interaction(factory: HostConformanceFactory, signal: AbortSignal) {
  await withSubject(factory, signal, async (harness) => {
    const { subject } = harness;
    const adapter = await harness.open();
    const started = (events: readonly HostAdapterEvent[]) => events.findIndex((event) => event.kind === 'tool-call-start');
    const ended = (events: readonly HostAdapterEvent[]) => events.findIndex((event) => event.kind === 'tool-call-end');
    const observed = await collect(adapter, (events) => ended(events) >= 0, signal);
    const pending = kind(await harness.segment(adapter, subject.prompts.toolCall), 'pending');
    assert(Array.isArray(pending.approvals));
    assert.equal(pending.calls.length, 1);
    const [call] = pending.calls as [HostToolCall];
    assert.equal(call.name, subject.tool.name);
    assert.deepEqual(call.pending.target.session, pending.session);
    const events = await observed.settled();
    assert(started(events) >= 0 && started(events) < ended(events), 'tool-call-start precedes tool-call-end');
    const argsAt = events.findIndex((event) => event.kind === 'tool-call-arguments-delta');
    assert(started(events) < argsAt && argsAt < ended(events), 'argument deltas sit between start and end');

    if (adapter.capabilities.inspect.kind === 'supported') {
      const read = ok(await adapter.capabilities.inspect.api.pending(signal));
      assert.deepEqual(read.calls.map((value) => value.pending.target), [call.pending.target]);
    }
    const intents: DispatchIdentity[] = [];
    for (const invalid of [[], [answer(call), answer(call)],
      [answer({ ...call, pending: { kind: 'tool', target: { ...call.pending.target, nativeToolCallId: 'other' } } })]]) {
      const refused = kind(await harness.answer(adapter, invalid, intents), 'failed');
      assert.equal(refused.error.code, 'invalid-input');
      assert.deepEqual(refused.write, { kind: 'not-attempted' });
    }
    assert.equal(intents.length, 0, 'an invalid continuation records no intent');
    const other = await harness.open({ resume: { session: pending.session } });
    const stolen = kind(await harness.answer(other, [answer(call)]), 'failed');
    assert.equal(stolen.write.kind, 'not-attempted', 'pending calls stay with the open segment that produced them');
    const delivered = await collect(adapter, (items) => items.some((event) => event.kind === 'tool-delivery')
      && items.some((event) => event.kind === 'usage'), signal);
    kind(await harness.answer(adapter, [answer(call)]), 'complete');
    const follow = await delivered.settled();
    assert(follow.some((event) => event.kind === 'tool-delivery'), 'tool delivery is its own fact');
    assert(follow.some((event) => event.kind === 'usage'), 'usage is published as its own fact');
    const stale = kind(await harness.answer(adapter, [answer(call)]), 'failed');
    assert.deepEqual(stale.write, { kind: 'not-attempted' });

    const batch = await harness.segment(adapter, subject.prompts.twoToolCalls);
    if (adapter.capabilities.maxPendingPerMessage >= 2) {
      const held = kind(batch, 'pending');
      assert.equal(held.calls.length, 2);
      const [first] = held.calls as readonly [HostToolCall, ...HostToolCall[]];
      const partial = kind(await harness.answer(adapter, [answer(first)]), 'failed');
      assert.equal(partial.error.code, 'invalid-input');
      assert.deepEqual(partial.write, { kind: 'not-attempted' });
      kind(await harness.answer(adapter, held.calls.map(answer)), 'complete');
    } else {
      const limited = kind(batch, 'failed');
      assert.equal(limited.error.code, 'pending-limit', 'a call beyond the limit is never silently lost');
      assert.equal(limited.write.kind, 'accepted', 'pending-limit follows a native write and is not safe to send again');
    }

    if (adapter.capabilities.continuation === 'fresh-process') {
      const fresh = await harness.open();
      const held = kind(await harness.segment(fresh, subject.prompts.toolCall), 'pending');
      ok(await fresh.close());
      const reopened = await harness.open({ resume: { session: held.session } });
      kind(await harness.answer(reopened, held.calls.map(answer)), 'complete');
    }
  });
}

async function history(factory: HostConformanceFactory, signal: AbortSignal) {
  await withSubject(factory, signal, async (harness) => {
    const first = await harness.open();
    const { fingerprint } = first.capabilities;
    if (fingerprint.kind !== 'supported') {
      assert.equal(typeof fingerprint.reason, 'string');
      return;
    }
    const { session } = kind(await harness.segment(first, harness.subject.prompts.text), 'complete');
    if (fingerprint.api.validity === 'after-process-exit') {
      assert.equal((await fingerprint.api.read(signal)).kind, 'error',
        'an after-process-exit fingerprint cannot be read while the segment is open');
    }
    const atEnd = fingerprint.api.validity === 'segment-end' ? ok(await fingerprint.api.read(signal)) : undefined;
    ok(await first.close());
    const reader = await harness.open({ resume: { session } });
    assert(reader.capabilities.fingerprint.kind === 'supported');
    const expected = ok(await reader.capabilities.fingerprint.api.read(signal));
    ok(parseCheckpointReference({ value: expected, session }));
    if (atEnd !== undefined) assert.deepEqual(expected, atEnd, 'a segment-end fingerprint equals the reopened history');
    ok(await reader.close());
    await harness.open({ resume: { session, expectedHistory: expected } });
    const changed = await harness.subject.registration.open({ launch: harness.subject.launch('allow'), tools: [harness.subject.tool],
      resume: { session, expectedHistory: { ...expected, opaque: `${expected.opaque}-changed` } } }, signal);
    assert.equal(changed.kind, 'error');
    assert.equal(changed.error.code, 'history-mismatch');
  });
}

async function interrupt(factory: HostConformanceFactory, signal: AbortSignal) {
  await withSubject(factory, signal, async (harness) => {
    const adapter = await harness.open();
    const { subject } = harness;
    assert.equal((await adapter.interrupt({ timeoutMs: 20 })).kind, 'terminal-observed');
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = adapter.run({ prompt: subject.prompts.text, signal, hostOperationId: 'interrupt', recordIntent: () => gate });
    const during = await adapter.interrupt({ timeoutMs: 20 });
    assert.notEqual(during.kind, 'terminal-observed', 'an active segment has no terminal fact yet');
    assert.equal(during.kind, 'unconfirmed-within-bound',
      'native has not been entered, so it cannot have acknowledged the interrupt');
    assert.equal(subject.launches().signals, 0, 'the adapter never signals a host-owned process');
    release();
    kind(await running, 'complete');
    assert.equal((await adapter.interrupt({ timeoutMs: 20 })).kind, 'terminal-observed');
    kind(await harness.segment(adapter, subject.prompts.toolCall), 'pending');
    const held = await adapter.interrupt({ timeoutMs: 100 });
    assert(['interrupted', 'terminal-observed'].includes(held.kind), 'interrupt follows native-turn lifetime after pending');
    ok(await adapter.close());
    assert.equal(subject.launches().signals, 0, 'the adapter never signals a host-owned process');
  });
}

async function hostLauncher(factory: HostConformanceFactory, signal: AbortSignal) {
  await withSubject(factory, signal, async (harness) => {
    const { subject } = harness;
    const allowed = await harness.open();
    kind(await harness.segment(allowed, subject.prompts.text), 'complete');
    const used = subject.launches().attempts;
    assert(used >= 1, 'the adapter launches through the host launcher');
    const denial = ['unavailable', 'native-failure'];
    const signals = subject.launches().signals;
    const opened = await subject.registration.open({ launch: subject.launch('deny'), tools: [subject.tool] }, signal);
    if (opened.kind === 'ok') {
      try {
        const result = await harness.segment(opened.value, subject.prompts.text);
        assert.equal(result.kind, 'failed', 'a denied launch never falls back to another launch');
        if (result.kind === 'failed') {
          assert(denial.includes(result.error.code), `a denied launch is unavailable or an operation error: ${result.error.code}`);
          assert(result.write.kind === 'not-attempted' || result.write.kind === 'not-dispatched',
            'a denied launch does not start a native write');
        }
      } finally {
        await opened.value.close();
      }
    } else {
      assert(denial.includes(opened.error.code), `a denied launch is unavailable or an operation error: ${opened.error.code}`);
    }
    assert(subject.launches().attempts > used, 'the denied launch went through the host launcher');
    assert.equal(subject.launches().signals, signals, 'a denied launch never signals a host-owned process');
  });
}

export const hostAdapterContracts: HostConformanceContracts = Object.freeze({
  segments, interaction, history, interrupt, 'host-launcher': hostLauncher,
});
