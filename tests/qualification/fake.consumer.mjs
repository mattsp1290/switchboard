import assert from 'node:assert/strict';
import test from 'node:test';
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

async function rejectsDriver(factory, invariant, expectedConnections, signal) {
  const tracker = { connections: [], disposed: false };
  await assert.rejects(contracts.uncertainty(() => factory(tracker), signal), (error) => {
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
