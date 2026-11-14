import assert from 'node:assert/strict';
import test from 'node:test';
import { createAguiProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, BasicFact, ProjectionBounds, ProjectionOptions, ProjectionResult } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const bounds: ProjectionBounds = { maxEntities: 1, maxPayloadBytes: 4096, maxJsonDepth: 16, maxJsonNodes: 256 };
const options: ProjectionOptions = { threadId: 'host-thread', runId: 'host-run', sourceKey: 'authorized-public-source', bounds };
const start: BasicFact = { kind: 'run-started' };
const finish: BasicFact = { kind: 'run-finished', outcome: 'success' };
const failed: BasicFact = { kind: 'run-failed', failure: 'native-failure' };
let batch = 0;

function actor(overrides: Partial<ProjectionOptions> = {}): AguiProjection {
  const result = createAguiProjection({ ...options, ...overrides });
  assert.equal(result.kind, 'ok');
  assert(result.kind === 'ok');
  return result.value;
}

function mapped(projection: AguiProjection, fact: BasicFact) {
  const result = projection.accept(fact);
  assert.equal(result.kind, 'mapped');
  assert(result.kind === 'mapped');
  collectEvents(`lifecycle/${batch++}/${fact.kind}`, result.events);
  assert.equal(result.events.length, 1);
  return result.events;
}

function rejected(result: ProjectionResult, code: string): void {
  assert.deepEqual(result, { kind: 'error', error: { code } });
  assert(Object.isFrozen(result));
  if (result.kind === 'error') assert(Object.isFrozen(result.error));
}

function malformed(projection: AguiProjection, value: unknown, code = 'invalid-input'): void {
  rejected(Reflect.apply(projection.accept, projection, [value]), code);
  rejected(projection.accept(start), 'closed');
}

test('actors map observed lifecycle independently and preserve exact host IDs', () => {
  const first = actor({ threadId: 'thread\ud800', runId: 'run/雪', parentRunId: 'parent' });
  const second = actor({ runId: 'second' });
  const firstStart = mapped(first, { kind: 'run-started', timestamp: -Number.MAX_SAFE_INTEGER });
  assert.deepEqual(firstStart, [{ type: 'RUN_STARTED', threadId: 'thread\ud800', runId: 'run/雪',
    parentRunId: 'parent', protocolVersion: '1.0', timestamp: -Number.MAX_SAFE_INTEGER }]);
  assert.deepEqual(mapped(second, start), [{ type: 'RUN_STARTED', threadId: options.threadId,
    runId: 'second', protocolVersion: '1.0' }]);
  assert.deepEqual(mapped(first, { ...finish, timestamp: Number.MAX_SAFE_INTEGER }), [{
    type: 'RUN_FINISHED', threadId: 'thread\ud800', runId: 'run/雪', outcome: { type: 'success' }, timestamp: Number.MAX_SAFE_INTEGER,
  }]);
  assert.deepEqual(mapped(second, { kind: 'run-finished', outcome: 'cancelled' }), [{
    type: 'RUN_FINISHED', threadId: options.threadId, runId: 'second', outcome: { type: 'cancelled' },
  }]);
});

test('native errors are safe before start, during runs, and after either finish', () => {
  for (const prefix of [[], [start], [start, finish], [start, { kind: 'run-finished', outcome: 'cancelled' }]] satisfies BasicFact[][]) {
    const projection = actor();
    for (const fact of prefix) mapped(projection, fact);
    assert.deepEqual(mapped(projection, { kind: 'run-failed', failure: 'transport-failure', timestamp: 0 }), [{
      type: 'RUN_ERROR', code: 'transport-failure', message: 'The native run transport failed.', timestamp: 0,
    }]);
    rejected(projection.accept(failed), 'invalid-order');
    rejected(projection.accept(start), 'closed');
  }
  assert.deepEqual(mapped(actor(), failed), [{ type: 'RUN_ERROR', code: 'native-failure', message: 'The native run failed.' }]);
});

test('invalid order faults only its actor and close is idempotent in every phase', () => {
  for (const [prefix, next] of [[[], finish], [[start], start], [[start, finish], finish]] satisfies [BasicFact[], BasicFact][]) {
    const projection = actor();
    for (const fact of prefix) mapped(projection, fact);
    rejected(projection.accept(next), 'invalid-order');
    rejected(projection.accept(failed), 'closed');
    projection.close();
    projection.close();
  }
  for (const prefix of [[], [start], [failed], [start, finish]] satisfies BasicFact[][]) {
    const projection = actor();
    for (const fact of prefix) mapped(projection, fact);
    projection.close();
    projection.close();
    rejected(projection.accept(failed), 'closed');
  }
  mapped(actor(), start);
});

test('options and result JSON are detached and recursively frozen', () => {
  const input = { ...options, bounds: { ...bounds } };
  const projection = actor(input);
  input.threadId = 'changed';
  input.bounds.maxPayloadBytes = 1;
  mapped(projection, start);
  const shared = { text: 'original', values: [null, true, 2, '雪', '\ud800'] };
  const result = { left: shared, right: shared, ['__proto__']: { safe: true } };
  const events = mapped(projection, { kind: 'run-finished', outcome: 'success', result });
  const before = JSON.stringify(events);
  shared.text = 'changed';
  shared.values.push(false);
  assert.equal(JSON.stringify(events), before);
  const event = events[0];
  assert(event?.type === 'RUN_FINISHED');
  assert.equal(event.threadId, options.threadId);
  assert.throws(() => Reflect.apply(Array.prototype.push, events, [{}]), TypeError);
  const resultObject = event.result;
  assert(resultObject && typeof resultObject === 'object' && !Array.isArray(resultObject));
  assert('left' in resultObject && 'right' in resultObject && '__proto__' in resultObject);
  assert.throws(() => Object.defineProperty(resultObject.left, 'text', { value: 'rewrite' }), TypeError);
  const right = resultObject.right;
  assert(right && typeof right === 'object' && 'values' in right);
  assert(Object.isFrozen(right.values));
  assert.deepEqual(resultObject.__proto__, { safe: true });
});

test('only the implemented fact shape and safe failure classifications are accepted', () => {
  for (const value of [null, [], {}, { kind: 'text-complete' }, { ...start, rawEvent: 'secret' },
    { ...failed, failure: new Error('secret') }, { ...failed, failure: 'secret' },
    { kind: 'run-finished', outcome: 'interrupt' }, { kind: 'run-finished', outcome: 'cancelled', result: null },
    ...[NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1, '0'].map(timestamp => ({ ...start, timestamp }))]) {
    malformed(actor(), value);
  }
});

test('JSON rejects accessors, custom prototypes, sparse arrays, cycles, and nonfinite values', () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let getterCalls = 0;
  const accessor = { get secret() { getterCalls++; throw new Error('secret'); } };
  const hidden = Object.defineProperty({}, 'secret', { value: 1 });
  const extraArray = Object.assign([1], { extra: true });
  for (const result of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('secret'), () => 1,
    new Date(), Object.create({ secret: true }), cycle, accessor, hidden, new Array(1), extraArray, { [Symbol('secret')]: 1 }]) {
    const projection = actor();
    mapped(projection, start);
    malformed(projection, { ...finish, result });
  }
  assert.equal(getterCalls, 0);
});

test('proxy failures and revoked proxies never escape or expose thrown values', () => {
  let thrownInspections = 0;
  const thrown = new Proxy({}, { getPrototypeOf() { thrownInspections++; throw new Error('secret'); } });
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const value: object = new Proxy({ ...start }, { [trap]: () => { throw thrown; } });
    malformed(actor(), value);
    const made: ReturnType<typeof createAguiProjection> = Reflect.apply(createAguiProjection, undefined, [value]);
    assert.deepEqual(made, { kind: 'error', error: { code: 'invalid-input' } });
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  malformed(actor(), revoked.proxy);
  assert.equal(thrownInspections, 0);
});

test('reentrant accept or close aborts the whole outer plan without emitting', () => {
  for (const close of [false, true]) {
    const projection = actor();
    let entered = false;
    const fact = new Proxy({ ...start }, { ownKeys(target) {
      if (!entered) {
        entered = true;
        if (close) projection.close();
        else rejected(projection.accept(start), 'invalid-input');
      }
      return Reflect.ownKeys(target);
    } });
    malformed(projection, fact, close ? 'closed' : 'invalid-input');
  }
});

test('all bounds require positive safe integers and options reject hostile or extra fields', () => {
  for (const key of Object.keys(bounds)) {
    for (const value of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const made = Reflect.apply(createAguiProjection, undefined, [{ ...options, bounds: { ...bounds, [key]: value } }]);
      assert.deepEqual(made, { kind: 'error', error: { code: 'invalid-input' } });
    }
  }
  for (const value of [{ ...options, bounds: { ...bounds, maxJsonDepth: 129 } },
    { ...options, sourceKey: undefined }, { ...options, runId: 4 }, { ...options, parentRunId: null },
    { ...options, sessionToken: 'secret' }, Object.defineProperty({}, 'bounds', { get() { throw 'secret'; } })]) {
    assert.deepEqual(Reflect.apply(createAguiProjection, undefined, [value]), { kind: 'error', error: { code: 'invalid-input' } });
  }
  assert.deepEqual(createAguiProjection({ ...options, runId: 'x'.repeat(4096) }), { kind: 'error', error: { code: 'bounds-exceeded' } });
});

test('input depth, nodes, members, UTF-8 strings and encoded output overhead consume budgets', () => {
  const cases: [Partial<ProjectionBounds>, unknown][] = [
    [{ maxJsonDepth: 3 }, [[[[0]]]]],
    [{ maxJsonNodes: 32 }, Array(32).fill(0)],
    [{ maxJsonNodes: 32 }, Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(index), 0]))],
    [{ maxPayloadBytes: 256 }, '雪'.repeat(100)],
    [{ maxPayloadBytes: 256 }, '\ud800'.repeat(50)],
    [{ maxPayloadBytes: 256 }, 'x'.repeat(180)],
  ];
  for (const [limits, result] of cases) {
    const projection = actor({ bounds: { ...bounds, ...limits } });
    mapped(projection, start);
    malformed(projection, { ...finish, result }, 'bounds-exceeded');
  }
  const projection = actor({ bounds: { ...bounds, maxJsonDepth: 2 } });
  mapped(projection, start);
  malformed(projection, finish, 'bounds-exceeded');
  for (const result of [null, false, 0, '', [], {}, Object.create(null)]) {
    const projection = actor();
    mapped(projection, start);
    const events = mapped(projection, { kind: 'run-finished', outcome: 'success', result });
    assert(events[0]);
    assert.equal(Object.hasOwn(events[0], 'result'), result !== null);
  }
});

test('the exact serialized batch byte ceiling succeeds and one byte less faults', () => {
  const fact: BasicFact = { kind: 'run-finished', outcome: 'success', result: '雪'.repeat(90) };
  const reference = actor();
  mapped(reference, start);
  const events = mapped(reference, fact);
  const bytes = Buffer.byteLength(JSON.stringify(events));
  assert(Buffer.byteLength(JSON.stringify(fact)) < bytes - 1);
  const exact = actor({ bounds: { ...bounds, maxPayloadBytes: bytes } });
  mapped(exact, start);
  assert.deepEqual(mapped(exact, fact), events);
  const short = actor({ bounds: { ...bounds, maxPayloadBytes: bytes - 1 } });
  mapped(short, start);
  malformed(short, fact, 'bounds-exceeded');
});
