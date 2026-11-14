import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type {
  DispatchIdentity, DispatchObservation, DispatchSnapshot, Outcome, SessionBinding, SessionReference,
} from '../index.js';
import type {
  QualificationConnection, QualificationContracts, QualificationFactory, QualificationFixture, QualificationResult,
  QualificationSubmitError, RecordIntent,
} from './types.js';
import { deferred } from './deferred.js';
import type { Deferred } from './deferred.js';

interface ScenarioOwner {
  wait<T>(promise: PromiseLike<T>): Promise<T>;
  registerObserver(dispose: () => void): void;
  registerHold(release: () => void): void;
  registerCallbackExit(promise: Promise<unknown>): void;
}

const bindingKeys = ['engine', 'nativeVersion', 'account', 'authorizedScope', 'nativeFormat'] satisfies readonly (keyof SessionBinding)[];

function wait<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(signal.reason));
    Promise.resolve(promise).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function scenario(factory: QualificationFactory, signal: AbortSignal,
  body: (fixture: QualificationFixture, owner: ScenarioOwner) => Promise<void>) {
  const observers: (() => void)[] = [];
  const holds: (() => void)[] = [];
  const exits: Promise<[PromiseSettledResult<unknown>]>[] = [];
  const cleanupErrors: unknown[] = [];
  let fixture: QualificationFixture | undefined;
  let primary: { reason: unknown } | undefined;
  const release = (callbacks: (() => void)[]) => {
    for (const callback of callbacks.splice(0)) {
      try { callback(); } catch (error) { cleanupErrors.push(error); }
    }
  };
  const abort = () => {
    release(observers);
    release(holds);
  };
  const register = (callbacks: (() => void)[], callback: () => void) => {
    callbacks.push(callback);
    if (signal.aborted) release(callbacks);
  };
  signal.addEventListener('abort', abort, { once: true });
  const acquisition = Promise.resolve().then(factory).then((value) => { fixture = value; return value; });
  try {
    const acquiredFixture = await wait(acquisition, signal);
    await body(acquiredFixture, {
      wait: (promise) => wait(promise, signal),
      registerObserver: (dispose) => register(observers, dispose),
      registerHold: (release) => register(holds, release),
      registerCallbackExit: (promise) => exits.push(Promise.allSettled([promise])),
    });
  } catch (error) {
    primary = { reason: error };
  } finally {
    abort();
    signal.removeEventListener('abort', abort);
    const [acquired] = await Promise.allSettled([acquisition]);
    if (acquired.status === 'rejected' && (!primary || !Object.is(acquired.reason, primary.reason))) {
      cleanupErrors.push(acquired.reason);
    }
    const cleanup = await Promise.allSettled([
      ...exits.map(async (settlement) => {
        const [result] = await settlement;
        if (result.status === 'rejected') throw result.reason;
      }),
      Promise.resolve().then(() => fixture?.dispose()),
    ]);
    cleanupErrors.push(...cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason));
  }
  if (cleanupErrors.length) {
    throw new AggregateError(primary ? [primary.reason, ...cleanupErrors] : cleanupErrors, 'Scenario cleanup failed.');
  }
  if (primary) throw primary.reason;
}

function simulatedHost(grants: readonly SessionReference[]): RecordIntent {
  const admitted = new Set<string>();
  return (identity) => {
    assert.equal(identity.target.kind, 'session');
    const reference = identity.target.reference;
    const granted = grants.some((grant) => grant.opaque === reference.opaque
      && bindingKeys.every((key) => grant.binding[key] === reference.binding[key]));
    if (!granted) throw new Error('Session is outside the host grant.');
    const key = JSON.stringify(identity);
    if (admitted.has(key)) throw new Error('Host already admitted this command.');
    admitted.add(key);
  };
}

function ok<T, E>(outcome: Outcome<T, E>): T {
  assert.equal(outcome.kind, 'ok');
  return outcome.value;
}

function error<E extends { readonly code: string }>(outcome: Outcome<unknown, E>, code: E['code']) {
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.error.code, code);
}

function counts(fixture: QualificationFixture, dispatchAttempts: number, acceptedEffects: number,
  lookupCalls: number, transportCloses: number, message?: string) {
  assert.deepEqual(fixture.controls.counts(), { dispatchAttempts, acceptedEffects, lookupCalls, transportCloses }, message);
}

function observed<Kind extends DispatchObservation<QualificationResult>['kind']>(
  snapshot: DispatchSnapshot<QualificationResult>, kind: Kind, message?: string,
): asserts snapshot is DispatchSnapshot<QualificationResult> & {
  observation: Extract<DispatchObservation<QualificationResult>, { kind: Kind }>;
} {
  assert.equal(snapshot.observation.kind, kind, message);
}

function conclusive(snapshot: DispatchSnapshot<QualificationResult>, identity: DispatchIdentity):
  asserts snapshot is DispatchSnapshot<QualificationResult> & {
    observation: Extract<DispatchObservation<QualificationResult>, { kind: 'conclusive' }>;
  } {
  observed(snapshot, 'conclusive');
  assert.deepEqual(snapshot.identity, identity);
  const { evidence } = snapshot.observation;
  assert.deepEqual(evidence.identity, identity);
  assert.equal(evidence.source, 'authoritative-native-lookup');
  assert.ok(evidence.nativeOperation);
  assert.equal(typeof evidence.nativeOperation.namespace, 'string');
  assert.ok(evidence.nativeOperation.namespace.length > 0);
  assert.equal(typeof evidence.nativeOperation.id, 'string');
  assert.ok(evidence.nativeOperation.id.length > 0);
  assert.equal(evidence.observation.namespace, evidence.nativeOperation.namespace);
  assert.equal(evidence.observation.schemaVersion, 1);
  assert.ok(Object.hasOwn(evidence.observation, 'data'));
  assert.ok(Object.hasOwn(snapshot.observation, 'result'));
}

async function uncertainty(factory: QualificationFactory, signal: AbortSignal) {
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const host = simulatedHost([a, b]);
    const first = fixture.connect(host);
    fixture.controls.loseNextAcknowledgement();
    const original = ok(await owner.wait(first.submit({ session: a, hostOperationId: 'lost' }, signal)));
    observed(original, 'outcome-unknown', 'lost acknowledgement must remain outcome-unknown');
    const saved = structuredClone(original);
    counts(fixture, 1, 1, 0, 0);
    ok(await owner.wait(first.close()));
    const next = fixture.connect(host);
    const recovery = next.recover(original);
    assert.equal(typeof recovery.reconcile, 'function');
    assert.equal('run' in recovery, false);
    assert.equal('dispatchNative' in recovery, false);
    counts(fixture, 1, 1, 0, 1);
    fixture.controls.lookupVisibility('unknown');
    const hidden = ok(await owner.wait(recovery.reconcile(signal)));
    observed(hidden, 'outcome-unknown');
    counts(fixture, 1, 1, 1, 1, 'reconciliation cannot dispatch');
    const blocked = ok(await owner.wait(next.submit({ session: a, hostOperationId: 'lost' }, signal)));
    assert.deepEqual(blocked.observation, { kind: 'not-dispatched', reason: 'intent-failed' });
    counts(fixture, 1, 1, 1, 1);
    fixture.controls.lookupVisibility('authoritative');
    const found = ok(await owner.wait(recovery.reconcile(signal)));
    conclusive(found, original.identity);
    counts(fixture, 1, 1, 2, 1);
    assert.deepEqual(ok(await owner.wait(recovery.reconcile(signal))), found);
    counts(fixture, 1, 1, 2, 1);
    assert.deepEqual(original, saved);
    ok(await owner.wait(next.close()));
    counts(fixture, 1, 1, 2, 2);
  });
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const host = simulatedHost([a, b]);
    const first = fixture.connect(host);
    const held = fixture.controls.holdNextCompletion();
    owner.registerHold(held.release);
    let completed = false;
    const original = ok(await owner.wait(first.submit({ session: a, hostOperationId: 'accepted' }, signal)));
    await owner.wait(held.entered);
    owner.registerCallbackExit(held.completed.then(() => { completed = true; }));
    observed(original, 'accepted');
    assert.equal(original.observation.evidence.source, 'native-acknowledgement');
    const saved = structuredClone(original);
    ok(await owner.wait(first.close()));
    await owner.wait(setImmediate());
    assert.equal(completed, false);
    const next = fixture.connect(host);
    error(await owner.wait(next.submit({ session: a, hostOperationId: 'while-held' }, signal)), 'busy');
    counts(fixture, 1, 1, 0, 1);
    const recovery = next.recover(original);
    fixture.controls.lookupVisibility('unknown');
    assert.deepEqual(ok(await owner.wait(recovery.reconcile(signal))), original);
    counts(fixture, 1, 1, 1, 1);
    held.release();
    await owner.wait(held.completed);
    fixture.controls.lookupVisibility('authoritative');
    const found = ok(await owner.wait(recovery.reconcile(signal)));
    conclusive(found, original.identity);
    assert.deepEqual(found.observation.evidence.nativeOperation, original.observation.evidence.nativeOperation);
    counts(fixture, 1, 1, 2, 1);
    assert.deepEqual(original, saved);
  });
}

async function sessions(factory: QualificationFactory, signal: AbortSignal) {
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const host = simulatedHost([a, b]);
    const first = fixture.connect(host);
    const next = fixture.connect(host);
    for (const key of bindingKeys) {
      const session = { ...a, binding: { ...a.binding, [key]: `${a.binding[key]}-wrong` } };
      error(await owner.wait(first.submit({ session, hostOperationId: `wrong-${key}` }, signal)), 'binding-mismatch');
    }
    const checkpoint = { ...a, kind: 'checkpoint', sessionOpaque: a.opaque };
    error(await owner.wait(first.submit({ session: checkpoint, hostOperationId: 'checkpoint' }, signal)), 'invalid-reference');
    error(await owner.wait(first.submit({ session: { ...a, opaque: 'invented' }, hostOperationId: 'missing' }, signal)), 'missing-session');
    counts(fixture, 0, 0, 0, 0);
    const held = fixture.controls.holdNextCompletion();
    owner.registerHold(held.release);
    const winnerPromise = first.submit({ session: a, hostOperationId: 'concurrent-1' }, signal);
    const loserPromise = next.submit({ session: a, hostOperationId: 'concurrent-2' }, signal);
    const [winner, loser] = await owner.wait(Promise.all([winnerPromise, loserPromise]));
    assert.equal(ok(winner).observation.kind, 'accepted');
    error(loser, 'busy');
    await owner.wait(held.entered);
    counts(fixture, 1, 1, 0, 0);
    const distinct = ok(await owner.wait(next.submit({ session: b, hostOperationId: 'distinct' }, signal)));
    observed(distinct, 'conclusive');
    counts(fixture, 2, 2, 0, 0);
    held.release();
    await owner.wait(held.completed);
    const after = ok(await owner.wait(next.submit({ session: a, hostOperationId: 'after-completion' }, signal)));
    observed(after, 'conclusive');
    counts(fixture, 3, 3, 0, 0);
    const restricted = fixture.connect(simulatedHost([a]));
    const forbidden = ok(await owner.wait(restricted.submit({ session: b, hostOperationId: 'forbidden' }, signal)));
    assert.deepEqual(forbidden.observation, { kind: 'not-dispatched', reason: 'intent-failed' });
    counts(fixture, 3, 3, 0, 0);
    const granted = ok(await owner.wait(next.submit({ session: b, hostOperationId: 'granted' }, signal)));
    observed(granted, 'conclusive');
    counts(fixture, 4, 4, 0, 0);
  });
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const permissive = fixture.connect(() => {});
    fixture.controls.loseNextAcknowledgement();
    const saved = ok(await owner.wait(permissive.submit({ session: a, hostOperationId: 'duplicate' }, signal)));
    observed(saved, 'outcome-unknown');
    const second = ok(await owner.wait(permissive.submit({ session: a, hostOperationId: 'duplicate' }, signal)));
    observed(second, 'conclusive');
    counts(fixture, 2, 2, 0, 0);
    const ambiguous = ok(await owner.wait(permissive.recover(saved).reconcile(signal)));
    observed(ambiguous, 'outcome-unknown');
    counts(fixture, 2, 2, 1, 0);
    const admitting = fixture.connect(simulatedHost([a, b]));
    const first = ok(await owner.wait(admitting.submit({ session: b, hostOperationId: 'admitted' }, signal)));
    observed(first, 'conclusive');
    const repeat = ok(await owner.wait(admitting.submit({ session: b, hostOperationId: 'admitted' }, signal)));
    assert.deepEqual(repeat.observation, { kind: 'not-dispatched', reason: 'intent-failed' });
    counts(fixture, 3, 3, 1, 0);
  });
}

async function interaction(factory: QualificationFactory, signal: AbortSignal) {
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b, approval, tool } = fixture.samples;
    const connection = fixture.connect(simulatedHost([a, b]));
    fixture.controls.pending(approval);
    const [choice] = approval.choices;
    assert.ok(choice);
    const reply = { formatVersion: 1, kind: 'approval', target: approval.target,
      nativeChoiceId: choice.nativeChoiceId };
    const wrongTargets: [unknown, QualificationSubmitError['code']][] = [
      ...(['account', 'authorizedScope'] satisfies (keyof SessionBinding)[]).map<[unknown, QualificationSubmitError['code']]>((key) => [{ ...reply.target,
        session: { ...a, binding: { ...a.binding, [key]: `${a.binding[key]}-wrong` } } }, 'binding-mismatch']),
      [{ ...reply.target, session: b }, 'session-mismatch'],
      [{ ...reply.target, nativeApprovalId: 'wrong-approval' }, 'target-mismatch'],
      [{ ...reply.target, tool: { nativeToolCallId: 'wrong-tool' } }, 'target-mismatch'],
    ];
    for (const [target, code] of wrongTargets) {
      error(await owner.wait(connection.submit({ session: a, hostOperationId: `invalid-${code}`,
        continuation: structuredClone({ ...reply, target }) }, signal)), code);
      counts(fixture, 0, 0, 0, 0, 'invalid approval must not dispatch');
    }
    error(await owner.wait(connection.submit({ session: a, hostOperationId: 'invalid-choice',
      continuation: structuredClone({ ...reply, nativeChoiceId: 'unadvertised' }) }, signal)), 'choice-mismatch');
    counts(fixture, 0, 0, 0, 0);
    const held = fixture.controls.holdNextCompletion();
    owner.registerHold(held.release);
    const acknowledged = ok(await owner.wait(connection.submit({ session: a,
      hostOperationId: 'approval', continuation: structuredClone(reply) }, signal)));
    await owner.wait(held.entered);
    observed(acknowledged, 'accepted');
    error(await owner.wait(connection.submit({ session: a,
      hostOperationId: 'approval-again', continuation: structuredClone(reply) }, signal)), 'stale-interaction');
    counts(fixture, 1, 1, 0, 0, 'approval is consumed at native acceptance');
    held.release();
    await owner.wait(held.completed);
    const accepted = ok(await owner.wait(connection.recover(acknowledged).reconcile(signal)));
    observed(accepted, 'conclusive');
    assert.deepEqual(accepted.observation.result.continuation, reply);
    const native = { namespace: connection.identity.adapter, schemaVersion: 1, data: { failed: true } };
    const toolReply = { formatVersion: 1, kind: 'tool', outcome: { target: tool.target,
      result: { kind: 'error', error: native }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
    fixture.controls.pending(tool);
    error(await owner.wait(connection.submit({ session: a, hostOperationId: 'invalid-tool',
      continuation: structuredClone({ ...toolReply, outcome: { ...toolReply.outcome,
        target: { ...tool.target, nativeToolCallId: 'wrong-tool' } } }) }, signal)), 'target-mismatch');
    counts(fixture, 1, 1, 1, 0, 'invalid tool must not dispatch');
    const effectEvidence = { ...native, data: { effect: 'observed' } };
    const deliveryEvidence = { ...native, data: { delivery: 'acknowledged' } };
    const effects = [{ kind: 'unknown' }, { kind: 'known', effect: 'occurred', evidence: effectEvidence }];
    const deliveries = [{ kind: 'unknown' }, { kind: 'confirmed', evidence: deliveryEvidence }];
    const continuations = effects.flatMap((effect) => deliveries.map((delivery) =>
      ({ ...toolReply, outcome: { ...toolReply.outcome, effect, delivery } })));
    for (const [index, continuation] of continuations.entries()) {
      if (index > 0) fixture.controls.pending(tool);
      const toolHeld = fixture.controls.holdNextCompletion();
      owner.registerHold(toolHeld.release);
      const toolAcknowledged = ok(await owner.wait(connection.submit({ session: a,
        hostOperationId: `tool-${index}`, continuation: structuredClone(continuation) }, signal)));
      await owner.wait(toolHeld.entered);
      observed(toolAcknowledged, 'accepted');
      error(await owner.wait(connection.submit({ session: a, hostOperationId: `tool-again-${index}`,
        continuation: structuredClone(continuation) }, signal)), 'stale-interaction');
      counts(fixture, index + 2, index + 2, index + 1, 0, 'tool is consumed at native acceptance');
      toolHeld.release();
      await owner.wait(toolHeld.completed);
      const result = ok(await owner.wait(connection.recover(toolAcknowledged).reconcile(signal)));
      observed(result, 'conclusive');
      assert.deepEqual(result.observation.result.continuation, continuation,
        'native result, effect and delivery remain independent');
      error(await owner.wait(connection.submit({ session: a, hostOperationId: `tool-completed-${index}`,
        continuation: structuredClone(continuation) }, signal)), 'stale-interaction');
      counts(fixture, index + 2, index + 2, index + 2, 0, 'completed tool remains consumed');
    }
  });
}

function gatedObserver(events: QualificationConnection['events'], owner: ScenarioOwner) {
  const entered = deferred();
  const release = deferred();
  const exited = deferred();
  const input = new AbortController();
  const values: number[] = [];
  const errors: unknown[] = [];
  const activity = { active: 0, maximum: 0 };
  let delivery: AbortSignal | undefined;
  owner.registerHold(release.resolve);
  const subscription = ok(events.subscribe(async (event, deliverySignal) => {
    owner.registerCallbackExit(exited.promise);
    activity.active++;
    activity.maximum = Math.max(activity.maximum, activity.active);
    values.push(event.sequence);
    delivery = deliverySignal;
    entered.resolve();
    try { await owner.wait(release.promise); } catch (error) { errors.push(error); }
    finally { activity.active--; exited.resolve(); }
  }, { signal: input.signal }));
  owner.registerObserver(subscription.dispose);
  return {
    subscription, input, values, errors, activity, entered: entered.promise,
    delivery() { assert.ok(delivery); return delivery; },
    async releaseAndDrain() {
      release.resolve();
      await owner.wait(exited.promise);
      await owner.wait(setImmediate());
    },
  };
}

async function assertDetached(gated: ReturnType<typeof gatedObserver>, events: QualificationConnection['events'],
  owner: ScenarioOwner, reason: 'aborted' | 'overflow' | 'disposed') {
  assert.equal(await owner.wait(gated.subscription.ended), reason);
  assert.equal(gated.delivery().aborted, true);
  assert.equal(getEventListeners(gated.input.signal, 'abort').length, 0);
  error(events.subscribe(() => {}), 'capacity');
  await gated.releaseAndDrain();
  assert.deepEqual<unknown[]>(gated.errors, []);
}

async function subscriptionAbort(fixture: QualificationFixture, owner: ScenarioOwner, signal: AbortSignal) {
  const connection = fixture.connect(simulatedHost([fixture.samples.a]));
  const held = fixture.controls.holdNextCompletion();
  owner.registerHold(held.release);
  const accepted = ok(await owner.wait(connection.submit({ session: fixture.samples.a,
    hostOperationId: 'subscription-abort-work' }, signal)));
  await owner.wait(held.entered);
  observed(accepted, 'accepted');
  let completed = false;
  owner.registerCallbackExit(held.completed.then(() => { completed = true; }));
  const slow = gatedObserver(connection.events, owner);
  const fastValues: number[] = [];
  const seen: [Deferred, Deferred, Deferred] = [deferred(), deferred(), deferred()];
  const fast = ok(connection.events.subscribe((event) => {
    fastValues.push(event.sequence);
    seen[event.sequence - 1]?.resolve();
  }));
  owner.registerObserver(fast.dispose);
  fixture.controls.emit(1);
  await owner.wait(slow.entered);
  await owner.wait(seen[0].promise);
  fixture.controls.emit(2);
  await owner.wait(seen[1].promise);
  assert.deepEqual(slow.values, [1], 'second delivery queues behind the active callback');
  slow.input.abort();
  await assertDetached(slow, connection.events, owner, 'aborted');
  assert.deepEqual(slow.values, [1], 'input abort drops queued events');
  const renewed = ok(connection.events.subscribe(() => {}));
  owner.registerObserver(renewed.dispose);
  fixture.controls.emit(3);
  await owner.wait(seen[2].promise);
  assert.deepEqual(fastValues, [1, 2, 3], 'input abort leaves other observers attached');
  assert.equal(completed, false, 'input abort cannot complete native work');
  counts(fixture, 1, 1, 0, 0);
  held.release();
  await owner.wait(held.completed);
  const result = ok(await owner.wait(connection.recover(accepted).reconcile(signal)));
  conclusive(result, accepted.identity);
  counts(fixture, 1, 1, 1, 0);
}

async function fifoDelivery(fixture: QualificationFixture, owner: ScenarioOwner) {
  const first = fixture.connect(simulatedHost([fixture.samples.a]));
  const entered = deferred();
  const release = deferred();
  const exited = deferred();
  const secondDelivered = deferred();
  const values: number[] = [];
  const callbackErrors: unknown[] = [];
  let active = 0;
  let maximum = 0;
  owner.registerHold(release.resolve);
  const observer = ok(first.events.subscribe(async (event) => {
    const callbackExit = deferred();
    owner.registerCallbackExit(callbackExit.promise);
    active++;
    maximum = Math.max(maximum, active);
    values.push(event.sequence);
    try {
      if (event.sequence === 1) {
        entered.resolve();
        await owner.wait(release.promise);
      } else {
        secondDelivered.resolve();
      }
    } catch (error) { callbackErrors.push(error); }
    finally {
      active--;
      callbackExit.resolve();
      if (event.sequence === 1) exited.resolve();
    }
  }));
  owner.registerObserver(observer.dispose);
  fixture.controls.emit(1);
  await owner.wait(entered.promise);
  fixture.controls.emit(2);
  assert.deepEqual(values, [1], 'queued callback waits for the active callback');
  release.resolve();
  await owner.wait(exited.promise);
  await owner.wait(secondDelivered.promise);
  assert.deepEqual(values, [1, 2], 'slow observer drains queued events in order');
  assert.equal(maximum, 1, 'observer callbacks do not overlap');
  await owner.wait(setImmediate());
  assert.equal(active, 0);
  assert.deepEqual<unknown[]>(callbackErrors, []);
  observer.dispose();
  assert.equal(await owner.wait(observer.ended), 'disposed');
  counts(fixture, 0, 0, 0, 0);
}

async function overflowAndLifecycle(fixture: QualificationFixture, owner: ScenarioOwner, signal: AbortSignal) {
  const { a, b } = fixture.samples;
  const host = simulatedHost([a, b]);
  const first = fixture.connect(host);
  const held = fixture.controls.holdNextCompletion();
  owner.registerHold(held.release);
  fixture.controls.loseNextAcknowledgement();
  const saved = ok(await owner.wait(first.submit({ session: a, hostOperationId: 'event-work' }, signal)));
  await owner.wait(held.entered);
  observed(saved, 'outcome-unknown');
  let completed = false;
  owner.registerCallbackExit(held.completed.then(() => { completed = true; }));
  fixture.controls.emit(0);
  const slow = gatedObserver(first.events, owner);
  const fastValues: number[] = [];
  const seen: [Deferred, Deferred, Deferred, Deferred, Deferred] =
    [deferred(), deferred(), deferred(), deferred(), deferred()];
  const fast = ok(first.events.subscribe((event) => {
    fastValues.push(event.sequence);
    seen[event.sequence - 1]?.resolve();
  }));
  owner.registerObserver(fast.dispose);
  fixture.controls.emit(1);
  await owner.wait(slow.entered);
  await owner.wait(seen[0].promise);
  fixture.controls.emit(2);
  await owner.wait(seen[1].promise);
  fixture.controls.emit(3);
  await owner.wait(seen[2].promise);
  assert.deepEqual(fastValues, [1, 2, 3]);
  assert.deepEqual(slow.values, [1]);
  await assertDetached(slow, first.events, owner, 'overflow');
  assert.deepEqual(slow.values, [1], 'overflow drops queued events');
  assert.equal(slow.activity.maximum, 1);
  assert.equal(slow.activity.active, 0);
  const throwing = ok(first.events.subscribe(() => { throw new Error('Observer failed.'); }));
  owner.registerObserver(throwing.dispose);
  fixture.controls.emit(4);
  await owner.wait(seen[3].promise);
  assert.equal(await owner.wait(throwing.ended), 'listener-error');
  await owner.wait(setImmediate());
  const disposed = gatedObserver(first.events, owner);
  fixture.controls.emit(5);
  await owner.wait(disposed.entered);
  await owner.wait(seen[4].promise);
  disposed.subscription.dispose();
  await assertDetached(disposed, first.events, owner, 'disposed');
  assert.deepEqual(fastValues, [1, 2, 3, 4, 5]);
  const renewed = ok(first.events.subscribe(() => {}));
  owner.registerObserver(renewed.dispose);
  renewed.dispose();
  assert.equal(await owner.wait(renewed.ended), 'disposed');
  fast.dispose();
  assert.equal(await owner.wait(fast.ended), 'disposed');
  assert.equal(completed, false, 'observer lifecycle cannot complete native work');
  counts(fixture, 1, 1, 0, 0);
  const closing = first.close();
  assert.equal(first.close(), closing, 'close() must return the same promise');
  const [one, two] = await owner.wait(Promise.all([closing, first.close()]));
  assert.equal(one, two, 'close() must settle to the same outcome object');
  ok(one);
  error(first.events.subscribe(() => {}), 'closed');
  error(await owner.wait(first.submit({ session: a, hostOperationId: 'closed' }, signal)), 'closed');
  error(await owner.wait(first.recover(saved).reconcile(signal)), 'lookup-failed');
  counts(fixture, 1, 1, 0, 1);
  assert.equal(completed, false, 'transport close cannot complete native work');
  held.release();
  await owner.wait(held.completed);
  assert.equal(completed, true);
  const next = fixture.connect(host);
  const nextValues: number[] = [];
  const nextSeen = deferred();
  const observer = ok(next.events.subscribe((event) => {
    nextValues.push(event.sequence);
    nextSeen.resolve();
  }));
  owner.registerObserver(observer.dispose);
  fixture.controls.emit(6);
  await owner.wait(nextSeen.promise);
  assert.deepEqual(nextValues, [6], 'reconnect does not replay events');
  ok(await owner.wait(next.close()));
  assert.equal(await owner.wait(observer.ended), 'closed');
  counts(fixture, 1, 1, 0, 2);
}

async function events(factory: QualificationFactory, signal: AbortSignal) {
  await scenario(factory, signal, (fixture, owner) => subscriptionAbort(fixture, owner, signal));
  await scenario(factory, signal, fifoDelivery);
  await scenario(factory, signal, (fixture, owner) => overflowAndLifecycle(fixture, owner, signal));
}

export const contracts: QualificationContracts = Object.freeze({ uncertainty, sessions, interaction, events });
