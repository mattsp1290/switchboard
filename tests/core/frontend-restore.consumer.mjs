import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessFrontendRestore, compareRestoreDecisions, decideFrontendRestore, frontendRestoreCapabilities,
  frontendRestoreDefaultRevision, frontendRestoreDelivery, frontendRestoreFact, frontendRestoreLimits,
  parsePendingFrontendBatch, validateRestoreDecision,
} from '@mattsp1290/switchboard';

const binding = { engine: 'codex', nativeVersion: '0.169.0', account: 'account', authorizedScope: 'scope', nativeFormat: 'app-server' };
const session = { kind: 'session', formatVersion: 1, binding, opaque: 'thread-a' };
const hash = (seed) => `sha256:${seed.repeat(64)}`;
const call = (id) => ({ target: { kind: 'tool', session, nativeToolCallId: `native-${id}` },
  publicToolCallId: `public-${id}`, argumentsDigest: hash('a'), definitionDigest: hash('b') });
const envelope = (adapter = 'codex', change = {}) => ({ formatVersion: 1, adapter, session, nativeTurnId: 'turn-a',
  epoch: 'epoch-1', sourceRunId: 'run-source', calls: [call('a'), call('b')], ...change });
const adapters = ['codex', 'claude', 'pi'];
const mechanisms = ['defer', 'deliver-original', 'settle-interrupted', 'paired-repair', 'continue-new-turn', 'redispatch'];
const observations = {
  'warm': { kind: 'live-original', epoch: 'epoch-1' },
  'rejoinable': { kind: 'rejoined-original', epoch: 'epoch-2' },
  'original-lost': { kind: 'native-ended', settledToolCallIds: [] },
  'already-settled': { kind: 'native-ended', settledToolCallIds: ['native-b', 'native-a'] },
  'indeterminate': { kind: 'unobservable', reason: 'lookup-failed' },
};
const choices = {
  'defer': { kind: 'defer' },
  'deliver-original': { kind: 'deliver-original' },
  'settle-interrupted': { kind: 'settle-interrupted', reason: 'endpoint-lost' },
  'paired-repair': { kind: 'paired-repair' },
  'continue-new-turn': { kind: 'continue-new-turn', successorRunId: 'run-next' },
  'redispatch': { kind: 'redispatch', executionGeneration: 'generation-2', replay: 'not-begun' },
};
const accepted = (adapter, situation, mechanism, admission) => mechanism === 'defer'
  || (mechanism === 'settle-interrupted' && ['warm', 'rejoinable', 'original-lost'].includes(situation))
  || (mechanism === 'deliver-original' && adapter === 'codex' && situation === 'warm' && admission === 'fixture');

function batch(adapter = 'codex', change = {}) {
  const parsed = parsePendingFrontendBatch({ value: envelope(adapter, change), expected: { adapter, session } });
  assert.equal(parsed.kind, 'ok');
  return parsed.value;
}
function assess(observation, adapter = 'codex', admission = 'production', change = {}) {
  const result = assessFrontendRestore({ batch: batch(adapter, change), observation, admission });
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  return result.value;
}
const decisionFor = (situation, mechanism, revision = 'app-v1') => ({ formatVersion: 1, situationKey: situation.key,
  policyRevision: revision, ...choices[mechanism] });
const error = (code) => ({ kind: 'error', error: { code } });

test('every adapter, situation, admission and mechanism is accepted or rejected per the capability table', () => {
  let cases = 0;
  for (const adapter of adapters) for (const [kind, observation] of Object.entries(observations)) {
    for (const admission of ['production', 'fixture']) {
      const situation = assess(observation, adapter, admission);
      assert.equal(situation.kind, kind);
      assert.deepEqual(situation.options.map((option) => option.mechanism),
        mechanisms.filter((mechanism) => accepted(adapter, kind, mechanism, admission)));
      for (const mechanism of mechanisms) {
        const result = validateRestoreDecision({ situation, decision: decisionFor(situation, mechanism) });
        if (accepted(adapter, kind, mechanism, admission)) {
          assert.deepEqual(result, { kind: 'ok', value: decisionFor(situation, mechanism) }, `${adapter} ${kind} ${admission} ${mechanism}`);
        } else {
          assert.deepEqual(result, error('mechanism-unavailable'), `${adapter} ${kind} ${admission} ${mechanism}`);
        }
        cases += 1;
      }
    }
  }
  assert.equal(cases, 3 * 5 * 2 * 6);
});

test('options carry honest delivery classes and qualification labels', () => {
  assert.deepEqual(frontendRestoreDelivery, {
    'defer': 'not-delivered', 'deliver-original': 'original-call', 'settle-interrupted': 'not-delivered',
    'paired-repair': 'paired-by-id', 'continue-new-turn': 'unpaired-input', 'redispatch': 'not-delivered',
  });
  const warm = assess(observations.warm, 'codex', 'fixture');
  assert.deepEqual(warm.options, [
    { mechanism: 'defer', delivery: 'not-delivered', qualification: 'native-free' },
    { mechanism: 'deliver-original', delivery: 'original-call', qualification: 'fixture-only' },
    { mechanism: 'settle-interrupted', delivery: 'not-delivered', qualification: 'native-free' },
  ]);
  for (const kind of Object.keys(observations)) {
    for (const adapter of adapters) {
      for (const option of assess(observations[kind], adapter, 'fixture').options) {
        assert(kind === 'warm' || option.delivery !== 'original-call', 'No cold situation offers original-call delivery.');
      }
    }
  }
});

test('capability tables name paired repair as unavailable everywhere and settle and defer as native-free', () => {
  for (const adapter of adapters) {
    const table = frontendRestoreCapabilities[adapter];
    assert(Object.isFrozen(table));
    assert.deepEqual(Object.keys(table).sort(), [...mechanisms].sort());
    for (const mechanism of ['paired-repair', 'continue-new-turn', 'redispatch']) assert.equal(table[mechanism].kind, 'unavailable');
    for (const mechanism of ['defer', 'settle-interrupted']) {
      assert.equal(table[mechanism].kind, 'supported');
      assert.equal(table[mechanism].api.qualification, 'native-free');
    }
    assert.equal(table['deliver-original'].kind, adapter === 'codex' ? 'supported' : 'unavailable');
  }
  assert.match(frontendRestoreCapabilities.codex['paired-repair'].reason, /thread\/inject_items/);
  assert.match(frontendRestoreCapabilities.codex['paired-repair'].reason, /turn\/start\.toolOutput/);
  assert.deepEqual(frontendRestoreCapabilities.codex['deliver-original'].api.qualification, 'fixture-only');
  assert.deepEqual(frontendRestoreCapabilities.codex['deliver-original'].api.situations, ['warm']);
});

test('observations classify epochs, partial output and unobservable native state', () => {
  const cases = [
    [{ kind: 'live-original', epoch: 'epoch-2' }, 'indeterminate', 'epoch-conflict'],
    [{ kind: 'rejoined-original', epoch: 'epoch-1' }, 'indeterminate', 'epoch-conflict'],
    [{ kind: 'native-ended', settledToolCallIds: ['native-a'] }, 'indeterminate', 'partial-native-output'],
    [{ kind: 'unobservable', reason: 'session-missing' }, 'indeterminate', 'session-missing'],
    [{ kind: 'unobservable', reason: 'unsupported' }, 'indeterminate', 'unsupported'],
  ];
  for (const [observation, kind, reason] of cases) {
    const situation = assess(observation);
    assert.equal(situation.kind, kind);
    assert.equal(situation.reason, reason);
    assert.deepEqual(situation.options.map((option) => option.mechanism), ['defer']);
  }
  assert.equal(assess(observations.rejoinable).epoch, 'epoch-2');
  for (const observation of [
    null, {}, { kind: 'other' }, { kind: 'live-original' }, { kind: 'live-original', epoch: 'epoch-1', extra: 1 },
    { kind: 'native-ended', settledToolCallIds: ['unknown'] }, { kind: 'native-ended', settledToolCallIds: ['native-a', 'native-a'] },
    { kind: 'native-ended' }, { kind: 'unobservable', reason: 'private' },
  ]) {
    assert.deepEqual(assessFrontendRestore({ batch: batch(), observation, admission: 'production' }), error('invalid-input'));
  }
  assert.deepEqual(assessFrontendRestore({ batch: batch(), observation: observations.warm, admission: 'any' }), error('invalid-input'));
});

test('situation keys are deterministic and change with the batch, observation and admission', () => {
  const first = assess(observations['original-lost']);
  assert.match(first.key, /^sha256:[0-9a-f]{64}$/);
  assert.equal(assess(observations['original-lost']).key, first.key);
  const others = [
    assess(observations['original-lost'], 'codex', 'fixture'),
    assess(observations['original-lost'], 'codex', 'production', { epoch: 'epoch-9' }),
    assess(observations['original-lost'], 'codex', 'production', { calls: [call('b'), call('a')] }),
    assess(observations['original-lost'], 'codex', 'production', { calls: [{ ...call('a'), argumentsDigest: hash('c') }, call('b')] }),
    assess(observations['original-lost'], 'pi'),
    assess(observations.indeterminate),
  ];
  assert.equal(new Set([first.key, ...others.map((situation) => situation.key)]).size, others.length + 1);
  assert(Object.isFrozen(first) && Object.isFrozen(first.options) && Object.isFrozen(first.batch.calls));
});

test('no policy defers, a throwing policy defers and an unavailable policy choice is rejected', async () => {
  const situation = assess(observations['original-lost']);
  const deferred = { formatVersion: 1, situationKey: situation.key, policyRevision: frontendRestoreDefaultRevision, kind: 'defer' };
  assert.deepEqual(await decideFrontendRestore({ situation, policy: null }), { kind: 'ok', value: deferred });
  assert.deepEqual(await decideFrontendRestore({ situation, policy: { revision: 'app-v1', decide: () => { throw new Error('private'); } } }),
    { kind: 'ok', value: deferred });
  assert.deepEqual(await decideFrontendRestore({ situation, policy: { revision: 'app-v1', decide: async () => Promise.reject(new Error('x')) } }),
    { kind: 'ok', value: deferred });
  assert.deepEqual(await decideFrontendRestore({ situation, policy: { revision: 'app-v1', decide: async () => choices['settle-interrupted'] } }),
    { kind: 'ok', value: decisionFor(situation, 'settle-interrupted') });
  for (const mechanism of ['paired-repair', 'continue-new-turn', 'redispatch', 'deliver-original']) {
    assert.deepEqual(await decideFrontendRestore({ situation, policy: { revision: 'app-v1', decide: () => choices[mechanism] } }),
      error('mechanism-unavailable'));
  }
  assert.deepEqual(await decideFrontendRestore({ situation, policy: { revision: 'app-v1', decide: () => ({ kind: 'retry' }) } }),
    error('invalid-input'));
  for (const policy of [{ revision: '', decide: () => choices.defer }, { revision: 'app-v1' }, { revision: 'app-v1', decide: 'defer' },
    undefined, { revision: 'app-v1', decide: () => choices.defer, extra: true }]) {
    assert.deepEqual(await decideFrontendRestore({ situation, policy }), error('invalid-input'));
  }
  for (const chosen of [null, 'defer', Object.create(choices.defer),
    new Proxy({ kind: 'defer' }, { ownKeys() { throw new Error('private'); } })]) {
    assert.deepEqual(await decideFrontendRestore({ situation, policy: { revision: 'app-v1', decide: () => chosen } }), error('invalid-input'));
  }
  assert.deepEqual(await decideFrontendRestore(null), error('invalid-input'));
});

test('decisions are write-once by situation key with idempotent replay', () => {
  const situation = assess(observations['original-lost']);
  const compare = (stored, proposed) => compareRestoreDecisions({ situation, stored, proposed });
  const settle = decisionFor(situation, 'settle-interrupted');
  const defer = decisionFor(situation, 'defer');
  assert.deepEqual(compare(null, settle), { kind: 'ok', value: { effect: 'write', decision: settle } });
  assert.deepEqual(compare(settle, { ...settle }), { kind: 'ok', value: { effect: 'replay', decision: settle } });
  assert.deepEqual(compare(settle, { ...settle, policyRevision: 'app-v2' }), { kind: 'ok', value: { effect: 'replay', decision: settle } });
  assert.deepEqual(compare(settle, defer), { kind: 'ok', value: { effect: 'defer-ignored', decision: settle } });
  assert.deepEqual(compare(defer, settle), { kind: 'ok', value: { effect: 'replace-defer', decision: settle } });
  assert.deepEqual(compare(defer, defer), { kind: 'ok', value: { effect: 'replay', decision: defer } });
  assert.deepEqual(compare(settle, { ...settle, reason: 'expired' }), error('decision-conflict'));
  assert.deepEqual(compare(settle, { ...settle, reason: 'app-cancelled' }), error('decision-conflict'));
  for (const mechanism of ['paired-repair', 'continue-new-turn', 'redispatch', 'deliver-original']) {
    assert.deepEqual(compare(null, decisionFor(situation, mechanism)), error('mechanism-unavailable'));
    assert.deepEqual(compare(decisionFor(situation, mechanism), settle), error('mechanism-unavailable'));
  }
  const warm = assess(observations.warm, 'codex', 'fixture');
  const original = decisionFor(warm, 'deliver-original');
  assert.deepEqual(compareRestoreDecisions({ situation: warm, stored: original, proposed: decisionFor(warm, 'settle-interrupted') }),
    error('decision-conflict'));
  assert.deepEqual(compare(settle, { ...settle, situationKey: hash('f') }), error('stale-situation'));
  assert.deepEqual(compare({ ...settle, situationKey: hash('f') }, settle), error('stale-situation'));
  assert.deepEqual(validateRestoreDecision({ situation, decision: { ...settle, situationKey: hash('f') } }), error('stale-situation'));
  assert.deepEqual(compare({ ...settle, formatVersion: 2 }, settle), error('unsupported-version'));
  assert.deepEqual(compareRestoreDecisions({ situation, proposed: settle }), error('invalid-input'));
  for (const invalid of [undefined, {}, { ...settle, reason: undefined }, { ...defer, reason: undefined }, { ...settle, extra: true },
    { ...defer, successorRunId: 'run' }, { ...settle, situationKey: 'not-a-digest' }, { ...settle, policyRevision: '' }, { ...settle, kind: 'retry' },
    Object.create(settle), Object.defineProperty({ ...settle }, 'reason', { get: () => 'expired', enumerable: true })]) {
    assert.deepEqual(compare(settle, invalid), error('invalid-input'));
  }
});

test('situations are re-derived, so tampered or forged situations are rejected everywhere', async () => {
  const situation = assess(observations['original-lost']);
  const forged = [
    [{ ...situation, options: [...situation.options, { mechanism: 'deliver-original', delivery: 'original-call', qualification: 'qualified' }] }, 'stale-situation'],
    [{ ...situation, kind: 'warm' }, 'stale-situation'],
    [{ ...situation, admission: 'fixture' }, 'stale-situation'],
    [{ ...situation, batch: { ...situation.batch, epoch: 'epoch-9' } }, 'stale-situation'],
    [{ ...situation, key: hash('d') }, 'stale-situation'],
    [{ ...situation, kind: 'bogus' }, 'invalid-input'],
    [{ ...situation, key: 'x' }, 'invalid-input'],
    [{ ...situation, kind: 'rejoinable', epoch: 'epoch-1' }, 'invalid-input'],
    [{ ...situation, reason: 'lookup-failed' }, 'invalid-input'],
    [{ key: hash('d') }, 'invalid-input'],
    [Object.create(situation), 'invalid-input'],
  ];
  for (const [value, code] of forged) {
    assert.deepEqual(validateRestoreDecision({ situation: value, decision: decisionFor(situation, 'defer') }), error(code));
    assert.deepEqual(frontendRestoreFact({ phase: 'required', situation: value }), error(code));
    assert.deepEqual(await decideFrontendRestore({ situation: value, policy: null }), error(code));
    assert.deepEqual(compareRestoreDecisions({ situation: value, stored: null, proposed: decisionFor(situation, 'defer') }), error(code));
  }
  const reordered = Object.fromEntries(Object.entries(situation).reverse());
  assert.equal(validateRestoreDecision({ situation: reordered, decision: decisionFor(situation, 'defer') }).kind, 'ok');
});

test('CUSTOM facts are versioned, carry only public correlations and never encode a terminal', () => {
  const situation = assess(observations['original-lost']);
  const required = frontendRestoreFact({ phase: 'required', situation });
  assert.deepEqual(required, { kind: 'ok', value: { kind: 'custom', namespace: 'switchboard.frontend-restore', schemaVersion: '1',
    name: 'frontend-restore', publicPayload: { sourceRunId: 'run-source', toolCallIds: ['public-a', 'public-b'],
      situation: { kind: 'original-lost', key: situation.key }, phase: 'required', options: [
        { mechanism: 'defer', deliveryClass: 'not-delivered', qualification: 'native-free' },
        { mechanism: 'settle-interrupted', deliveryClass: 'not-delivered', qualification: 'native-free' }] } } });
  const decided = frontendRestoreFact({ phase: 'decided', situation, decision: decisionFor(situation, 'settle-interrupted') });
  assert.deepEqual(decided.value.publicPayload, { sourceRunId: 'run-source', toolCallIds: ['public-a', 'public-b'],
    situation: { kind: 'original-lost', key: situation.key }, phase: 'decided', policyRevision: 'app-v1',
    mechanism: 'settle-interrupted', deliveryClass: 'not-delivered', qualification: 'native-free' });
  const warm = assess(observations.warm, 'codex', 'fixture');
  assert.deepEqual(frontendRestoreFact({ phase: 'decided', situation: warm, decision: decisionFor(warm, 'deliver-original') }).value.publicPayload,
    { sourceRunId: 'run-source', toolCallIds: ['public-a', 'public-b'], situation: { kind: 'warm', key: warm.key }, phase: 'decided',
      policyRevision: 'app-v1', mechanism: 'deliver-original', deliveryClass: 'original-call', qualification: 'fixture-only' });
  const indeterminate = assess(observations.indeterminate);
  assert.deepEqual(frontendRestoreFact({ phase: 'required', situation: indeterminate }).value.publicPayload.situation,
    { kind: 'indeterminate', key: indeterminate.key, reason: 'lookup-failed' });
  for (const fact of [required.value, decided.value]) {
    assert.equal(fact.kind, 'custom');
    const serialized = JSON.stringify(fact);
    for (const secret of ['native-a', 'turn-a', 'epoch-1', 'thread-a', 'codex', ...Object.values(binding)]) assert(!serialized.includes(secret), secret);
    assert(!/run-finished|run-failed|RUN_FINISHED|RUN_ERROR/.test(serialized));
  }
  assert.deepEqual(frontendRestoreFact({ phase: 'decided', situation, decision: decisionFor(situation, 'paired-repair') }), error('mechanism-unavailable'));
  assert.deepEqual(frontendRestoreFact({ phase: 'decided', situation, decision: { ...decisionFor(situation, 'defer'), situationKey: hash('e') } }),
    error('stale-situation'));
  assert.deepEqual(frontendRestoreFact({ phase: 'finished', situation }), error('invalid-input'));
});

test('boundary parsing rejects malformed or mismatched batch envelopes', () => {
  const parse = (value, expected = { adapter: 'codex', session }) => parsePendingFrontendBatch({ value, expected });
  const parsed = parse(envelope());
  assert.deepEqual(parsed, { kind: 'ok', value: envelope() });
  assert(Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.calls[0].target));
  const otherSession = { ...session, opaque: 'thread-b' };
  const cases = [
    [envelope('claude'), 'adapter-mismatch'],
    [envelope('codex', { session: { ...session, binding: { ...binding, account: 'other' } },
      calls: [{ ...call('a'), target: { ...call('a').target, session: { ...session, binding: { ...binding, account: 'other' } } } }] }), 'binding-mismatch'],
    [envelope('codex', { session: otherSession, calls: [{ ...call('a'), target: { ...call('a').target, session: otherSession } }] }), 'session-mismatch'],
    [envelope('codex', { calls: [{ ...call('a'), target: { ...call('a').target, session: otherSession } }] }), 'session-mismatch'],
    [envelope('codex', { formatVersion: 2 }), 'unsupported-version'],
    ...[undefined, null, [], 'batch', {}].map((value) => [value, 'invalid-input']),
    ...[0, -1, 1.5, '1', undefined].map((formatVersion) => [envelope('codex', { formatVersion }), 'invalid-input']),
    [envelope('other'), 'invalid-input'],
    [envelope('codex', { calls: [] }), 'invalid-input'],
    [envelope('codex', { calls: 'call' }), 'invalid-input'],
    [envelope('codex', { calls: Array.from({ length: frontendRestoreLimits.maxCalls + 1 }, (_, index) => call(String(index))) }), 'invalid-input'],
    [envelope('codex', { calls: [call('a'), call('a')] }), 'invalid-input'],
    [envelope('codex', { calls: [call('a'), { ...call('b'), publicToolCallId: 'public-a' }] }), 'invalid-input'],
    [envelope('codex', { calls: [{ ...call('a'), argumentsDigest: 'sha256:short' }] }), 'invalid-input'],
    [envelope('codex', { calls: [{ ...call('a'), definitionDigest: hash('A') }] }), 'invalid-input'],
    [envelope('codex', { calls: [{ ...call('a'), target: { ...call('a').target, kind: 'approval' } }] }), 'invalid-input'],
    [envelope('codex', { calls: [{ ...call('a'), extra: true }] }), 'invalid-input'],
    [envelope('codex', { nativeTurnId: '' }), 'invalid-input'],
    [envelope('codex', { epoch: 'epoch\n1' }), 'invalid-input'],
    [envelope('codex', { sourceRunId: 'x'.repeat(1025) }), 'invalid-input'],
    [envelope('codex', { extra: true }), 'invalid-input'],
    [envelope('codex', { session: { ...session, formatVersion: 2 } }), 'unsupported-version'],
  ];
  for (const [value, code] of cases) assert.deepEqual(parse(value), error(code), JSON.stringify(value)?.slice(0, 200));
  assert.deepEqual(parse(envelope(), { adapter: 'other', session }), error('invalid-input'));
  assert.deepEqual(parse(envelope(), null), error('invalid-input'));
  const hostile = new Proxy(envelope(), { getOwnPropertyDescriptor() { throw new Error('private'); } });
  assert.deepEqual(parse(hostile), error('invalid-input'));
  assert.deepEqual(parse(Object.create(envelope())), error('invalid-input'));
  assert.deepEqual(parse(envelope('codex', { nativeTurnId: undefined })), error('invalid-input'));
  let reads = 0;
  const flipping = Object.defineProperty(envelope(), 'epoch', { enumerable: true, get: () => (reads++ ? 'epoch-2' : 'epoch-1') });
  assert.deepEqual(parse(flipping), error('invalid-input'));
  const flippingObservation = Object.defineProperty({ kind: 'live-original' }, 'epoch', { enumerable: true, get: () => 'epoch-1' });
  assert.deepEqual(assessFrontendRestore({ batch: batch(), observation: flippingObservation, admission: 'production' }), error('invalid-input'));
  assert.deepEqual(assessFrontendRestore({ batch: batch(), observation: Object.create(observations.warm), admission: 'production' }), error('invalid-input'));
  const reordered = Object.fromEntries(Object.entries(envelope()).reverse());
  assert.equal(assess(observations.warm, 'codex', 'production').key,
    assessFrontendRestore({ batch: reordered, observation: observations.warm, admission: 'production' }).value.key);
});
