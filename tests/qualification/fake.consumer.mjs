import assert from 'node:assert/strict';
import test from 'node:test';
import { contracts } from './harness/contracts.mjs';
import { createFakeFixture } from './harness/fake.mjs';

for (const [name, contract] of Object.entries(contracts)) {
  test(`fake qualification: ${name}`, { timeout: 10_000 }, (t) => contract(createFakeFixture, t.signal));
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

test('qualification rejects recovery dispatch', { timeout: 10_000 }, async (t) => {
  const tracker = { connections: [], disposed: false };
  await assert.rejects(contracts.uncertainty(() => extraSendFactory(tracker), t.signal), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.match(error.message, /^reconciliation cannot dispatch(?=\n|$)/);
    return true;
  });
  assert.equal(tracker.disposed, true);
  assert.equal(tracker.connections.length, 2);
  assert.equal(tracker.fixture.controls.counts().transportCloses, 2);
  for (const connection of tracker.connections) {
    assert.deepEqual(connection.events.subscribe(() => {}), { kind: 'error', error: { code: 'closed' } });
    assert.deepEqual(await connection.submit({ session: tracker.fixture.samples.a,
      hostOperationId: 'after-cleanup' }, t.signal), { kind: 'error', error: { code: 'closed' } });
  }
  await tracker.fixture.dispose();
  assert.equal(tracker.fixture.controls.counts().transportCloses, 2);
});
