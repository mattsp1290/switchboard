import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchOperation } from '@mattsp1290/switchboard';

const canary = 'recovery-private-canary-6802';
const binding = () => ({ engine: 'fixture', nativeVersion: '1', account: `${canary}-account`,
  authorizedScope: `${canary}-scope`, nativeFormat: 'fixture/v1' });
const identity = (kind = 'session') => ({ hostOperationId: `${canary}-operation`, target: kind === 'session'
  ? { kind, reference: { kind, formatVersion: 1, binding: binding(), opaque: `${canary}-session` } }
  : { kind, binding: binding() } });
const evidence = (id, source = 'authoritative-native-lookup', nativeOperation = { namespace: 'fixture/command', id: 'receipt' }) => ({
  identity: structuredClone(id), source, nativeOperation,
  observation: { namespace: 'fixture/lookup', schemaVersion: 1, data: { private: canary } },
});
const accepted = (id, source, nativeOperation) => ({ kind: 'accepted', evidence: evidence(id, source, nativeOperation) });
const conclusive = (id, result, nativeOperation) => ({ kind: 'conclusive', evidence: evidence(id, undefined, nativeOperation), result });
const signal = () => new AbortController().signal;
const recover = (overrides = {}) => createDispatchOperation({ mode: 'recovery', identity: identity(), ...overrides });
const errorCode = (result, code) => assert.deepEqual(result, { kind: 'error', error: { code } });
const revoked = () => { const pair = Proxy.revocable({}, {}); pair.revoke(); return pair.proxy; };

for (const target of ['session', 'new-session']) test(`interrupted ${target} dispatch recovers its one effect without resubmission`, async () => {
  const id = identity(target);
  const effects = new Map();
  let effectCount = 0;
  const fresh = createDispatchOperation({ mode: 'fresh', identity: id, signal: signal(), recordIntent() {},
    dispatchNative(command) { effectCount++; effects.set(command.hostOperationId, { state: 'pending', native: 'receipt' }); throw revoked(); },
  });
  assert.equal((await fresh.run()).observation.kind, 'outcome-unknown');
  for (const found of [false, true]) {
    let lookups = 0;
    const recovery = recover({ identity: id, reconcileNative(previous) {
      lookups++;
      assert.equal(previous.observation.kind, 'outcome-unknown');
      return found ? conclusive(previous.identity, effects.get(id.hostOperationId)) : { kind: 'outcome-unknown' };
    } });
    assert.deepEqual(Object.keys(recovery), ['reconcile']);
    assert.equal('run' in recovery, false);
    assert.equal('dispatchNative' in recovery, false);
    assert(Object.isFrozen(recovery));
    const result = await recovery.reconcile(signal());
    assert.equal(result.kind, 'ok');
    assert.equal(result.value.observation.kind, found ? 'conclusive' : 'outcome-unknown');
    if (found) assert.equal(result.value.observation.result, effects.get(id.hostOperationId));
    assert.equal(lookups, 1);
    assert.equal(effects.size, 1);
    assert.equal(effectCount, 1);
  }
});

test('fresh reconciliation is immediately not-ready until run settles and never starts run', async () => {
  const barrier = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const atPublication = [];
  let sends = 0;
  let lookups = 0;
  const fresh = createDispatchOperation({ mode: 'fresh', identity: identity(), signal: signal(), recordIntent() {},
    events: { publish() { atPublication.push(fresh.reconcile(signal())); } },
    dispatchNative() { sends++; entered.resolve(); return barrier.promise; },
    reconcileNative(previous) { lookups++; return conclusive(previous.identity, 'found'); },
  });
  errorCode(await fresh.reconcile(signal()), 'not-ready');
  assert.equal(sends, 0);
  const original = fresh.run();
  errorCode(await fresh.reconcile(signal()), 'not-ready');
  await entered.promise;
  errorCode(await fresh.reconcile(signal()), 'not-ready');
  barrier.resolve({ kind: 'outcome-unknown' });
  const snapshot = await original;
  for (const result of await Promise.all(atPublication)) errorCode(result, 'not-ready');
  assert.equal(lookups, 0);
  assert.equal((await fresh.reconcile(signal())).value.observation.result, 'found');
  assert.equal(fresh.run(), original);
  assert.equal(await fresh.run(), snapshot);
  assert.deepEqual(snapshot.observation, { kind: 'outcome-unknown' });
  assert.equal(sends, 1);
});

test('lookup reservation coalesces publication, callback and getter reentry and owns the first signal', async () => {
  const barrier = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const firstController = new AbortController();
  const ignored = new AbortController();
  const reentries = [];
  const phases = [];
  let calls = 0;
  const recovery = recover({ events: { publish(event) {
    assert(Object.isFrozen(event));
    assert.deepEqual(Object.keys(event), ['phase']);
    phases.push(event.phase);
    reentries.push(recovery.reconcile(revoked()));
    throw revoked();
  } }, reconcileNative(previous, received) {
    calls++;
    assert.equal(received, firstController.signal);
    reentries.push(recovery.reconcile(ignored.signal));
    entered.resolve();
    return barrier.promise.then(() => ({ get kind() {
      reentries.push(recovery.reconcile(signal()));
      return 'accepted';
    }, evidence: evidence(previous.identity) }));
  } });
  const first = recovery.reconcile(firstController.signal);
  assert.equal(calls, 0);
  assert.equal(recovery.reconcile(ignored.signal), first);
  ignored.abort(canary);
  await entered.promise;
  barrier.resolve();
  const result = await first;
  assert.equal(result.value.observation.kind, 'accepted');
  assert.equal(calls, 1);
  assert(reentries.length > 2 && reentries.every((promise) => promise === first));
  assert.deepEqual(phases, ['reconciling', 'accepted']);
  assert(!JSON.stringify(phases).includes(canary));
});

test('unknown lookup preserves accepted evidence and later explicit lookup refines to a latched result', async () => {
  const previous = accepted(identity(), 'native-acknowledgement');
  const data = revoked();
  const result = revoked();
  let calls = 0;
  const inputs = [];
  const recovery = recover({ previous, reconcileNative(snapshot) {
    inputs.push(snapshot);
    calls++;
    if (calls === 1) return { kind: 'outcome-unknown' };
    const next = conclusive(snapshot.identity, result, null);
    next.evidence.observation.data = data;
    return next;
  } });
  previous.evidence.nativeOperation.id = 'mutated';
  previous.evidence.identity.target.reference.binding.account = 'mutated';
  const first = await recovery.reconcile(signal());
  assert.equal(first.value.observation.evidence.nativeOperation.id, 'receipt');
  assert.equal(first.value.observation.evidence.source, 'native-acknowledgement');
  assert.equal(first.value, inputs[0]);
  assert.equal(calls, 1);
  const refined = await recovery.reconcile(signal());
  assert.equal(refined.value.observation.kind, 'conclusive');
  assert.equal(refined.value.observation.evidence.nativeOperation.id, 'receipt');
  assert.equal(refined.value.observation.evidence.source, 'authoritative-native-lookup');
  assert.equal(refined.value.observation.evidence.observation.data, data);
  assert.equal(refined.value.observation.result, result);
  for (const value of [refined, refined.value, refined.value.observation, refined.value.observation.evidence,
    refined.value.observation.evidence.nativeOperation]) assert(Object.isFrozen(value));
  assert.equal((await recovery.reconcile(AbortSignal.abort())).value, refined.value);
  assert.equal((await recovery.reconcile(revoked())).value, refined.value);
  assert.equal(calls, 2);
});

test('missing and ambiguous records leave identity-only recovery unknown across explicit calls', async () => {
  let calls = 0;
  const recovery = recover({ reconcileNative() { calls++; return { kind: 'outcome-unknown' }; } });
  const first = await recovery.reconcile(signal());
  const second = await recovery.reconcile(signal());
  assert.deepEqual(first.value.observation, { kind: 'outcome-unknown' });
  assert.equal(first.value, second.value);
  assert.equal(calls, 2);
  errorCode(await recover().reconcile(signal()), 'unsupported');
});

test('terminal restored and fresh observations require no lookup', async () => {
  let lookups = 0;
  const reconcileNative = () => { lookups++; throw new Error(canary); };
  const recovery = recover({ previous: conclusive(identity(), { state: 'rejected' }), reconcileNative });
  assert.equal((await recovery.reconcile(AbortSignal.abort())).value.observation.result.state, 'rejected');
  for (const abort of [false, true]) {
    const fresh = createDispatchOperation({ mode: 'fresh', identity: identity(), signal: abort ? AbortSignal.abort() : signal(),
      recordIntent() {}, dispatchNative: (id) => ({ kind: 'conclusive', evidence: evidence(id, 'native-acknowledgement'), result: 'cancelled' }),
      reconcileNative,
    });
    const original = await fresh.run();
    assert.equal((await fresh.reconcile(revoked())).value, original);
  }
  assert.equal(lookups, 0);
});

test('abort owns no inferred outcome, while positive native evidence remains valid after abort', async () => {
  for (const when of ['before', 'publication', 'unknown', 'throw', 'positive']) {
    const controller = new AbortController();
    let calls = 0;
    const previous = accepted(identity(), 'native-acknowledgement');
    const recovery = recover({ previous, events: { publish({ phase }) {
      if (phase === 'reconciling' && when === 'publication') controller.abort();
    } }, reconcileNative(snapshot, received) {
      calls++;
      assert.equal(received, controller.signal);
      controller.abort(canary);
      if (when === 'throw') throw revoked();
      return when === 'positive' ? conclusive(snapshot.identity, 'native-cancelled') : { kind: 'outcome-unknown' };
    } });
    if (when === 'before') controller.abort();
    const result = await recovery.reconcile(controller.signal);
    if (when === 'positive') assert.equal(result.value.observation.result, 'native-cancelled');
    else errorCode(result, 'aborted');
    assert.equal(calls, ['before', 'publication'].includes(when) ? 0 : 1);
  }
});

test('failed and malformed lookups preserve previous evidence without reading thrown values', async () => {
  let traps = 0;
  const thrown = new Proxy({}, { get() { traps++; throw new Error(canary); }, getPrototypeOf() { traps++; } });
  const cases = [
    [() => { throw thrown; }, 'lookup-failed'], [() => Promise.reject(revoked()), 'lookup-failed'],
    [() => ({ get then() { throw revoked(); } }), 'lookup-failed'],
    [() => Promise.reject(new DOMException(canary, 'AbortError')), 'lookup-failed'],
    [() => revoked(), 'lookup-failed'], [() => ({ get kind() { throw revoked(); } }), 'invalid-evidence'],
    [() => ({ kind: 'not-dispatched', reason: 'aborted' }), 'invalid-evidence'],
    [() => ({ kind: 'accepted', get evidence() { throw revoked(); } }), 'invalid-evidence'],
    [() => ({ kind: 'conclusive', evidence: evidence(identity()) }), 'invalid-evidence'],
    [() => accepted(identity(), 'native-acknowledgement'), 'invalid-evidence'],
    ...[null, undefined, [], {}, 42].map((value) => [() => value, 'invalid-evidence']),
  ];
  for (const [hook, code] of cases) {
    let calls = 0;
    let retained;
    const recovery = recover({ previous: accepted(identity(), 'native-acknowledgement'), reconcileNative(previous) {
      if (++calls === 1) { retained = previous; return hook(); }
      assert.equal(previous, retained);
      return { kind: 'outcome-unknown' };
    } });
    const failure = await recovery.reconcile(signal());
    errorCode(failure, code);
    assert(!JSON.stringify(failure).includes(canary));
    assert.equal((await recovery.reconcile(signal())).value, retained);
  }
  assert.equal(traps, 0);
});

test('lookup identity conflicts cover the exact operation, target, reference and every binding field', async () => {
  const mutations = [
    (next) => { next.identity.hostOperationId = 'wrong'; },
    (next) => { next.identity.target = identity('new-session').target; },
    (next) => { next.identity.target.reference.opaque = 'wrong'; },
    ...Object.keys(binding()).map((key) => (next) => { next.identity.target.reference.binding[key] = 'wrong'; }),
    (next) => { next.nativeOperation.id = 'wrong'; },
    (next) => { next.nativeOperation.namespace = 'wrong'; },
  ];
  for (const mutate of mutations) {
    let calls = 0;
    let retained;
    const recovery = recover({ previous: accepted(identity(), 'native-acknowledgement'), reconcileNative(previous) {
      if (++calls > 1) { assert.equal(previous, retained); return { kind: 'outcome-unknown' }; }
      retained = previous;
      const next = accepted(previous.identity);
      mutate(next.evidence);
      return next;
    } });
    errorCode(await recovery.reconcile(signal()), 'evidence-conflict');
    assert.equal((await recovery.reconcile(signal())).value, retained);
  }
});

test('malformed evidence fails closed and accepted null IDs retain known receipts', async () => {
  const mutations = [
    (next) => { delete next.nativeOperation; }, (next) => { next.nativeOperation.id = ''; },
    (next) => { next.observation.schemaVersion = 0; }, (next) => { next.observation.schemaVersion = 1.5; },
    (next) => { delete next.observation.data; }, (next) => { next.observation.namespace = ''; },
    (next) => { next.identity.target.reference.formatVersion = 2; },
    (next) => { next.observation = revoked(); },
  ];
  for (const mutate of mutations) {
    const recovery = recover({ reconcileNative(previous) { const next = accepted(previous.identity); mutate(next.evidence); return next; } });
    errorCode(await recovery.reconcile(signal()), 'invalid-evidence');
  }
  for (const previousId of [null, { namespace: 'fixture/command', id: 'receipt' }]) {
    const recovery = recover({ previous: accepted(identity(), 'native-acknowledgement', previousId),
      reconcileNative: (previous) => accepted(previous.identity, undefined, null) });
    assert.deepEqual((await recovery.reconcile(signal())).value.observation.evidence.nativeOperation, previousId);
  }
});

test('recovery construction copies finite envelopes and never reads dispatch or opaque fields', async () => {
  let traps = 0;
  const data = revoked();
  const previous = accepted(identity());
  previous.evidence.observation.data = data;
  const recovery = createDispatchOperation({ mode: 'recovery', identity: identity(), previous, get dispatchNative() { traps++; throw new Error(canary); },
    get recordIntent() { traps++; throw revoked(); }, get signal() { traps++; throw revoked(); },
    reconcileNative(snapshot) { assert.equal(snapshot.observation.evidence.observation.data, data); return { kind: 'outcome-unknown' }; },
  });
  await recovery.reconcile(signal());
  assert.equal(traps, 0);
  for (const bad of [null, revoked(), { get mode() { throw revoked(); } },
    { mode: 'recovery', identity: identity(), reconcileNative: 42 },
    { mode: 'recovery', identity: identity(), previous: { kind: 'not-dispatched', reason: 'aborted' } },
    { mode: 'recovery', identity: identity(), previous: accepted({ ...identity(), hostOperationId: 'wrong' }) }]) {
    assert.throws(() => createDispatchOperation(bad), (error) => error.constructor === TypeError && error.message === 'Invalid dispatch options.');
  }
  const proxy = new Proxy(signal(), { get() { traps++; throw revoked(); } });
  await assert.rejects(recovery.reconcile(proxy), { name: 'TypeError', message: 'Invalid dispatch signal.' });
  assert.equal(traps, 0);
  assert.equal((await recovery.reconcile(signal())).value.observation.kind, 'accepted');
});
