import assert from 'node:assert/strict';
import test from 'node:test';
import { interactionLimits, parseInteractionContinuation, sessionLimits } from '@mattsp1290/switchboard';

const binding = { engine: 'fixture/native', nativeVersion: '1', account: 'account', authorizedScope: 'scope', nativeFormat: 'format' };
const session = { kind: 'session', formatVersion: 1, binding, opaque: 'session-a' };
const native = { namespace: 'fixture/native', schemaVersion: 1, data: { opaque: true } };
const approvalTarget = { kind: 'approval', session, nativeApprovalId: 'approval-a', tool: null };
const toolTarget = { kind: 'tool', session, nativeToolCallId: 'tool-a' };
const child = (id) => ({ kind: 'delegation', session, nativeDelegationId: id });
const approval = { kind: 'approval', target: approvalTarget, nativePolicy: native, request: native,
  choices: [{ nativeChoiceId: 'native-once', label: 'Native once' }, { nativeChoiceId: 'native-session', label: 'Native session' }] };
const approvalReply = { formatVersion: 1, kind: 'approval', target: approvalTarget, nativeChoiceId: 'native-once' };
const toolReply = { formatVersion: 1, kind: 'tool', outcome: { target: toolTarget, result: { kind: 'ok', value: native }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
const delegated = (target, kind = 'unknown') => ({ kind, target, delivery: { kind: 'unknown' }, ...(kind === 'completed' ? { result: { kind: 'error', error: native } } : {}) });
const delegation = { kind: 'delegation', targets: [child('a'), child('b')] };
const delegationReply = { formatVersion: 1, kind: 'delegation', outcomes: delegation.targets.map((target) => delegated(target)) };
const parse = (value, expected = approval) => parseInteractionContinuation({ value, expected });
const error = (value, code, ...expected) => assert.deepEqual(parseInteractionContinuation({ value, expected: expected.length ? expected[0] : approval }), { kind: 'error', error: { code } });
const changedSession = (target, change) => ({ ...target, session: { ...target.session, ...change } });

test('installed approval continuation preserves native choices with or without a tool', () => {
  assert.deepEqual(parse(approvalReply), { kind: 'ok', value: approvalReply });
  const withTool = { ...approvalTarget, tool: { nativeToolCallId: 'tool-a' } };
  assert.equal(parse({ ...approvalReply, target: withTool }, { ...approval, target: withTool }).kind, 'ok');
  for (const target of [withTool, { ...approvalTarget, nativeApprovalId: 'other' }]) error({ ...approvalReply, target }, 'target-mismatch');
  error(approvalReply, 'target-mismatch', { ...approval, target: withTool });
  error({ ...approvalReply, target: { ...withTool, tool: { nativeToolCallId: 'other' } } }, 'target-mismatch', { ...approval, target: withTool });
  for (const nativeChoiceId of ['permit', 'deny', 'host-correlation', 'not-advertised']) error({ ...approvalReply, nativeChoiceId }, 'choice-mismatch');
  error({ formatVersion: 1, kind: 'withhold' }, 'invalid-input');
});

test('every binding field, session token, target kind and native ID must correspond', () => {
  const cases = [
    [approvalReply, approval, (target) => ({ ...approvalReply, target }), approvalTarget],
    [toolReply, { kind: 'tool', target: toolTarget }, (target) => ({ ...toolReply, outcome: { ...toolReply.outcome, target } }), toolTarget],
    [delegationReply, delegation, (target) => ({ ...delegationReply, outcomes: [delegated(target), delegated(child('b'))] }), child('a')],
  ];
  for (const [reply, expected, replace, target] of cases) {
    assert.equal(parse(reply, expected).kind, 'ok');
    for (const key of Object.keys(binding)) error(replace(changedSession(target, { binding: { ...binding, [key]: 'other' } })), 'binding-mismatch', expected);
    error(replace(changedSession(target, { opaque: 'other' })), 'session-mismatch', expected);
  }
  error({ ...toolReply, outcome: { ...toolReply.outcome, target: { ...toolTarget, nativeToolCallId: 'other' } } }, 'target-mismatch', { kind: 'tool', target: toolTarget });
  for (const [reply, expected] of [[toolReply, approval], [approvalReply, delegation], [delegationReply, { kind: 'tool', target: toolTarget }]]) error(reply, 'target-mismatch', expected);
  error({ ...approvalReply, target: toolTarget }, 'invalid-input');
});

test('delegation requires an exact order-independent set, including session identity', () => {
  assert.equal(parse({ ...delegationReply, outcomes: [...delegationReply.outcomes].reverse() }, delegation).kind, 'ok');
  for (const outcomes of [[delegated(child('a'))], [...delegationReply.outcomes, delegated(child('c'))], [delegated(child('a')), delegated(child('c'))]]) error({ ...delegationReply, outcomes }, 'target-mismatch', delegation);
  error({ ...delegationReply, outcomes: [delegated(child('a')), delegated(child('a'))] }, 'invalid-input', delegation);
  error(delegationReply, 'invalid-input', { ...delegation, targets: [child('a'), child('a')] });
  const otherSession = changedSession(child('a'), { opaque: 'session-b' });
  const sameLocalId = { kind: 'delegation', targets: [child('a'), otherSession] };
  assert.equal(parse({ ...delegationReply, outcomes: [delegated(otherSession), delegated(child('a'))] }, sameLocalId).kind, 'ok');
});

test('effect, delivery and result facts allow their entire cross-product', () => {
  const results = [{ kind: 'ok', value: native }, { kind: 'error', error: native }];
  const effects = [{ kind: 'unknown' }, { kind: 'known', effect: 'none', evidence: native }, { kind: 'known', effect: 'occurred', evidence: native }];
  const deliveries = [{ kind: 'unknown' }, { kind: 'confirmed', evidence: native }];
  for (const result of results) for (const effect of effects) for (const delivery of deliveries) {
    const value = { ...toolReply, outcome: { target: toolTarget, result, effect, delivery } };
    assert.deepEqual(parse(value, { kind: 'tool', target: toolTarget }), { kind: 'ok', value });
  }
  for (const kind of ['completed', 'cancelled', 'unknown']) for (const delivery of deliveries) for (const result of results) {
    const value = { formatVersion: 1, kind: 'delegation', outcomes: [{ ...delegated(child('a'), kind), delivery, ...(kind === 'completed' ? { result } : {}) }] };
    assert.deepEqual(parse(value, { kind: 'delegation', targets: [child('a')] }), { kind: 'ok', value });
  }
});

test('malformed expected records and continuation envelopes fail without opaque errors', () => {
  for (const invalid of [undefined, null, [], 1, {}, { kind: 'other' }]) {
    error(invalid, 'invalid-input');
    error(approvalReply, 'invalid-input', invalid);
  }
  for (const formatVersion of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) error({ ...approvalReply, formatVersion }, 'invalid-input');
  for (const formatVersion of [2, Number.MAX_SAFE_INTEGER]) {
    error({ ...approvalReply, formatVersion }, 'unsupported-version');
    error({ ...approvalReply, target: changedSession(approvalTarget, { formatVersion }) }, 'unsupported-version');
    error(approvalReply, 'unsupported-version', { ...approval, target: changedSession(approvalTarget, { formatVersion }) });
  }
  for (const invalid of [undefined, '', ' ', '\n', '\u007f', '\u0085', 42, 'x'.repeat(sessionLimits.identifierLength + 1)]) {
    error({ ...approvalReply, nativeChoiceId: invalid }, 'invalid-input');
    for (const field of ['nativeApprovalId', 'tool', 'session']) error({ ...approvalReply, target: { ...approvalTarget, [field]: invalid } }, 'invalid-input');
    error(approvalReply, 'invalid-input', { ...approval, choices: [{ nativeChoiceId: 'once', label: invalid }] });
  }
  for (const key of Object.keys(binding)) error(approvalReply, 'invalid-input', { ...approval, target: changedSession(approvalTarget, { binding: { ...binding, [key]: '' } }) });
  for (const field of ['nativePolicy', 'request']) for (const invalid of [null, {}, { ...native, namespace: '' }, { ...native, schemaVersion: 0 }, { ...native, schemaVersion: 1.5 }, { ...native, schemaVersion: Number.MAX_SAFE_INTEGER + 1 }, { namespace: 'fixture', schemaVersion: 1 }]) error(approvalReply, 'invalid-input', { ...approval, [field]: invalid });
  for (const field of ['result', 'effect', 'delivery']) for (const invalid of [null, {}, { kind: 'bad' }]) error({ ...toolReply, outcome: { ...toolReply.outcome, [field]: invalid } }, 'invalid-input', { kind: 'tool', target: toolTarget });
  error({ ...toolReply, outcome: { ...toolReply.outcome, effect: { kind: 'known', effect: 'maybe', evidence: native } } }, 'invalid-input', { kind: 'tool', target: toolTarget });
  error({ ...toolReply, outcome: { ...toolReply.outcome, delivery: { kind: 'confirmed', evidence: { ...native, schemaVersion: -1 } } } }, 'invalid-input', { kind: 'tool', target: toolTarget });
  error({ ...delegationReply, outcomes: [delegated(child('a'), 'invalid')] }, 'invalid-input', delegation);
  error({ ...delegationReply, outcomes: [{ ...delegated(child('a'), 'completed'), result: null }] }, 'invalid-input', delegation);
});

test('choice and child lists are nonempty, bounded, dense and unique', () => {
  for (const choices of [[], null, new Array(1), [approval.choices[0], approval.choices[0]], Array.from({ length: interactionLimits.maxChoices + 1 }, (_, i) => ({ nativeChoiceId: `choice-${i}`, label: 'Choice' }))]) error(approvalReply, 'invalid-input', { ...approval, choices });
  for (const targets of [[], null, new Array(1), Array.from({ length: interactionLimits.maxDelegations + 1 }, (_, i) => child(`${i}`))]) error(delegationReply, 'invalid-input', { kind: 'delegation', targets });
  for (const outcomes of [[], null, new Array(1), Array.from({ length: interactionLimits.maxDelegations + 1 }, (_, i) => delegated(child(`${i}`)))]) error({ ...delegationReply, outcomes }, 'invalid-input', delegation);
  const choices = Array.from({ length: interactionLimits.maxChoices }, (_, i) => ({ nativeChoiceId: `choice-${i}`, label: 'Choice' }));
  assert.equal(parse({ ...approvalReply, nativeChoiceId: 'choice-0' }, { ...approval, choices }).kind, 'ok');
  const targets = Array.from({ length: interactionLimits.maxDelegations }, (_, i) => child(`${i}`));
  assert.equal(parse({ formatVersion: 1, kind: 'delegation', outcomes: targets.map((target) => delegated(target)) }, { kind: 'delegation', targets }).kind, 'ok');
});

test('known envelopes are copied and frozen, unknown fields discarded, opaque payloads retained', () => {
  const data = { arbitrary: new Map(), cycle: null };
  data.cycle = data;
  const input = structuredClone(toolReply);
  input.extra = 'ignored';
  input.outcome.result.value = { ...native, data, extra: true };
  input.outcome.effect = { kind: 'known', effect: 'occurred', evidence: { ...native, data } };
  input.outcome.delivery = { kind: 'confirmed', evidence: { ...native, data } };
  const parsed = parse(input, { kind: 'tool', target: toolTarget });
  assert.equal(parsed.kind, 'ok');
  const value = parsed.value;
  assert.equal(value.outcome.result.value.data, data);
  assert.equal(value.outcome.effect.evidence.data, data);
  assert.equal(value.outcome.delivery.evidence.data, data);
  assert.equal('extra' in value, false);
  assert.equal('extra' in value.outcome.result.value, false);
  input.outcome.target.session.binding.account = 'mutated';
  input.outcome.target.nativeToolCallId = 'mutated';
  input.outcome.result.value.namespace = 'mutated';
  assert.equal(value.outcome.target.session.binding.account, binding.account);
  assert.equal(value.outcome.target.nativeToolCallId, 'tool-a');
  assert.equal(value.outcome.result.value.namespace, native.namespace);
  for (const object of [parsed, value, value.outcome, value.outcome.target, value.outcome.target.session, value.outcome.target.session.binding, value.outcome.result, value.outcome.result.value, value.outcome.effect, value.outcome.effect.evidence, value.outcome.delivery, value.outcome.delivery.evidence]) assert(Object.isFrozen(object));
  assert.equal(Object.isFrozen(data), false);
  data.arbitrary.set('still', 'mutable');
  const accepted = parse({ ...approvalReply, target: { ...approvalTarget, tool: { nativeToolCallId: 'tool-a' } } }, { ...approval, target: { ...approvalTarget, tool: { nativeToolCallId: 'tool-a' } } });
  assert(Object.isFrozen(accepted.value.target.tool));
  const childInput = structuredClone(delegationReply);
  const children = parse(childInput, delegation).value;
  childInput.outcomes[0].target.nativeDelegationId = 'mutated';
  childInput.outcomes.push(delegated(child('c')));
  assert.equal(children.outcomes.length, 2);
  assert.equal(children.outcomes[0].target.nativeDelegationId, 'a');
  assert(Object.isFrozen(children.outcomes));
  assert(Object.isFrozen(children.outcomes[0]));
  assert.throws(() => children.outcomes.push(delegated(child('c'))), TypeError);
});


test('thrown proxies are redacted without inspecting their prototype or properties', () => {
  const thrown = new Proxy({}, {
    getPrototypeOf() { throw new Error('credential-canary-never-return'); },
    get() { throw new Error('credential-canary-never-return'); },
  });
  const input = { get kind() { throw thrown; } };
  for (const parsed of [parse(input), parse(approvalReply, input)]) {
    assert.deepEqual(parsed, { kind: 'error', error: { code: 'invalid-input' } });
    assert(Object.isFrozen(parsed));
    assert(Object.isFrozen(parsed.error));
  }
});

test('thrown revoked proxies return a frozen invalid-input outcome', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const input = { get kind() { throw proxy; } };
  for (const parsed of [parse(input), parse(approvalReply, input)]) {
    assert.deepEqual(parsed, { kind: 'error', error: { code: 'invalid-input' } });
    assert(Object.isFrozen(parsed));
    assert(Object.isFrozen(parsed.error));
  }
});

test('input-access exceptions are redacted and known fields are read once', () => {
  const canary = 'credential-canary-never-return';
  const throwing = (object, key) => Object.defineProperty(object, key, { get() { throw new Error(canary); } });
  error(throwing({ ...approvalReply }, 'kind'), 'invalid-input');
  error({ ...approvalReply, target: throwing({ ...approvalTarget }, 'session') }, 'invalid-input');
  error(approvalReply, 'invalid-input', { ...approval, request: throwing({ ...native }, 'namespace') });
  error(new Proxy({}, { get() { throw new Error(canary); } }), 'invalid-input');
  const reply = structuredClone(toolReply);
  reply.outcome.effect = { kind: 'known', effect: 'occurred', evidence: { ...native } };
  reply.outcome.delivery = { kind: 'confirmed', evidence: { ...native } };
  const counters = [];
  for (const [object, key] of [
    [reply, 'kind'], [reply, 'formatVersion'], [reply.outcome, 'target'],
    [reply.outcome.target, 'nativeToolCallId'], [reply.outcome.target.session, 'binding'],
    [reply.outcome.target.session.binding, 'engine'], [reply.outcome.target.session, 'opaque'],
    [reply.outcome.effect, 'kind'], [reply.outcome.effect, 'effect'],
    [reply.outcome.delivery, 'kind'], [reply.outcome.result.value, 'namespace'],
    [reply.outcome.result.value, 'schemaVersion'], [reply.outcome.result.value, 'data'],
  ]) {
    const initial = object[key];
    const count = { reads: 0 };
    counters.push(count);
    Object.defineProperty(object, key, { get() { count.reads += 1; if (count.reads > 1) throw new Error(canary); return initial; } });
  }
  assert.equal(parse(reply, { kind: 'tool', target: toolTarget }).kind, 'ok');
  assert(counters.every(({ reads }) => reads === 1));
  const extra = throwing({ ...toolTarget }, 'nativeApprovalId');
  assert.equal(parse({ ...toolReply, outcome: { ...toolReply.outcome, target: extra } }, { kind: 'tool', target: toolTarget }).kind, 'ok');
});
