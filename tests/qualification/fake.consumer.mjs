import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { contracts } from './harness/contracts.mjs';
import { createFakeFixture } from './harness/fake.mjs';

for (const [name, contract] of Object.entries(contracts)) {
  test(`fake qualification: ${name}`, { timeout: 10_000 }, (t) => contract(createFakeFixture, t.signal));

  test(`qualification preserves failed acquisition: ${name}`, async (t) => {
    for (const reason of [undefined, null, false, 0, '']) {
      let attempts = 0;
      await assert.rejects(contract(async () => { attempts++; throw reason; }, t.signal), (error) => {
        assert.equal(error, reason);
        return true;
      });
      assert.equal(attempts, 1);
    }
  });

  test(`qualification preserves falsy abort: ${name}`, async () => {
    for (const reason of [null, false, 0, '']) {
      let disposed = 0;
      await assert.rejects(contract(async () => {
        const real = createFakeFixture();
        return { ...real, async dispose() { disposed++; await real.dispose(); } };
      }, AbortSignal.abort(reason)), (error) => {
        assert.equal(error, reason);
        return true;
      });
      assert.equal(disposed, 1);
    }
  });

  test(`qualification retains primary and cleanup failures: ${name}`, async (t) => {
    const cleanup = new Error('Dispose failed.');
    for (const reason of [undefined, null, false, 0, '', 'primary', Object.freeze(new Error('Primary failure.'))]) {
      let disposed = 0;
      await assert.rejects(contract(() => {
        const real = createFakeFixture();
        return {
          ...real,
          connect() { throw reason; },
          async dispose() { disposed++; await real.dispose(); throw cleanup; },
        };
      }, t.signal), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], reason);
        assert.equal(error.errors[1], cleanup);
        return true;
      });
      assert.equal(disposed, 1);
    }
  });
}

function extraSendFactory(tracker) {
  const real = createFakeFixture();
  tracker.fixture = real;
  return {
    ...real,
    async dispose() {
      await real.dispose();
      tracker.disposed = true;
    },
    connect(recordIntent) {
      const driver = real.connect(recordIntent);
      tracker.connections.push(driver);
      return {
        ...driver,
        recover(saved) {
          const recovery = driver.recover(saved);
          return { reconcile: async (signal) => {
            const observed = await recovery.reconcile(signal);
            await driver.submit({ session: saved.identity.target.reference,
              hostOperationId: 'illegal-recovery-resend' }, signal);
            return observed;
          } };
        },
      };
    },
  };
}

function falseCertaintyFactory(tracker) {
  const real = createFakeFixture();
  tracker.fixture = real;
  return {
    ...real,
    async dispose() {
      await real.dispose();
      tracker.disposed = true;
    },
    connect(recordIntent) {
      const driver = real.connect(recordIntent);
      tracker.connections.push(driver);
      return {
        ...driver,
        async submit(request, signal) {
          const result = await driver.submit(request, signal);
          return result.kind === 'ok' && result.value.observation.kind === 'outcome-unknown'
            ? { kind: 'ok', value: { ...result.value, observation: { kind: 'accepted' } } } : result;
        },
      };
    },
  };
}

async function rejectsDriver(factory, invariant, expectedConnections, signal, contract = contracts.uncertainty) {
  const tracker = { connections: [], disposed: false };
  await assert.rejects(contract(() => factory(tracker), signal), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.match(error.message, new RegExp(`^${RegExp.escape(invariant)}(?=\\n|$)`));
    return true;
  });
  assert.equal(tracker.disposed, true);
  assert.equal(tracker.connections.length, expectedConnections);
  assert.equal(tracker.fixture.controls.counts().transportCloses, expectedConnections);
  for (const connection of tracker.connections) {
    assert.deepEqual(connection.events.subscribe(() => {}), { kind: 'error', error: { code: 'closed' } });
    assert.deepEqual(await connection.submit({ session: tracker.fixture.samples.a,
      hostOperationId: 'after-cleanup' }, signal), { kind: 'error', error: { code: 'closed' } });
  }
  await tracker.fixture.dispose();
  assert.equal(tracker.fixture.controls.counts().transportCloses, expectedConnections);
}

test('qualification rejects recovery dispatch', { timeout: 10_000 }, (t) =>
  rejectsDriver(extraSendFactory, 'reconciliation cannot dispatch', 2, t.signal));

test('qualification rejects false certainty', { timeout: 10_000 }, (t) =>
  rejectsDriver(falseCertaintyFactory, 'lost acknowledgement must remain outcome-unknown', 1, t.signal));

function derivedDeliveryFactory(tracker) {
  const real = createFakeFixture();
  tracker.fixture = real;
  return {
    ...real,
    async dispose() { await real.dispose(); tracker.disposed = true; },
    connect(recordIntent) {
      const driver = real.connect(recordIntent);
      tracker.connections.push(driver);
      return { ...driver, submit(request, signal) {
        if (/^tool-\d+$/.test(request.hostOperationId)) {
          const outcome = request.continuation.outcome;
          outcome.delivery = outcome.effect.kind === 'known'
            ? { kind: 'confirmed', evidence: outcome.effect.evidence } : { kind: 'unknown' };
        }
        return driver.submit(request, signal);
      } };
    },
  };
}

test('qualification rejects effect-derived delivery', { timeout: 10_000 }, (t) =>
  rejectsDriver(derivedDeliveryFactory, 'native result, effect and delivery remain independent',
    1, t.signal, contracts.interaction));

test('qualification isolates rejected continuation inputs', { timeout: 10_000 }, async (t) => {
  const real = createFakeFixture();
  const connections = [];
  let disposed = 0;
  await contracts.interaction(() => ({ ...real,
    async dispose() { await real.dispose(); disposed++; },
    connect(recordIntent) {
      const driver = real.connect(recordIntent);
      connections.push(driver);
      return { ...driver, async submit(request, signal) {
        const result = await driver.submit(request, signal);
        if (result.kind === 'error' && request.continuation) {
          const continuation = request.continuation;
          if (continuation.kind === 'approval') {
            continuation.nativeChoiceId = 'rewritten';
          } else {
            continuation.outcome.result.error.data.failed = false;
            continuation.outcome.delivery = { kind: 'unknown' };
          }
        }
        return result;
      } };
    },
  }), t.signal);
  assert.equal(disposed, 1);
  assert.equal(real.controls.counts().transportCloses, connections.length);
  for (const connection of connections) {
    assert.deepEqual(connection.events.subscribe(() => {}), { kind: 'error', error: { code: 'closed' } });
  }
});

test('qualification rejects ignored subscription abort', { timeout: 10_000 }, async (t) => {
  const controller = new AbortController();
  const reason = new Error('Subscription abort did not detach observer.');
  const fixtures = [];
  const connections = [];
  const observers = [];
  let active = 0;
  let disposed = 0;
  let deadline;
  const abort = () => controller.abort(t.signal.reason);
  t.signal.addEventListener('abort', abort, { once: true });
  try {
    await assert.rejects(contracts.events(() => {
      const real = createFakeFixture();
      fixtures.push(real);
      return { ...real,
        async dispose() { await real.dispose(); disposed++; },
        connect(recordIntent) {
          const driver = real.connect(recordIntent);
          connections.push(driver);
          return { ...driver, events: { subscribe(listener, options) {
            const input = options?.signal;
            const abort = () => { deadline = setTimeout(() => controller.abort(reason), 250); };
            input?.addEventListener('abort', abort, { once: true });
            const result = driver.events.subscribe(async (...args) => {
              active++;
              try { await listener(...args); } finally { active--; }
            });
            if (result.kind === 'ok') {
              observers.push(result.value);
              void result.value.ended.then(() => input?.removeEventListener('abort', abort));
            } else input?.removeEventListener('abort', abort);
            return result;
          } } };
        },
      };
    }, controller.signal), (error) => error === reason);
    assert.equal(active, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(disposed, fixtures.length);
    assert.equal(fixtures.reduce((total, fixture) => total + fixture.controls.counts().transportCloses, 0),
      connections.length);
    for (const observer of observers) assert.equal(await observer.ended, 'disposed');
    for (const connection of connections) {
      assert.deepEqual(connection.events.subscribe(() => {}), { kind: 'error', error: { code: 'closed' } });
    }
  } finally {
    clearTimeout(deadline);
    t.signal.removeEventListener('abort', abort);
  }
});
