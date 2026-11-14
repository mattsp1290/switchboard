import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers/promises';

function wait(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function scenario(factory, signal, body) {
  const observers = [];
  const holds = [];
  const exits = [];
  const cleanupErrors = [];
  let fixture;
  let primary;
  const release = (callbacks) => {
    for (const callback of callbacks.splice(0)) {
      try { callback(); } catch (error) { cleanupErrors.push(error); }
    }
  };
  const abort = () => {
    release(observers);
    release(holds);
  };
  const register = (callbacks, callback) => {
    callbacks.push(callback);
    if (signal.aborted) release(callbacks);
  };
  signal.addEventListener('abort', abort, { once: true });
  const acquisition = Promise.resolve().then(factory).then((value) => { fixture = value; });
  try {
    await wait(acquisition, signal);
    await body(fixture, {
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

function simulatedHost(grants) {
  const admitted = new Set();
  return (identity) => {
    const reference = identity.target.reference;
    const granted = grants.some((grant) => grant.opaque === reference.opaque
      && Object.keys(grant.binding).every((key) => grant.binding[key] === reference.binding[key]));
    if (!granted) throw new Error('Session is outside the host grant.');
    const key = JSON.stringify(identity);
    if (admitted.has(key)) throw new Error('Host already admitted this command.');
    admitted.add(key);
  };
}

function ok(outcome) {
  assert.equal(outcome.kind, 'ok');
  return outcome.value;
}

function error(outcome, code) {
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.error.code, code);
}

function counts(fixture, dispatchAttempts, acceptedEffects, lookupCalls, transportCloses, message) {
  assert.deepEqual(fixture.controls.counts(), { dispatchAttempts, acceptedEffects, lookupCalls, transportCloses }, message);
}

function conclusive(snapshot, identity) {
  assert.equal(snapshot.observation.kind, 'conclusive');
  assert.deepEqual(snapshot.identity, identity);
  const { evidence } = snapshot.observation;
  assert.deepEqual(evidence.identity, identity);
  assert.equal(evidence.source, 'authoritative-native-lookup');
  assert.equal(typeof evidence.nativeOperation.namespace, 'string');
  assert.ok(evidence.nativeOperation.namespace.length > 0);
  assert.equal(typeof evidence.nativeOperation.id, 'string');
  assert.ok(evidence.nativeOperation.id.length > 0);
  assert.equal(evidence.observation.namespace, evidence.nativeOperation.namespace);
  assert.equal(evidence.observation.schemaVersion, 1);
  assert.ok(Object.hasOwn(evidence.observation, 'data'));
  assert.ok(Object.hasOwn(snapshot.observation, 'result'));
}

async function uncertainty(factory, signal) {
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const host = simulatedHost([a, b]);
    const first = fixture.connect(host);
    fixture.controls.loseNextAcknowledgement();
    const original = ok(await owner.wait(first.submit({ session: a, hostOperationId: 'lost' }, signal)));
    assert.equal(original.observation.kind, 'outcome-unknown', 'lost acknowledgement must remain outcome-unknown');
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
    assert.equal(hidden.observation.kind, 'outcome-unknown');
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
    assert.equal(original.observation.kind, 'accepted');
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

async function sessions(factory, signal) {
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const host = simulatedHost([a, b]);
    const first = fixture.connect(host);
    const next = fixture.connect(host);
    for (const key of ['engine', 'nativeVersion', 'account', 'authorizedScope', 'nativeFormat']) {
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
    assert.equal(distinct.observation.kind, 'conclusive');
    counts(fixture, 2, 2, 0, 0);
    held.release();
    await owner.wait(held.completed);
    const after = ok(await owner.wait(next.submit({ session: a, hostOperationId: 'after-completion' }, signal)));
    assert.equal(after.observation.kind, 'conclusive');
    counts(fixture, 3, 3, 0, 0);
    const restricted = fixture.connect(simulatedHost([a]));
    const forbidden = ok(await owner.wait(restricted.submit({ session: b, hostOperationId: 'forbidden' }, signal)));
    assert.deepEqual(forbidden.observation, { kind: 'not-dispatched', reason: 'intent-failed' });
    counts(fixture, 3, 3, 0, 0);
    const granted = ok(await owner.wait(next.submit({ session: b, hostOperationId: 'granted' }, signal)));
    assert.equal(granted.observation.kind, 'conclusive');
    counts(fixture, 4, 4, 0, 0);
  });
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const permissive = fixture.connect(() => {});
    fixture.controls.loseNextAcknowledgement();
    const saved = ok(await owner.wait(permissive.submit({ session: a, hostOperationId: 'duplicate' }, signal)));
    assert.equal(saved.observation.kind, 'outcome-unknown');
    const second = ok(await owner.wait(permissive.submit({ session: a, hostOperationId: 'duplicate' }, signal)));
    assert.equal(second.observation.kind, 'conclusive');
    counts(fixture, 2, 2, 0, 0);
    const ambiguous = ok(await owner.wait(permissive.recover(saved).reconcile(signal)));
    assert.equal(ambiguous.observation.kind, 'outcome-unknown');
    counts(fixture, 2, 2, 1, 0);
    const admitting = fixture.connect(simulatedHost([a, b]));
    const first = ok(await owner.wait(admitting.submit({ session: b, hostOperationId: 'admitted' }, signal)));
    assert.equal(first.observation.kind, 'conclusive');
    const repeat = ok(await owner.wait(admitting.submit({ session: b, hostOperationId: 'admitted' }, signal)));
    assert.deepEqual(repeat.observation, { kind: 'not-dispatched', reason: 'intent-failed' });
    counts(fixture, 3, 3, 1, 0);
  });
}

async function interaction(factory, signal) {
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b, approval, tool } = fixture.samples;
    const connection = fixture.connect(simulatedHost([a, b]));
    fixture.controls.pending(approval);
    const reply = { formatVersion: 1, kind: 'approval', target: approval.target,
      nativeChoiceId: approval.choices[0].nativeChoiceId };
    const wrongTargets = [
      ...['account', 'authorizedScope'].map((key) => [{ ...reply.target,
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
    assert.equal(acknowledged.observation.kind, 'accepted');
    error(await owner.wait(connection.submit({ session: a,
      hostOperationId: 'approval-again', continuation: structuredClone(reply) }, signal)), 'stale-interaction');
    counts(fixture, 1, 1, 0, 0, 'approval is consumed at native acceptance');
    held.release();
    await owner.wait(held.completed);
    const accepted = ok(await owner.wait(connection.recover(acknowledged).reconcile(signal)));
    assert.equal(accepted.observation.kind, 'conclusive');
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
      assert.equal(toolAcknowledged.observation.kind, 'accepted');
      error(await owner.wait(connection.submit({ session: a, hostOperationId: `tool-again-${index}`,
        continuation: structuredClone(continuation) }, signal)), 'stale-interaction');
      counts(fixture, index + 2, index + 2, index + 1, 0, 'tool is consumed at native acceptance');
      toolHeld.release();
      await owner.wait(toolHeld.completed);
      const result = ok(await owner.wait(connection.recover(toolAcknowledged).reconcile(signal)));
      assert.equal(result.observation.kind, 'conclusive');
      assert.deepEqual(result.observation.result.continuation, continuation,
        'native result, effect and delivery remain independent');
      error(await owner.wait(connection.submit({ session: a, hostOperationId: `tool-completed-${index}`,
        continuation: structuredClone(continuation) }, signal)), 'stale-interaction');
      counts(fixture, index + 2, index + 2, index + 2, 0, 'completed tool remains consumed');
    }
  });
}

async function events(factory, signal) {
  await scenario(factory, signal, async (fixture, owner) => {
    const connection = fixture.connect(simulatedHost([fixture.samples.a]));
    const held = fixture.controls.holdNextCompletion();
    owner.registerHold(held.release);
    const accepted = ok(await owner.wait(connection.submit({ session: fixture.samples.a,
      hostOperationId: 'subscription-abort-work' }, signal)));
    await owner.wait(held.entered);
    assert.equal(accepted.observation.kind, 'accepted');
    let completed = false;
    owner.registerCallbackExit(held.completed.then(() => { completed = true; }));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const exited = Promise.withResolvers();
    owner.registerHold(release.resolve);
    const input = new AbortController();
    const slowValues = [];
    const fastValues = [];
    const callbackErrors = [];
    const seen = new Map([1, 2, 3].map((sequence) => [sequence, Promise.withResolvers()]));
    let delivery;
    const slow = ok(connection.events.subscribe(async (event, deliverySignal) => {
      owner.registerCallbackExit(exited.promise);
      slowValues.push(event.sequence);
      delivery = deliverySignal;
      entered.resolve();
      try { await owner.wait(release.promise); } catch (error) { callbackErrors.push(error); }
      finally { exited.resolve(); }
    }, { signal: input.signal }));
    owner.registerObserver(slow.dispose);
    const fast = ok(connection.events.subscribe((event) => {
      fastValues.push(event.sequence);
      seen.get(event.sequence)?.resolve();
    }));
    owner.registerObserver(fast.dispose);
    fixture.controls.emit(1);
    await owner.wait(entered.promise);
    await owner.wait(seen.get(1).promise);
    fixture.controls.emit(2);
    await owner.wait(seen.get(2).promise);
    assert.deepEqual(slowValues, [1], 'second delivery queues behind the active callback');
    input.abort();
    assert.equal(await owner.wait(slow.ended), 'aborted');
    assert.equal(delivery.aborted, true);
    assert.equal(getEventListeners(input.signal, 'abort').length, 0);
    error(connection.events.subscribe(() => {}), 'capacity');
    release.resolve();
    await owner.wait(exited.promise);
    await owner.wait(setImmediate());
    assert.deepEqual(callbackErrors, []);
    assert.deepEqual(slowValues, [1], 'input abort drops queued events');
    const renewed = ok(connection.events.subscribe(() => {}));
    owner.registerObserver(renewed.dispose);
    fixture.controls.emit(3);
    await owner.wait(seen.get(3).promise);
    assert.deepEqual(fastValues, [1, 2, 3], 'input abort leaves other observers attached');
    assert.equal(completed, false, 'input abort cannot complete native work');
    counts(fixture, 1, 1, 0, 0);
    held.release();
    await owner.wait(held.completed);
    const result = ok(await owner.wait(connection.recover(accepted).reconcile(signal)));
    conclusive(result, accepted.identity);
    counts(fixture, 1, 1, 1, 0);
  });
  await scenario(factory, signal, async (fixture, owner) => {
    const first = fixture.connect(simulatedHost([fixture.samples.a]));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const exited = Promise.withResolvers();
    const secondDelivered = Promise.withResolvers();
    const values = [];
    const callbackErrors = [];
    let active = 0;
    let maximum = 0;
    owner.registerHold(release.resolve);
    const observer = ok(first.events.subscribe(async (event) => {
      const callbackExit = Promise.withResolvers();
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
    assert.deepEqual(callbackErrors, []);
    observer.dispose();
    assert.equal(await owner.wait(observer.ended), 'disposed');
    counts(fixture, 0, 0, 0, 0);
  });
  await scenario(factory, signal, async (fixture, owner) => {
    const { a, b } = fixture.samples;
    const host = simulatedHost([a, b]);
    const first = fixture.connect(host);
    const held = fixture.controls.holdNextCompletion();
    owner.registerHold(held.release);
    fixture.controls.loseNextAcknowledgement();
    const saved = ok(await owner.wait(first.submit({ session: a, hostOperationId: 'event-work' }, signal)));
    await owner.wait(held.entered);
    assert.equal(saved.observation.kind, 'outcome-unknown');
    let completed = false;
    owner.registerCallbackExit(held.completed.then(() => { completed = true; }));
    fixture.controls.emit(0);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const exited = Promise.withResolvers();
    owner.registerHold(release.resolve);
    const input = new AbortController();
    const slowValues = [];
    const fastValues = [];
    const callbackErrors = [];
    const seen = new Map([1, 2, 3, 4, 5].map((sequence) => [sequence, Promise.withResolvers()]));
    let active = 0;
    let maximum = 0;
    let delivery;
    const slow = ok(first.events.subscribe(async (event, deliverySignal) => {
      owner.registerCallbackExit(exited.promise);
      active++;
      maximum = Math.max(maximum, active);
      slowValues.push(event.sequence);
      delivery = deliverySignal;
      entered.resolve();
      try { await owner.wait(release.promise); } catch (error) { callbackErrors.push(error); }
      finally { active--; exited.resolve(); }
    }, { signal: input.signal }));
    owner.registerObserver(slow.dispose);
    const fast = ok(first.events.subscribe((event) => {
      fastValues.push(event.sequence);
      seen.get(event.sequence)?.resolve();
    }));
    owner.registerObserver(fast.dispose);
    fixture.controls.emit(1);
    await owner.wait(entered.promise);
    await owner.wait(seen.get(1).promise);
    fixture.controls.emit(2);
    await owner.wait(seen.get(2).promise);
    fixture.controls.emit(3);
    await owner.wait(seen.get(3).promise);
    assert.deepEqual(fastValues, [1, 2, 3]);
    assert.deepEqual(slowValues, [1]);
    assert.equal(await owner.wait(slow.ended), 'overflow');
    assert.equal(delivery.aborted, true);
    assert.equal(getEventListeners(input.signal, 'abort').length, 0);
    error(first.events.subscribe(() => {}), 'capacity');
    release.resolve();
    await owner.wait(exited.promise);
    await owner.wait(setImmediate());
    assert.deepEqual(callbackErrors, []);
    assert.deepEqual(slowValues, [1], 'overflow drops queued events');
    assert.equal(maximum, 1);
    assert.equal(active, 0);
    const throwing = ok(first.events.subscribe(() => { throw new Error('Observer failed.'); }));
    owner.registerObserver(throwing.dispose);
    fixture.controls.emit(4);
    await owner.wait(seen.get(4).promise);
    assert.equal(await owner.wait(throwing.ended), 'listener-error');
    await owner.wait(setImmediate());
    const disposalEntered = Promise.withResolvers();
    const disposalRelease = Promise.withResolvers();
    const disposalExit = Promise.withResolvers();
    owner.registerHold(disposalRelease.resolve);
    const disposalInput = new AbortController();
    let disposalDelivery;
    const disposed = ok(first.events.subscribe(async (_, deliverySignal) => {
      owner.registerCallbackExit(disposalExit.promise);
      disposalDelivery = deliverySignal;
      disposalEntered.resolve();
      try { await owner.wait(disposalRelease.promise); } catch (error) { callbackErrors.push(error); }
      finally { disposalExit.resolve(); }
    }, { signal: disposalInput.signal }));
    owner.registerObserver(disposed.dispose);
    fixture.controls.emit(5);
    await owner.wait(disposalEntered.promise);
    await owner.wait(seen.get(5).promise);
    disposed.dispose();
    assert.equal(await owner.wait(disposed.ended), 'disposed');
    assert.equal(disposalDelivery.aborted, true);
    assert.equal(getEventListeners(disposalInput.signal, 'abort').length, 0);
    error(first.events.subscribe(() => {}), 'capacity');
    disposalRelease.resolve();
    await owner.wait(disposalExit.promise);
    await owner.wait(setImmediate());
    assert.deepEqual(callbackErrors, []);
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
    assert.equal(first.close(), closing);
    const [one, two] = await owner.wait(Promise.all([closing, first.close()]));
    assert.equal(one, two);
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
    const nextValues = [];
    const nextSeen = Promise.withResolvers();
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
  });
}

export const contracts = { uncertainty, sessions, interaction, events };
