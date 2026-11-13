import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCheckpointReference, parseSessionReference, sessionLimits, validateSessionDiscoveryBounds,
} from '@mattsp1290/switchboard';

const binding = {
  engine: 'acme/native', nativeVersion: '1.2', account: 'account-a',
  authorizedScope: 'workspace-a', nativeFormat: 'acme/session-v3',
};
const session = { kind: 'session', formatVersion: 1, binding, opaque: 'native-session-a' };
const checkpoint = {
  kind: 'checkpoint', formatVersion: 1, binding, sessionOpaque: session.opaque, opaque: 'native-checkpoint-a',
};
const parse = (value, expected = binding) => parseSessionReference({ value, expected });
const check = (value, nativeSession = session) => parseCheckpointReference({ value, session: nativeSession });
const error = (result, code) => assert.deepEqual(result, { kind: 'error', error: { code } });

test('installed session parsers copy and freeze known envelope fields', () => {
  const mutableBinding = { ...binding };
  const mutable = { ...session, binding: mutableBinding, extra: { ignored: true } };
  const expected = { ...binding };
  const result = parse(mutable, expected);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.value, session);
  assert.notEqual(result.value, mutable);
  assert.notEqual(result.value.binding, mutableBinding);
  mutableBinding.account = 'changed';
  mutable.opaque = 'changed';
  expected.engine = 'changed';
  assert.deepEqual(result.value, session);
  assert(Object.isFrozen(result.value));
  assert(Object.isFrozen(result.value.binding));
  assert.throws(() => { result.value.opaque = 'changed'; }, TypeError);
  const checkpointInput = { ...checkpoint, binding: { ...binding } };
  const checked = check(checkpointInput);
  assert.equal(checked.kind, 'ok');
  checkpointInput.sessionOpaque = 'changed';
  checkpointInput.binding.engine = 'changed';
  assert.deepEqual(checked.value, checkpoint);
  assert(Object.isFrozen(checked.value));
  assert(Object.isFrozen(checked.value.binding));
});

test('every native binding dimension must match for sessions and checkpoints', () => {
  for (const key of Object.keys(binding)) {
    const changed = { ...binding, [key]: 'other' };
    error(parse({ ...session, binding: changed }), 'binding-mismatch');
    error(parse(session, changed), 'binding-mismatch');
    error(check({ ...checkpoint, binding: changed }), 'binding-mismatch');
  }
  error(check({ ...checkpoint, sessionOpaque: 'other-session' }), 'session-mismatch');
  error(check(checkpoint, { ...session, opaque: 'other-session' }), 'session-mismatch');
});

test('persisted envelopes reject malformed shapes, text and unsupported versions', () => {
  for (const value of [null, undefined, [], 1, 'session', {}, { ...session, kind: 'other' }]) {
    error(parse(value), 'invalid-reference');
  }
  for (const value of ['', '   ', 'control\ncharacter', '\u007f', '\u0085', 'x'.repeat(sessionLimits.opaqueLength + 1)]) {
    error(parse({ ...session, opaque: value }), 'invalid-reference');
    error(check({ ...checkpoint, opaque: value }), 'invalid-reference');
    error(check({ ...checkpoint, sessionOpaque: value }), 'invalid-reference');
  }
  for (const key of Object.keys(binding)) {
    for (const value of [undefined, null, 7, '', ' ', 'bad\tvalue', 'x'.repeat(sessionLimits.identifierLength + 1)]) {
      error(parse({ ...session, binding: { ...binding, [key]: value } }), 'invalid-reference');
      error(parse(session, { ...binding, [key]: value }), 'invalid-reference');
      error(check({ ...checkpoint, binding: { ...binding, [key]: value } }), 'invalid-reference');
    }
  }
  for (const formatVersion of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    error(parse({ ...session, formatVersion }), 'invalid-reference');
  }
  for (const formatVersion of [2, Number.MAX_SAFE_INTEGER]) {
    error(parse({ ...session, formatVersion }), 'unsupported-version');
    error(check({ ...checkpoint, formatVersion }), 'unsupported-version');
  }
  error(parse(checkpoint), 'invalid-reference');
  error(check(session), 'invalid-reference');
  error(check({ ...checkpoint, sessionOpaque: undefined }), 'invalid-reference');
  error(check(checkpoint, { ...session, formatVersion: 2 }), 'unsupported-version');
});

test('opaque references are not interpreted or authenticated by core', () => {
  const opaque = 'adapter-issued / token ? a=b';
  assert.equal(parse({ ...session, opaque }).value.opaque, opaque);
  assert.equal(parse({ ...session, opaque: 'x'.repeat(sessionLimits.opaqueLength) }).kind, 'ok');
  const longBinding = Object.fromEntries(Object.keys(binding).map((key) => [key, 'x'.repeat(sessionLimits.identifierLength)]));
  assert.equal(parse({ ...session, binding: longBinding }, longBinding).kind, 'ok');
});

test('bounds require positive integers below all ceilings and copy the result', () => {
  const input = { maxResults: 2, maxExamined: 10, maxDurationMs: 100 };
  const result = validateSessionDiscoveryBounds(input);
  assert.equal(result.kind, 'ok');
  input.maxResults = 100;
  assert.deepEqual(result.value, { maxResults: 2, maxExamined: 10, maxDurationMs: 100 });
  assert(Object.isFrozen(result.value));
  for (const value of [null, [], {}, 2]) error(validateSessionDiscoveryBounds(value), 'invalid-bounds');
  for (const key of ['maxResults', 'maxExamined', 'maxDurationMs']) {
    for (const value of [undefined, null, '2', 0, -1, 1.5, NaN, Infinity, sessionLimits[key] + 1]) {
      error(validateSessionDiscoveryBounds({ maxResults: 1, maxExamined: 1, maxDurationMs: 1, [key]: value }), 'invalid-bounds');
    }
  }
  error(validateSessionDiscoveryBounds({ maxResults: 2, maxExamined: 1, maxDurationMs: 1 }), 'invalid-bounds');
  assert.equal(validateSessionDiscoveryBounds({ maxResults: 1000, maxExamined: 100000, maxDurationMs: 60000 }).kind, 'ok');
});
