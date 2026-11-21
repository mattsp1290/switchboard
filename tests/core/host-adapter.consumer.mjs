import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeHostSubject, hostAdapterContracts } from '@operatorworks/switchboard/testkit';

const variants = {
  default: {},
  'fresh-process, two pending, fingerprint after exit': {
    continuation: 'fresh-process', maxPendingPerMessage: 2, fingerprint: 'after-process-exit',
  },
  'no inspect, no fingerprint': { inspect: false, fingerprint: 'unsupported' },
};

test('host conformance names its contracts', () => {
  assert.deepEqual(Object.keys(hostAdapterContracts), ['segments', 'interaction', 'history', 'interrupt', 'host-launcher']);
  assert.equal(Object.isFrozen(hostAdapterContracts), true);
});

for (const [label, options] of Object.entries(variants)) {
  for (const [name, contract] of Object.entries(hostAdapterContracts)) {
    test(`host conformance (${label}): ${name}`, { timeout: 10_000 }, (t) => contract(() => createFakeHostSubject(options), t.signal));
  }
}

test('host-launcher conformance rejects a fallback after a denied launch', async (t) => {
  const factory = () => createFakeHostSubject({ faults: { fallbackOnDeniedLaunch: true } });
  await assert.rejects(hostAdapterContracts['host-launcher'](factory, t.signal), /never falls back/);
});

test('interaction conformance rejects a host call dropped beyond the pending limit', async (t) => {
  const factory = () => createFakeHostSubject({ faults: { dropExtraCalls: true } });
  await assert.rejects(hostAdapterContracts.interaction(factory, t.signal), /expected failed/);
});

test('a denied host launch is an open error and never reaches native work', async () => {
  const subject = createFakeHostSubject();
  const opened = await subject.registration.open({ launch: subject.launch('deny') }, new AbortController().signal);
  assert.equal(opened.kind, 'error');
  assert.equal(opened.error.code, 'unavailable');
  assert.equal(opened.error.feature, 'host-launcher');
  assert.deepEqual(subject.launches(), { attempts: 1, signals: 0 });
});

test('a same-process adapter refuses a continuation reopened in another process', async () => {
  const subject = createFakeHostSubject();
  const signal = new AbortController().signal;
  const host = { signal, recordIntent() {} };
  const first = await subject.registration.open({ launch: subject.launch('allow'), tools: [subject.tool] }, signal);
  const pending = await first.value.run({ ...host, hostOperationId: 'one', prompt: subject.prompts.toolCall });
  assert.equal(pending.kind, 'pending');
  await first.value.close();
  const reopened = await subject.registration.open({ launch: subject.launch('allow'), resume: { session: pending.session } }, signal);
  const [call] = pending.calls;
  const result = await reopened.value.continue({ ...host, hostOperationId: 'two', answers: [{ formatVersion: 1, kind: 'tool',
    outcome: { target: call.pending.target, result: { kind: 'ok', value: { namespace: 'host', schemaVersion: 1, data: {} } },
      effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } }] });
  assert.equal(result.kind, 'failed');
  assert.equal(result.error.code, 'unsupported');
  assert.deepEqual(result.write, { kind: 'not-attempted' });
});

test('a failing scenario still disposes its subject', async (t) => {
  let disposed = 0;
  const factory = () => {
    const subject = createFakeHostSubject({ faults: { fallbackOnDeniedLaunch: true } });
    return { ...subject, async dispose() { disposed++; await subject.dispose(); } };
  };
  await assert.rejects(hostAdapterContracts['host-launcher'](factory, t.signal));
  assert.equal(disposed, 1);
});
