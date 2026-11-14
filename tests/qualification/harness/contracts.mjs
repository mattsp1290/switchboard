import assert from 'node:assert/strict';
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

export const contracts = { uncertainty, sessions };
