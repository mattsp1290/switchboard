import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchOperation, createEventStream } from '@mattsp1290/switchboard';

const canary = 'dispatch-private-canary-7f931';
const binding = () => ({ engine: 'fixture', nativeVersion: '1', account: `${canary}-account`,
  authorizedScope: `${canary}-scope`, nativeFormat: 'fixture/v1' });
const identity = (kind = 'session') => ({ hostOperationId: `${canary}-host`, target: kind === 'session'
  ? { kind, reference: { kind, formatVersion: 1, binding: binding(), opaque: `${canary}-session` } }
  : { kind, binding: binding() } });
const evidence = (identity) => ({ identity, source: 'native-acknowledgement',
  nativeOperation: { namespace: 'fixture/command', id: `${canary}-receipt` },
  observation: { namespace: 'fixture/ack', schemaVersion: 1, data: { token: canary } } });
const accepted = (identity) => ({ kind: 'accepted', evidence: evidence(identity) });
const options = (overrides = {}) => ({ mode: 'fresh', identity: identity(), signal: new AbortController().signal,
  recordIntent() {}, dispatchNative: accepted, ...overrides });
const revoked = () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
};
const fixedFailure = (construct) => assert.throws(construct, (error) => {
  assert.equal(error.constructor, TypeError);
  assert.equal(error.message, 'Invalid dispatch options.');
  assert(!String(error).includes(canary));
  return true;
});

test('durable intent barrier precedes one effect whose acknowledgement is lost despite all forms of reentry', async () => {
  const durable = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const effects = new Map();
  const phases = [];
  const reentries = [];
  const controller = new AbortController();
  let intents = 0;
  let calls = 0;
  const handle = createDispatchOperation(options({ signal: controller.signal,
    events: { publish(event) { phases.push(event.phase); reentries.push(handle.run()); throw revoked(); } },
    recordIntent(id, signal) {
      intents++;
      assert.equal(signal, controller.signal);
      assert(Object.isFrozen(id.target.reference.binding));
      reentries.push(handle.run());
      entered.resolve();
      return durable.promise;
    },
    dispatchNative(id, signal) {
      calls++;
      assert.equal(signal, controller.signal);
      reentries.push(handle.run());
      effects.set(id.hostOperationId, (effects.get(id.hostOperationId) ?? 0) + 1);
      throw revoked();
    },
  }));
  const first = handle.run();
  assert.equal(intents, 0);
  assert.equal(first, handle.run());
  await entered.promise;
  assert.equal(calls, 0);
  assert.deepEqual(phases, ['recording-intent']);
  durable.resolve();
  const snapshots = await Promise.all([first, handle.run(), handle.run()]);
  assert(snapshots.every((value) => value === snapshots[0]));
  assert.deepEqual(snapshots[0].observation, { kind: 'outcome-unknown' });
  assert(reentries.every((promise) => promise === first));
  assert.equal(handle.run(), first);
  assert.equal(intents, 1);
  assert.equal(calls, 1);
  assert.equal(effects.get(identity().hostOperationId), 1);
  assert.deepEqual(phases, ['recording-intent', 'dispatching', 'outcome-unknown']);
});

test('intent throws, rejections and hostile thenables prevent native entry without inspecting thrown values', async () => {
  let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; throw new Error(canary); }, getPrototypeOf() { traps++; } });
  for (const hook of [() => { throw hostile; }, () => Promise.reject(revoked()),
    () => ({ get then() { throw revoked(); } }), () => Promise.reject(new Error(canary))]) {
    let intents = 0;
    let calls = 0;
    const handle = createDispatchOperation(options({ recordIntent() { intents++; return hook(); }, dispatchNative() { calls++; } }));
    assert.deepEqual((await handle.run()).observation, { kind: 'not-dispatched', reason: 'intent-failed' });
    assert.equal(handle.run(), handle.run());
    assert.equal(intents, 1);
    assert.equal(calls, 0);
  }
  assert.equal(traps, 0);
});

test('abort before intent, at either publication, and after the durable barrier prevents native entry', async () => {
  for (const when of ['before', 'recording-intent', 'intent', 'dispatching']) {
    const controller = new AbortController();
    const barrier = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let intents = 0;
    let calls = 0;
    if (when === 'before') controller.abort(new Error(canary));
    const handle = createDispatchOperation(options({ signal: controller.signal,
      events: { publish({ phase }) { if (phase === when) controller.abort(canary); } },
      recordIntent() { intents++; entered.resolve(); return when === 'intent' ? barrier.promise : undefined; },
      dispatchNative() { calls++; },
    }));
    const pending = handle.run();
    if (when === 'intent') { await entered.promise; controller.abort(canary); barrier.resolve(); }
    assert.deepEqual((await pending).observation, { kind: 'not-dispatched', reason: 'aborted' });
    assert.equal(intents, ['before', 'recording-intent'].includes(when) ? 0 : 1);
    assert.equal(calls, 0);
  }
});

test('both targets retain acceptance and exact native outcomes after cancellation without freezing opaque values', async () => {
  for (const target of ['session', 'new-session']) for (const state of ['accepted', 'pending', 'rejected', 'cancelled']) {
    const controller = new AbortController();
    const result = { state, private: canary };
    const data = { private: canary };
    let raw;
    const snapshot = await createDispatchOperation(options({ identity: identity(target), signal: controller.signal,
      dispatchNative(id) {
        controller.abort();
        raw = state === 'accepted' ? accepted(id) : { kind: 'conclusive', evidence: evidence(id), result };
        raw.evidence.nativeOperation = null;
        raw.evidence.observation.data = data;
        return raw;
      },
    })).run();
    assert.equal(snapshot.observation.kind, state === 'accepted' ? 'accepted' : 'conclusive');
    assert.equal(snapshot.observation.evidence.observation.data, data);
    assert.equal(snapshot.observation.evidence.nativeOperation, null);
    if (state !== 'accepted') assert.equal(snapshot.observation.result, result);
    assert(!Object.isFrozen(data));
    assert(!Object.isFrozen(result));
    for (const value of [snapshot, snapshot.identity, snapshot.identity.target, snapshot.observation,
      snapshot.observation.evidence, snapshot.observation.evidence.observation]) assert(Object.isFrozen(value));
    raw.evidence.observation.namespace = 'changed';
    raw.kind = 'outcome-unknown';
    assert.equal(snapshot.observation.evidence.observation.namespace, 'fixture/ack');
    if (target === 'new-session') assert.deepEqual(Object.keys(snapshot.identity.target).sort(), ['binding', 'kind']);
  }
});

test('every native failure after entry is unknown including AbortError and inaccessible observations', async () => {
  let traps = 0;
  const thrown = new Proxy({}, { get() { traps++; throw new Error(canary); }, getPrototypeOf() { traps++; } });
  for (const native of [() => { throw thrown; }, () => Promise.reject(revoked()),
    () => Promise.reject(new DOMException(canary, 'AbortError')), () => ({ get then() { throw revoked(); } }),
    () => revoked(), () => ({ get kind() { throw revoked(); } }),
    () => ({ kind: 'accepted', get evidence() { throw new Error(canary); } })]) {
    let calls = 0;
    const handle = createDispatchOperation(options({ dispatchNative() { calls++; return native(); } }));
    assert.deepEqual((await handle.run()).observation, { kind: 'outcome-unknown' });
    await handle.run();
    assert.equal(calls, 1);
  }
  assert.equal(traps, 0);
});

test('positive observations require complete finite evidence corresponding to every exact identity field', async () => {
  const mutations = [
    (o) => { delete o.evidence; }, (o) => { o.kind = 'not-dispatched'; },
    (o) => { o.kind = 'conclusive'; }, (o) => { o.evidence.source = 'authoritative-native-lookup'; },
    (o) => { o.evidence.identity.hostOperationId = 'wrong'; },
    (o) => { o.evidence.identity.target = identity('new-session').target; },
    (o) => { o.evidence.identity.target.reference.opaque = 'wrong'; },
    (o) => { o.evidence.identity.target.reference.formatVersion = 2; },
    (o) => { o.evidence.identity.target.reference.kind = 'checkpoint'; },
    ...Object.keys(binding()).map((field) => (o) => { o.evidence.identity.target.reference.binding[field] = 'wrong'; }),
    ...['namespace', 'id'].flatMap((field) => ['', 'x'.repeat(1025), '\n'].map((value) => (o) => { o.evidence.nativeOperation[field] = value; })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map((value) => (o) => { o.evidence.observation.schemaVersion = value; }),
    (o) => { o.evidence.observation.namespace = ''; }, (o) => { delete o.evidence.observation.data; },
    (o) => { delete o.evidence.nativeOperation; }, (o) => { o.evidence.nativeOperation = o.evidence.identity; },
    (o) => { o.evidence.observation = revoked(); },
  ];
  for (const mutate of mutations) {
    const snapshot = await createDispatchOperation(options({ dispatchNative(id) {
      const observation = structuredClone(accepted(id));
      mutate(observation);
      return observation;
    } })).run();
    assert.deepEqual(snapshot.observation, { kind: 'outcome-unknown' });
  }
  for (const malformed of [null, undefined, [], {}, 42]) {
    assert.deepEqual((await createDispatchOperation(options({ dispatchNative: () => malformed })).run()).observation, { kind: 'outcome-unknown' });
  }
});

test('construction failures expose only a fixed TypeError and execute no callbacks', () => {
  let calls = 0;
  const base = options({ recordIntent() { calls++; }, dispatchNative() { calls++; } });
  for (const value of [null, revoked(), { get mode() { throw revoked(); } },
    new Proxy({}, { get() { throw new Error(canary); } }), { ...base, mode: 'recovery' },
    { ...base, signal: {} }, { ...base, signal: revoked() }, { ...base, recordIntent: null },
    { ...base, dispatchNative: 42 }, { ...base, events: null }, { ...base, events: { publish: 1 } },
    { ...base, identity: { ...identity(), hostOperationId: '' } },
    { ...base, identity: { target: { kind: 'new-session', get binding() { throw revoked(); } } } }]) {
    fixedFailure(() => createDispatchOperation(value));
  }
  assert.equal(calls, 0);
});

test('proxy signals fail construction without invoking any traps or callbacks', () => {
  let traps = 0;
  let calls = 0;
  const handlers = Object.fromEntries(['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'has']
    .map((key) => [key, () => { traps++; throw new Error(canary); }]));
  const actual = new AbortController().signal;
  const pair = Proxy.revocable(actual, handlers);
  const alreadyRevoked = Proxy.revocable(actual, handlers);
  alreadyRevoked.revoke();
  let target = actual;
  const retargetable = new Proxy({}, { get(_target, key) { traps++; return Reflect.get(target, key, target); } });
  for (const signal of [new Proxy(actual, {}), pair.proxy, alreadyRevoked.proxy,
    new Proxy(actual, handlers), retargetable]) {
    fixedFailure(() => createDispatchOperation(options({ signal,
      recordIntent() { calls++; }, dispatchNative() { calls++; },
    })));
  }
  target = AbortSignal.abort();
  pair.revoke();
  assert.equal(traps, 0);
  assert.equal(calls, 0);
});

test('signal invalidation rejects the cached promise with a fixed TypeError before native entry', async () => {
  for (const shape of ['actual', 'lookalike']) for (const when of ['before', 'recording-intent', 'intent', 'dispatching']) {
    const actual = new AbortController().signal;
    const signal = shape === 'actual' ? actual
      : Object.create(Object.getPrototypeOf(actual), Object.getOwnPropertyDescriptors(actual));
    const phases = [];
    const reentries = [];
    const barrier = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let intents = 0;
    let calls = 0;
    let thrownReads = 0;
    const thrown = new Proxy({}, { get() { thrownReads++; throw new Error(canary); } });
    const invalidate = () => {
      for (const key of Object.getOwnPropertySymbols(signal)) {
        Object.defineProperty(signal, key, { get() { reentries.push(handle.run()); throw thrown; } });
      }
    };
    const handle = createDispatchOperation(options({ signal,
      events: { publish({ phase }) { phases.push(phase); if (phase === when) invalidate(); } },
      recordIntent(_id, received) {
        intents++;
        assert.equal(received, signal);
        entered.resolve();
        return when === 'intent' ? barrier.promise : undefined;
      },
      dispatchNative() { calls++; return { kind: 'outcome-unknown' }; },
    }));
    if (when === 'before') invalidate();
    const first = handle.run();
    if (when === 'intent') { await entered.promise; invalidate(); barrier.resolve(); }
    let failure;
    await assert.rejects(first, (error) => {
      failure = error;
      assert.equal(error.constructor, TypeError);
      assert.equal(error.message, 'Invalid dispatch signal.');
      assert(!String(error).includes(canary));
      return true;
    });
    assert.equal(handle.run(), first);
    await assert.rejects(handle.run(), (error) => error === failure);
    assert(reentries.length > 0 && reentries.every((promise) => promise === first));
    assert.equal(intents, ['before', 'recording-intent'].includes(when) ? 0 : 1);
    assert.equal(calls, 0);
    assert.equal(thrownReads, 0);
    assert.deepEqual(phases, when === 'before' ? []
      : when === 'dispatching' ? ['recording-intent', 'dispatching'] : ['recording-intent']);
  }
});

test('known fields are read once, options are captured, and opaque proxies are never inspected', async () => {
  const counts = [];
  function watch(object) {
    for (const key of Object.keys(object)) {
      const initial = object[key];
      const count = { reads: 0 };
      counts.push(count);
      Object.defineProperty(object, key, { get() { assert.equal(++count.reads, 1); return initial; } });
    }
    Object.defineProperty(object, 'privateExtra', { get() { throw new Error(canary); } });
    return object;
  }
  const id = identity();
  watch(id.target.reference.binding);
  watch(id.target.reference);
  watch(id.target);
  watch(id);
  let raw;
  const opaque = revoked();
  const input = options({ identity: id, events: watch({ publish() {} }), dispatchNative(captured) {
    assert.equal(captured.hostOperationId, `${canary}-host`);
    raw = evidence(structuredClone(captured));
    watch(raw.identity.target.reference.binding);
    watch(raw.identity.target.reference);
    watch(raw.identity.target);
    watch(raw.identity);
    watch(raw.nativeOperation);
    raw.observation.data = opaque;
    watch(raw.observation);
    return watch({ kind: 'conclusive', evidence: watch(raw), result: opaque });
  } });
  const handle = createDispatchOperation(watch(input));
  const snapshot = await handle.run();
  assert.equal(snapshot.observation.kind, 'conclusive');
  assert.equal(snapshot.observation.result, opaque);
  assert.equal(snapshot.observation.evidence.observation.data, opaque);
  assert(counts.every(({ reads }) => reads === 1));
  assert(Object.isFrozen(snapshot.observation.evidence.nativeOperation));
  const mutable = options();
  const second = createDispatchOperation(mutable);
  mutable.identity.target.reference.binding.account = 'mutated';
  mutable.identity.target.reference.opaque = 'mutated';
  mutable.dispatchNative = () => { throw new Error('replaced callback ran'); };
  mutable.signal = AbortSignal.abort();
  assert.equal((await second.run()).observation.kind, 'accepted');
  assert.equal((await second.run()).identity.target.reference.opaque, `${canary}-session`);
});

test('throwing publishers, disposed observers, overflow, listener failure and closed streams preserve acceptance', async () => {
  for (const mode of ['throw', 'disposed', 'overflow', 'listener-error', 'closed']) {
    const stream = createEventStream({ maxObservers: 1, capacity: mode === 'overflow' ? 1 : 8 });
    const barrier = Promise.withResolvers();
    const subscription = stream.subscribe(() => {
      if (mode === 'listener-error') throw revoked();
      if (mode === 'overflow') return barrier.promise;
    }).value;
    if (mode === 'disposed') subscription.dispose();
    if (mode === 'closed') stream.close();
    let calls = 0;
    const events = [];
    const snapshot = await createDispatchOperation(options({ events: { publish(event) {
      events.push(event);
      if (mode === 'throw') throw revoked();
      return stream.publish(event);
    } }, dispatchNative(id) { calls++; return accepted(id); } })).run();
    assert.equal(snapshot.observation.kind, 'accepted');
    assert.equal(calls, 1);
    assert.deepEqual(events.map(({ phase }) => phase), ['recording-intent', 'dispatching', 'accepted']);
    assert(events.every((event) => Object.isFrozen(event) && Object.keys(event).join() === 'phase'));
    assert(!JSON.stringify(events).includes(canary));
    if (mode !== 'throw') assert.equal(await subscription.ended, mode);
    barrier.resolve();
    stream.close();
  }
});

test('independent handles progress independently and duplicate identities require host admission', async () => {
  const barrier = Promise.withResolvers();
  let effects = 0;
  const native = (id) => { effects++; return accepted(id); };
  const first = createDispatchOperation(options({ recordIntent: () => barrier.promise, dispatchNative: native }));
  const second = createDispatchOperation(options({ dispatchNative: native }));
  const blocked = first.run();
  assert.equal((await second.run()).observation.kind, 'accepted');
  assert.equal(effects, 1);
  barrier.resolve();
  const completed = await blocked;
  assert.equal(completed.observation.kind, 'accepted');
  assert.deepEqual(completed.identity, (await second.run()).identity);
  assert.notEqual(first.run(), second.run());
  assert.equal(effects, 2);
});
