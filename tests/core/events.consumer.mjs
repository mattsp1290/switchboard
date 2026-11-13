import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createEventStream } from '@mattsp1290/switchboard';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function subscribe(stream, listener, options) {
  const result = stream.subscribe(listener, options);
  assert.equal(result.kind, 'ok');
  return result.value;
}

function published(enqueued, disconnected = 0) {
  return { kind: 'published', enqueued, disconnected };
}

function assertFull(stream) {
  assert.deepEqual(stream.subscribe(() => {}), { kind: 'error', error: { code: 'capacity' } });
}

test('bounds reject invalid counts and unsafe products', () => {
  for (const invalid of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createEventStream({ maxObservers: invalid, capacity: 1 }), RangeError);
    assert.throws(() => createEventStream({ maxObservers: 1, capacity: invalid }), RangeError);
  }
  assert.throws(() => createEventStream({ maxObservers: Number.MAX_SAFE_INTEGER, capacity: 2 }), RangeError);
  createEventStream({ maxObservers: 1, capacity: Number.MAX_SAFE_INTEGER }).close();
});

test('publication is synchronous, delivery is asynchronous FIFO, and no replay exists', async () => {
  const bounds = { maxObservers: 1, capacity: 3 };
  const stream = createEventStream(bounds);
  bounds.capacity = 1;
  assert.deepEqual(stream.publish('before subscription'), published(0));
  const first = deferred();
  const release = deferred();
  const finished = deferred();
  const events = [];
  let active = 0;
  const subscription = subscribe(stream, async (event) => {
    active++;
    assert.equal(active, 1);
    events.push(event);
    if (event === 1) { first.resolve(); await release.promise; }
    active--;
    if (event === 3) finished.resolve();
  });
  assert.deepEqual(stream.publish(1), published(1));
  assert.deepEqual(stream.publish(2), published(1));
  assert.deepEqual(stream.publish(3), published(1));
  assert.deepEqual(events, []);
  await first.promise;
  assert.deepEqual(events, [1]);
  release.resolve();
  await finished.promise;
  assert.deepEqual(events, [1, 2, 3]);
  subscription.dispose();
  assert.equal(await subscription.ended, 'disposed');
  stream.close();
});

test('native payloads keep their identity and undefined is a deliverable value', async () => {
  const stream = createEventStream({ maxObservers: 1, capacity: 2 });
  const payload = { nativeFeature: { vendorField: 7 }, reportedUsage: { tokens: 11 } };
  const finished = deferred();
  const events = [];
  subscribe(stream, (event) => {
    events.push(event);
    if (events.length === 2) finished.resolve();
  });
  stream.publish(payload);
  stream.publish(undefined);
  await finished.promise;
  assert.equal(events[0], payload);
  assert.deepEqual(events, [payload, undefined]);
  stream.close();
});

test('one slow observer cannot stall an independent observer', async () => {
  const stream = createEventStream({ maxObservers: 2, capacity: 3 });
  const slowStarted = deferred();
  const releaseSlow = deferred();
  const fastFinished = deferred();
  const slowFinished = deferred();
  const slowEvents = [];
  const fastEvents = [];
  subscribe(stream, async (event) => {
    slowEvents.push(event);
    if (event === 1) { slowStarted.resolve(); await releaseSlow.promise; }
    if (event === 3) slowFinished.resolve();
  });
  subscribe(stream, (event) => {
    fastEvents.push(event);
    if (event === 3) fastFinished.resolve();
  });
  stream.publish(1);
  await slowStarted.promise;
  stream.publish(2);
  stream.publish(3);
  await fastFinished.promise;
  assert.deepEqual(fastEvents, [1, 2, 3]);
  assert.deepEqual(slowEvents, [1]);
  releaseSlow.resolve();
  await slowFinished.promise;
  assert.deepEqual(slowEvents, [1, 2, 3]);
  stream.close();
});

test('overflow counts the active callback, disconnects explicitly, and drops its suffix', async () => {
  const stream = createEventStream({ maxObservers: 2, capacity: 2 });
  const started = deferred();
  const release = deferred();
  const healthy = deferred();
  const seen = [];
  let signal;
  const input = new AbortController();
  const slow = subscribe(stream, async (event, deliverySignal) => {
    signal = deliverySignal;
    seen.push(event);
    started.resolve();
    await release.promise;
  }, { signal: input.signal });
  assert.deepEqual(stream.publish(1), published(1));
  await started.promise;
  assert.deepEqual(stream.publish(2), published(1));
  const fast = subscribe(stream, (event) => healthy.resolve(event));
  assert.deepEqual(stream.publish(3), published(1, 1));
  assert.equal(await slow.ended, 'overflow');
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(input.signal, 'abort').length, 0);
  assertFull(stream);
  assert.equal(await healthy.promise, 3);
  release.resolve();
  await setImmediate();
  assert.deepEqual(seen, [1]);
  subscribe(stream, () => {}).dispose();
  slow.dispose();
  assert.equal(await slow.ended, 'overflow');
  fast.dispose();
  stream.close();
});

test('capacity one also overflows before its scheduled callback starts', async () => {
  const stream = createEventStream({ maxObservers: 1, capacity: 1 });
  let calls = 0;
  const subscription = subscribe(stream, () => { calls++; });
  assert.deepEqual(stream.publish(undefined), published(1));
  assert.deepEqual(stream.publish(undefined), published(0, 1));
  assertFull(stream);
  assert.equal(await subscription.ended, 'overflow');
  await setImmediate();
  assert.equal(calls, 0);
  subscribe(stream, () => {}).dispose();
  stream.close();
});

test('callback publication cannot overtake an already queued event or run concurrently', async () => {
  const stream = createEventStream({ maxObservers: 1, capacity: 3 });
  const finished = deferred();
  const events = [];
  let active = false;
  subscribe(stream, (event) => {
    assert.equal(active, false);
    active = true;
    events.push(event);
    if (event === 1) assert.deepEqual(stream.publish(3), published(1));
    if (event === 3) finished.resolve();
    active = false;
  });
  stream.publish(1);
  stream.publish(2);
  await finished.promise;
  assert.deepEqual(events, [1, 2, 3]);
  stream.close();
});

test('overflow abort handlers cannot reorder publication for remaining observers', async () => {
  const stream = createEventStream({ maxObservers: 2, capacity: 3 });
  const started = deferred();
  const release = deferred();
  const finished = deferred();
  const events = [];
  const slow = subscribe(stream, async (_, signal) => {
    signal.addEventListener('abort', () => {
      assert.deepEqual(stream.publish('nested'), published(1));
    }, { once: true });
    started.resolve();
    await release.promise;
  });
  stream.publish('active');
  await started.promise;
  stream.publish('queued-1');
  stream.publish('queued-2');
  subscribe(stream, (event) => {
    events.push(event);
    if (event === 'nested') finished.resolve();
  });
  assert.deepEqual(stream.publish('outer'), published(1, 1));
  assert.equal(await slow.ended, 'overflow');
  await finished.promise;
  assert.deepEqual(events, ['outer', 'nested']);
  release.resolve();
  stream.close();
});

for (const mode of ['throw', 'reject', 'thenable']) {
  test(`${mode} failure is isolated and exposes only a safe terminal code`, async () => {
    const stream = createEventStream({ maxObservers: 2, capacity: 2 });
    const healthy = deferred();
    const input = new AbortController();
    const secret = { credential: 'never-expose-this' };
    let signal;
    const broken = subscribe(stream, (_, deliverySignal) => {
      signal = deliverySignal;
      if (mode === 'throw') throw secret;
      if (mode === 'reject') return Promise.reject(secret);
      return { then() { throw secret; } };
    }, { signal: input.signal });
    subscribe(stream, (event) => healthy.resolve(event));
    assert.deepEqual(stream.publish('value'), published(2));
    assert.equal(await broken.ended, 'listener-error');
    assert.equal(await healthy.promise, 'value');
    assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(input.signal, 'abort').length, 0);
    subscribe(stream, () => {}).dispose();
    stream.close();
    assert.equal(await broken.ended, 'listener-error');
  });
}

test('already-aborted subscriptions take no lease, even when admission is full', async () => {
  const stream = createEventStream({ maxObservers: 1, capacity: 1 });
  const admitted = subscribe(stream, () => {});
  const input = new AbortController();
  input.abort({ secret: 'not exposed' });
  const aborted = subscribe(stream, () => assert.fail('Aborted callback ran.'), { signal: input.signal });
  assert.equal(await aborted.ended, 'aborted');
  assert.equal(getEventListeners(input.signal, 'abort').length, 0);
  aborted.dispose();
  assertFull(stream);
  admitted.dispose();
  subscribe(stream, () => {}).dispose();
  stream.close();
  assert.deepEqual(stream.subscribe(() => {}, { signal: input.signal }), { kind: 'error', error: { code: 'closed' } });
});

for (const phase of ['idle', 'scheduled', 'active']) {
  test(`input abort survives stopped propagation during ${phase} delivery`, async () => {
    const stream = createEventStream({ maxObservers: 1, capacity: 2 });
    const input = new AbortController();
    input.signal.addEventListener('abort', (event) => event.stopImmediatePropagation(), { once: true });
    const started = deferred();
    const callback = deferred();
    let calls = 0;
    let signal;
    let reason;
    const subscription = subscribe(stream, (_, deliverySignal) => {
      calls++;
      signal = deliverySignal;
      started.resolve();
      return callback.promise;
    }, { signal: input.signal });
    subscription.ended.then((value) => { reason = value; });
    assert.equal(getEventListeners(input.signal, 'abort').length, 2);
    if (phase !== 'idle') stream.publish('first');
    if (phase === 'active') {
      await started.promise;
      stream.publish('queued');
    }
    input.abort();
    assert.deepEqual(stream.publish('after abort'), published(0));
    if (phase === 'idle') subscribe(stream, () => {}).dispose();
    else assertFull(stream);
    assert.equal(getEventListeners(input.signal, 'abort').length, 0);
    await setImmediate();
    assert.equal(reason, 'aborted');
    assert.equal(calls, phase === 'active' ? 1 : 0);
    if (phase === 'active') {
      assert.equal(signal.aborted, true);
      assertFull(stream);
      callback.reject(new Error('late rejection after protected input abort'));
      await setImmediate();
    }
    subscribe(stream, () => {}).dispose();
    stream.close();
    assert.equal(await subscription.ended, 'aborted');
  });
}

for (const reason of ['disposed', 'aborted', 'closed']) {
  test(`${reason} detaches immediately, preserves native work, and consumes late rejection`, async () => {
    const stream = createEventStream({ maxObservers: 1, capacity: 2 });
    const input = new AbortController();
    const started = deferred();
    const callback = deferred();
    const nativeWork = deferred();
    let nativeFinished = false;
    const nativeResult = nativeWork.promise.then(() => { nativeFinished = true; });
    let calls = 0;
    let signal;
    const subscription = subscribe(stream, (_, deliverySignal) => {
      calls++;
      signal = deliverySignal;
      started.resolve();
      return callback.promise;
    }, { signal: input.signal });
    assert.equal(getEventListeners(input.signal, 'abort').length, 1);
    stream.publish(1);
    await started.promise;
    stream.publish(2);
    if (reason === 'disposed') subscription.dispose();
    if (reason === 'aborted') input.abort();
    if (reason === 'closed') stream.close();
    assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(input.signal, 'abort').length, 0);
    assert.equal(await subscription.ended, reason);
    assert.equal(nativeFinished, false);
    subscription.dispose();
    subscription.dispose();
    input.abort();
    if (reason !== 'closed') assertFull(stream);
    callback.reject({ credential: 'late-rejection-must-be-consumed' });
    await setImmediate();
    assert.equal(calls, 1);
    if (reason !== 'closed') subscribe(stream, () => {}).dispose();
    nativeWork.resolve();
    await nativeResult;
    assert.equal(nativeFinished, true);
    stream.close();
    stream.close();
    assert.equal(await subscription.ended, reason);
  });
}

test('repeated subscribe/dispose cannot accumulate unlimited hung callbacks', async () => {
  const stream = createEventStream({ maxObservers: 3, capacity: 1 });
  const callbacks = [];
  let calls = 0;
  for (let index = 0; index < 3; index++) {
    const started = deferred();
    const callback = deferred();
    callbacks.push(callback);
    const subscription = subscribe(stream, () => {
      calls++;
      started.resolve();
      return callback.promise;
    });
    assert.deepEqual(stream.publish(index), published(1));
    await started.promise;
    subscription.dispose();
    assert.equal(await subscription.ended, 'disposed');
  }
  for (let index = 0; index < 20; index++) assertFull(stream);
  assert.equal(calls, 3);
  assert.deepEqual(stream.publish('no observers'), published(0));
  callbacks[0].resolve();
  await setImmediate();
  const recovered = subscribe(stream, () => {});
  assertFull(stream);
  recovered.dispose();
  callbacks[1].reject(new Error('retired'));
  callbacks[2].resolve();
  await setImmediate();
  for (let index = 0; index < 3; index++) subscribe(stream, () => {});
  assertFull(stream);
  stream.close();
});

test('close clears every queue before reentrant abort handlers and stays idempotent', async () => {
  const stream = createEventStream({ maxObservers: 2, capacity: 2 });
  const started = deferred();
  const callback = deferred();
  const input = new AbortController();
  let deliveries = 0;
  const active = subscribe(stream, (_, signal) => {
    deliveries++;
    signal.addEventListener('abort', () => {
      assert.deepEqual(stream.publish('nested'), { kind: 'closed' });
      assert.deepEqual(stream.subscribe(() => {}), { kind: 'error', error: { code: 'closed' } });
      stream.close();
    }, { once: true });
    started.resolve();
    return callback.promise;
  }, { signal: input.signal });
  stream.publish(1);
  await started.promise;
  const pending = subscribe(stream, () => assert.fail('Queued callback ran after close.'));
  stream.publish(2);
  stream.close();
  stream.close();
  assert.equal(await active.ended, 'closed');
  assert.equal(await pending.ended, 'closed');
  assert.equal(getEventListeners(input.signal, 'abort').length, 0);
  assert.equal(deliveries, 1);
  callback.resolve();
  await setImmediate();
});
