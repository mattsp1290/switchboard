import assert from 'node:assert/strict';
import test from 'node:test';
import { createAguiProjection, describeProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, NativeJsonPatch, NativeRef, ProjectionBounds, ProjectionEvent, ProjectionFact } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const bounds: ProjectionBounds = { maxEntities: 24, maxPayloadBytes: 8192, maxJsonDepth: 20, maxJsonNodes: 512 };
const ref = (id: string, scope: readonly string[] = []): NativeRef => ({ scope, id });
const message = ref('activity');
const owner = ref('child');
const snapshot = { kind: 'activity-snapshot', message, activityType: 'search', content: { found: 0 } } satisfies ProjectionFact;
const delta = { kind: 'activity-delta', message, activityType: 'search', patch: [] } satisfies ProjectionFact;
const finish = { kind: 'run-finished', outcome: 'success' } satisfies ProjectionFact;
const encoded = (kind: string, native: NativeRef, source = 'source') => JSON.stringify([1, source, kind, native.scope, native.id]);
let batch = 0;

function mapped(actor: AguiProjection, fact: ProjectionFact): readonly ProjectionEvent[] {
  const result = actor.accept(fact);
  assert.equal(result.kind, 'mapped');
  assert(result.kind === 'mapped');
  if (result.events.length) collectEvents(`advanced/${batch++}/${fact.kind}`, result.events);
  assert(Object.isFrozen(result.events));
  for (const event of result.events) assert(Object.isFrozen(event));
  return result.events;
}

function actor(limits: Partial<ProjectionBounds> = {}, start = true, sourceKey = 'source'): AguiProjection {
  const made = createAguiProjection({ threadId: 'thread', runId: 'run', sourceKey, bounds: { ...bounds, ...limits } });
  assert(made.kind === 'ok');
  if (start) mapped(made.value, { kind: 'run-started' });
  return made.value;
}

function rejects(projection: AguiProjection, fact: unknown, code = 'invalid-input'): void {
  assert.deepEqual(Reflect.apply(projection.accept, projection, [fact]), { kind: 'error', error: { code } });
  assert.deepEqual(projection.accept({ kind: 'run-started' }), { kind: 'error', error: { code: 'closed' } });
}

const operations = [
  { op: 'add', path: '', value: { id: 'application-id' } },
  { op: 'remove', path: '', value: null, vendor: { kept: true } },
  { op: 'replace', path: '', value: null },
  { op: 'move', from: '', path: '/moved' },
  { op: 'copy', from: '', path: '/copied' },
  { op: 'test', path: '', value: null },
] satisfies NativeJsonPatch;

test('state snapshots preserve every JSON root and state patches preserve six open operation shapes', () => {
  const projection = actor();
  for (const value of [null, false, 0, '', ['state'], { id: 'application-id' }]) {
    assert.deepEqual(mapped(projection, { kind: 'state-snapshot', snapshot: value, owner, timestamp: 0 }), [{
      type: 'STATE_SNAPSHOT', snapshot: value, subagentRunId: encoded('subagent', owner), timestamp: 0,
    }]);
  }
  for (const operation of operations) {
    assert.deepEqual(mapped(projection, { kind: 'state-delta', delta: [operation] }), [{ type: 'STATE_DELTA', delta: [operation] }]);
  }
  mapped(projection, { kind: 'state-delta', delta: [] });
  mapped(projection, { kind: 'state-delta', delta: [{ op: 'add', path: '/a~0b/~1/雪', value: null }] });
  mapped(projection, finish);
  mapped(actor(), { kind: 'state-delta', delta: operations });
});

test('activity snapshots preserve replacement omission, explicit flags and message-domain identity', () => {
  const projection = actor();
  for (const replace of [undefined, false, true]) {
    const events = mapped(projection, { ...snapshot, ...(replace === undefined ? {} : { replace }), owner, timestamp: 7 });
    assert.deepEqual(events, [{ type: 'ACTIVITY_SNAPSHOT', messageId: encoded('message', message), activityType: 'search',
      content: { found: 0 }, subagentRunId: encoded('subagent', owner), timestamp: 7,
      ...(replace === undefined ? {} : { replace }) }]);
  }
  const activityOperations = [
    { op: 'add', path: '', value: { found: 1 } }, { op: 'remove', path: '/found' },
    { op: 'replace', path: '', value: { found: 2 } }, { op: 'move', from: '/found', path: '/moved' },
    { op: 'copy', from: '', path: '/copied' }, { op: 'test', path: '', value: {} },
  ] satisfies NativeJsonPatch;
  for (const operation of activityOperations) mapped(projection, { ...delta, patch: [operation], owner });
  mapped(projection, { ...delta, owner, patch: [
    { op: 'replace', path: '', value: null }, { op: 'replace', path: '', value: {} },
  ] });
  mapped(projection, finish);
  for (const native of [ref('same', ['a', 'b']), ref('same', ['a,b']), ref('\ud800'), ref('\ud801')]) {
    const events = mapped(actor(), { ...snapshot, message: native });
    assert.deepEqual(events.map(event => event.type === 'ACTIVITY_SNAPSHOT' ? event.messageId : ''), [encoded('message', native)]);
  }
});

test('replacing activity snapshots remint ownership while preserving snapshots and deltas require it', () => {
  const projection = actor();
  mapped(projection, { ...snapshot, owner });
  mapped(projection, { ...snapshot, activityType: 'replacement' });
  mapped(projection, { ...snapshot, replace: false, activityType: 'ignored type' });
  mapped(projection, { ...delta, activityType: 'retyped by delta' });
  mapped(projection, { ...snapshot, owner, replace: true, activityType: 'child again' });
  mapped(projection, { ...delta, owner, activityType: 'new child type' });
  mapped(projection, finish);
  for (const fact of [{ ...snapshot, owner, replace: false }, { ...delta, owner }]) {
    const root = actor();
    mapped(root, snapshot);
    rejects(root, fact, 'identity-conflict');
  }
  const child = actor();
  mapped(child, { ...snapshot, owner });
  rejects(child, delta, 'identity-conflict');
  rejects(actor(), delta, 'invalid-order');
  const createdByPreserve = actor();
  mapped(createdByPreserve, { ...snapshot, owner, replace: false });
  mapped(createdByPreserve, { ...delta, owner });
});

test('activity and basic message identities share collision and assistant-parent constraints', () => {
  const text = { kind: 'text-complete', message, role: 'assistant', text: '' } satisfies ProjectionFact;
  for (const basic of [text, { kind: 'tool-started', tool: ref('tool'), name: 'lookup', parentMessage: message }] satisfies ProjectionFact[]) {
    const projection = actor();
    mapped(projection, basic);
    rejects(projection, snapshot, 'identity-conflict');
  }
  const projection = actor();
  mapped(projection, snapshot);
  rejects(projection, text, 'identity-conflict');
  const parent = actor();
  mapped(parent, snapshot);
  rejects(parent, { kind: 'tool-started', tool: ref('tool'), name: 'lookup', parentMessage: message }, 'identity-conflict');
  const result = actor();
  mapped(result, { kind: 'tool-started', tool: ref('tool'), name: 'lookup' });
  mapped(result, { kind: 'tool-arguments-ended', tool: ref('tool') });
  mapped(result, { kind: 'tool-result', tool: ref('tool'), resultMessage: message, content: '' });
  rejects(result, snapshot, 'identity-conflict');
});

test('raw and custom output contain only explicit versioned public selections', () => {
  const projection = actor();
  const publicPayload = { selected: 'caller-authorized', id: 'data-id', nested: [null, true] };
  const envelope = { namespace: 'com.example.native', schemaVersion: '1', publicPayload };
  assert.deepEqual(mapped(projection, { kind: 'raw', ...envelope, owner }), [{
    type: 'RAW', subagentRunId: encoded('subagent', owner), source: envelope.namespace, event: envelope,
  }]);
  assert.deepEqual(mapped(projection, { kind: 'custom', ...envelope, name: 'com.example.progress' }), [{
    type: 'CUSTOM', name: 'com.example.progress', value: envelope,
  }]);
  for (const publicPayload of [null, false, 0, '', []]) mapped(projection, { kind: 'raw', namespace: 'n', schemaVersion: '1', publicPayload });
  mapped(projection, finish);
});

test('not-observable emits no events, retains a usable actor and never supplies native evidence', () => {
  const projection = actor();
  for (const family of ['state', 'activity', 'raw', 'custom'] as const) {
    assert.deepEqual(mapped(projection, { kind: 'not-observable', family }), []);
    assert.deepEqual(describeProjection(family), { kind: 'ok', value: {
      family, representability: 'represented', availability: 'undeclared', qualification: 'undeclared',
    } });
  }
  mapped(projection, snapshot);
  mapped(projection, finish);
  rejects(actor({}, false), { kind: 'not-observable', family: 'state' }, 'invalid-order');
  const finished = actor();
  mapped(finished, finish);
  rejects(finished, { kind: 'not-observable', family: 'state' }, 'invalid-order');
});

test('availability and qualification preserve only explicit caller assertions', () => {
  for (const availability of ['supported', 'unavailable', 'unsupported', 'undeclared'] as const) {
    for (const qualification of ['qualified', 'unqualified', 'undeclared'] as const) {
      const evidence = { availability, qualification };
      const result = describeProjection('state', evidence);
      assert.deepEqual(result, { kind: 'ok', value: { family: 'state', representability: 'represented', ...evidence } });
      assert(Object.isFrozen(result));
      assert(result.kind === 'ok' && Object.isFrozen(result.value));
    }
  }
  for (const evidence of [{ availability: null }, { qualification: 'available' }, { availability: true }, { source: 'native' }]) {
    assert.deepEqual(Reflect.apply(describeProjection, undefined, ['state', evidence]), { kind: 'error', error: { code: 'invalid-input' } });
  }
  assert.deepEqual(Reflect.apply(describeProjection, undefined, ['unknown']), { kind: 'error', error: { code: 'invalid-input' } });
});

test('captured values and patches are detached and recursively frozen', () => {
  const selected = { nested: { id: 'data-id' }, list: [1] };
  const value = { op: 'add', path: '/value', value: selected } satisfies NativeJsonPatch[number];
  const projection = actor();
  for (const fact of [{ kind: 'state-snapshot', snapshot: selected }, { ...snapshot, content: selected },
    { kind: 'state-delta', delta: [value] }, { kind: 'raw', namespace: 'n', schemaVersion: '1', publicPayload: selected }] satisfies ProjectionFact[]) {
    const events = mapped(projection, fact);
    const before = JSON.stringify(events);
    selected.nested.id += 'changed';
    selected.list.push(2);
    assert.equal(JSON.stringify(events), before);
    const frozen = events[0];
    assert(frozen);
    if (frozen.type === 'STATE_DELTA') {
      const operation = frozen.delta[0];
      assert(operation && 'value' in operation && Object.isFrozen(operation.value));
    }
    if (frozen.type === 'ACTIVITY_SNAPSHOT') assert(Object.isFrozen(frozen.content.nested));
    if (frozen.type === 'STATE_SNAPSHOT') assert(Object.isFrozen(frozen.snapshot));
    if (frozen.type === 'RAW') assert(Object.isFrozen(frozen.event));
  }
});

test('malformed pointers, required fields and non-JSON values fault without partial output', () => {
  for (const patch of [null, {}, [{ op: 'unknown', path: '' }], [{ op: 'add', path: '' }], [{ op: 'test', path: '', value: undefined }],
    [{ op: 'copy', path: '' }], [{ op: 'move', path: '', from: 0 }], [{ op: 'remove', path: 'missing/slash' }],
    [{ op: 'remove', path: '/a~' }], [{ op: 'remove', path: '/a~2b' }]]) {
    rejects(actor(), { kind: 'state-delta', delta: patch });
  }
  for (const fact of [{ kind: 'state-snapshot' }, { ...snapshot, content: null }, { ...snapshot, content: [] },
    { ...snapshot, replace: null }, { ...delta, patch: [{ op: 'test', path: 2, value: null }] },
    { kind: 'raw', namespace: 'n', schemaVersion: '1' }, { kind: 'custom', namespace: 'n', schemaVersion: '1', publicPayload: null },
    { kind: 'raw', namespace: 'n', schemaVersion: 1, publicPayload: null }, { ...snapshot, timestamp: 0.5 },
    { kind: 'not-observable', family: 'unknown' }, { ...snapshot, rawEvent: { private: true } },
    { kind: 'raw', namespace: '', schemaVersion: '1', publicPayload: null },
    { kind: 'custom', namespace: 'n', schemaVersion: '', name: '', publicPayload: null }]) rejects(actor(), fact);
  for (const value of [null, false, 0, '', []]) {
    const projection = actor();
    mapped(projection, snapshot);
    rejects(projection, { ...delta, patch: [{ op: 'replace', path: '', value }] });
  }
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'private', { enumerable: true, get() { throw new Error('private'); } });
  for (const publicPayload of [cycle, accessor, new Date(), NaN, 1n, undefined]) {
    rejects(actor(), { kind: 'raw', namespace: 'n', schemaVersion: '1', publicPayload });
  }
});

test('activity identities and attribution observations consume the single entity ceiling', () => {
  const projection = actor({ maxEntities: 1 });
  mapped(projection, snapshot);
  mapped(projection, { ...snapshot, activityType: 'replaced' });
  rejects(projection, { ...snapshot, message: ref('second') }, 'bounds-exceeded');
  rejects(actor({ maxEntities: 1 }), { ...snapshot, owner }, 'bounds-exceeded');
  const attributed = actor({ maxEntities: 1 });
  mapped(attributed, { kind: 'state-snapshot', snapshot: null, owner });
  rejects(attributed, snapshot, 'bounds-exceeded');
  const independent = actor({ maxEntities: 1 });
  mapped(independent, snapshot);
  mapped(independent, finish);
});

test('expanded output bytes and value work limits cover complete advanced batches', () => {
  const sourceKey = 's'.repeat(120);
  const fact = { ...snapshot, owner };
  const events = mapped(actor({}, true, sourceKey), fact);
  const bytes = Buffer.byteLength(JSON.stringify(events));
  assert(bytes > Buffer.byteLength(JSON.stringify(fact)));
  assert.deepEqual(mapped(actor({ maxPayloadBytes: bytes }, true, sourceKey), fact), events);
  rejects(actor({ maxPayloadBytes: bytes - 1 }, true, sourceKey), fact, 'bounds-exceeded');
  rejects(actor({ maxJsonDepth: 5 }), { kind: 'state-snapshot', snapshot: [[[[[[]]]]]] }, 'bounds-exceeded');
  rejects(actor({ maxJsonNodes: 50 }), { kind: 'state-snapshot', snapshot: Array(50).fill(null) }, 'bounds-exceeded');
});
