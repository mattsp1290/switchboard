import assert from 'node:assert/strict';
import test from 'node:test';
import { createAguiProjection, describeProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, NativeRef, ProjectionBounds, ProjectionEvent, ProjectionFact, SubagentFact, TerminalFact } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const ref = (id: string, scope: readonly string[] = ['native']): NativeRef => ({ scope, id });
const child = ref('child'), sibling = ref('sibling'), message = ref('message'), tool = ref('tool'), interrupt = ref('interrupt');
const bounds: ProjectionBounds = { maxEntities: 32, maxPayloadBytes: 16384, maxJsonDepth: 24, maxJsonNodes: 2048 };
const start: SubagentFact = { kind: 'subagent-started', subagent: child, name: '' };
const end: SubagentFact = { kind: 'subagent-finished', subagent: child };
const success: TerminalFact = { kind: 'run-finished', outcome: 'success' };
const interrupted: TerminalFact = { kind: 'run-finished', outcome: 'interrupt', interrupts: [{ interrupt, reason: '', owner: child }] };
const suspended: SubagentFact = { ...end, outcome: { type: 'suspended', interrupts: [interrupt] } };
const encoded = (kind: string, native: NativeRef, source = 'source') => JSON.stringify([1, source, kind, native.scope, native.id]);
let batch = 0;
function actor(limits: Partial<ProjectionBounds> = {}, sourceKey = 'source'): AguiProjection {
  const made = createAguiProjection({ threadId: 'thread', runId: 'run', sourceKey, bounds: { ...bounds, ...limits } });
  assert(made.kind === 'ok');
  return made.value;
}
function mapped(projection: AguiProjection, fact: ProjectionFact): readonly ProjectionEvent[] {
  const result = projection.accept(fact);
  assert(result.kind === 'mapped', JSON.stringify(result));
  if (result.events.length) collectEvents(`subagents/${batch++}/${fact.kind}`, result.events);
  assert(Object.isFrozen(result.events));
  return result.events;
}
function running(prefix: readonly ProjectionFact[] = [], limits: Partial<ProjectionBounds> = {}): AguiProjection {
  const projection = actor(limits);
  for (const fact of [{ kind: 'run-started' }, ...prefix] satisfies ProjectionFact[]) mapped(projection, fact);
  return projection;
}
function rejects(projection: AguiProjection, fact: unknown, code = 'invalid-input'): void {
  assert.deepEqual(Reflect.apply(projection.accept, projection, [fact]), { kind: 'error', error: { code } });
  assert.deepEqual(projection.accept(success), { kind: 'error', error: { code: 'closed' } });
}
const terminals: readonly Exclude<SubagentFact, { kind: 'subagent-started' }>[] = [end, { ...end, outcome: { type: 'success' } }, suspended,
  { ...end, outcome: { type: 'suspended' } }, { ...end, outcome: { type: 'suspended', interrupts: [] } },
  { kind: 'subagent-failed', subagent: child, failure: 'native-failure' },
  { kind: 'subagent-failed', subagent: child, failure: 'transport-failure' }];

test('subagent metadata keeps native availability separate and gaps emit nothing', () => {
  assert.deepEqual(describeProjection('subagents'), { kind: 'ok', value: {
    family: 'subagents', representability: 'represented', availability: 'undeclared', qualification: 'undeclared',
  } });
  const projection = running();
  assert.deepEqual(mapped(projection, { kind: 'not-observable', family: 'subagents' }), []);
  mapped(projection, success);
});

test('all lifecycle spellings preserve selected values and safe errors allow root work', () => {
  for (const terminal of terminals) {
    const projection = running();
    assert.deepEqual(mapped(projection, { ...start, description: '', timestamp: 0 }), [{
      type: 'SUBAGENT_STARTED', subagentRunId: encoded('subagent', child), name: '', description: '', timestamp: 0,
    }]);
    const event: ProjectionEvent | undefined = mapped(projection, { ...terminal, timestamp: 1 })[0];
    assert(event && 'subagentRunId' in event && event.subagentRunId === encoded('subagent', child));
    assert.equal(event.timestamp, 1);
    if (terminal.kind === 'subagent-finished') {
      assert(event.type === 'SUBAGENT_FINISHED');
      const expected = terminal.outcome;
      assert.deepEqual(event.outcome, expected?.type === 'suspended'
        ? { type: 'suspended', ...('interrupts' in expected ? { interruptIds: expected.interrupts?.map(id => encoded('interrupt', id)) } : {}) }
        : expected);
      assert.equal('outcome' in event, expected !== undefined);
    } else {
      assert(event.type === 'SUBAGENT_ERROR');
      assert.equal(event.code, terminal.failure);
      assert.equal(event.message, terminal.failure === 'native-failure' ? 'The native subagent failed.' : 'The native subagent transport failed.');
    }
    mapped(projection, { kind: 'text-complete', message, role: 'assistant', text: 'Root continues.' });
    mapped(projection, terminal === suspended ? interrupted : success);
  }
  for (const result of [null, false, 0, '', [null], { nested: null }]) {
    const event: ProjectionEvent | undefined = mapped(running([start]), { ...end, result })[0];
    assert(event?.type === 'SUBAGENT_FINISHED');
    assert.equal('result' in event, result !== null);
    if (result !== null) assert.deepEqual(event.result, result);
  }
});

test('announcement precedes every attribution route and IDs never restart or terminate twice', () => {
  const observations: readonly ProjectionFact[] = [
    { kind: 'text-complete', message, role: 'assistant', text: '', owner: child },
    { kind: 'tool-started', tool, name: '', owner: child },
    { kind: 'step-started', step: ref('step'), owner: child },
    { kind: 'reasoning-started', span: ref('span'), owner: child },
    { kind: 'reasoning-message-complete', message, role: 'reasoning', text: '', owner: child },
    ...(['message', 'tool'] as const).map(kind => ({ kind: 'reasoning-encrypted-value', target: kind === 'message'
      ? { kind, message } : { kind, tool }, encryptedValue: '', owner: child } satisfies ProjectionFact)),
    { kind: 'state-snapshot', snapshot: {}, owner: child }, { kind: 'state-delta', delta: [], owner: child },
    { kind: 'activity-snapshot', message, activityType: '', content: {}, owner: child },
    { kind: 'raw', namespace: 'n', schemaVersion: '1', publicPayload: {}, owner: child },
    { kind: 'custom', namespace: 'n', schemaVersion: '1', name: '', publicPayload: {}, owner: child },
    { kind: 'not-observable', family: 'subagents', owner: child },
    ...(['assistant', 'user', 'system', 'developer', 'reasoning'] as const).map(role => ({ kind: 'messages-snapshot',
      messages: [{ id: message, role, content: '', subagentRunId: child }] } satisfies ProjectionFact)),
    { kind: 'messages-snapshot', messages: [{ id: message, role: 'activity', activityType: '', content: {}, subagentRunId: child }] },
    { kind: 'messages-snapshot', messages: [{ id: message, role: 'tool', toolCallId: tool, content: '', subagentRunId: child }] },
  ];
  for (const observation of observations) rejects(running([observation]), start, 'identity-conflict');
  rejects(running([start]), start, 'identity-conflict');
  for (const terminal of terminals) {
    rejects(running(), terminal, 'invalid-order');
    rejects(running([start, terminal]), start, 'identity-conflict');
    rejects(running([start, terminal]), terminal, 'invalid-order');
  }
  const attribution = running([{ kind: 'state-snapshot', snapshot: {}, owner: child }]);
  mapped(attribution, success);
});

test('siblings and active or closed announced parents stay independent without correlation foreign keys', () => {
  for (const closeParent of [false, true]) {
    const projection = running([start]);
    if (closeParent) mapped(projection, end);
    const nested: ProjectionEvent | undefined = mapped(projection, { ...start, subagent: sibling, parentSubagent: child,
      parentTool: tool, parentMessage: message })[0];
    assert.deepEqual(nested, { type: 'SUBAGENT_STARTED', subagentRunId: encoded('subagent', sibling), name: '',
      parentSubagentRunId: encoded('subagent', child), parentToolCallId: encoded('tool', tool), parentMessageId: encoded('message', message) });
    if (!closeParent) mapped(projection, end);
    mapped(projection, { kind: 'text-complete', message, role: 'user', text: '', owner: sibling });
    mapped(projection, { ...end, subagent: sibling });
    mapped(projection, success);
  }
  for (const prefix of [[], [{ kind: 'state-snapshot', snapshot: {}, owner: sibling }] satisfies ProjectionFact[]]) {
    rejects(running(prefix), { ...start, parentSubagent: sibling }, 'invalid-order');
  }
  rejects(running(), { ...start, parentSubagent: child }, 'invalid-order');
  const projection = running([{ kind: 'text-complete', message, role: 'user', text: '' },
    { kind: 'tool-started', tool, name: '', owner: sibling }]);
  mapped(projection, { ...start, parentMessage: message, parentTool: tool });
  mapped(projection, end);
  mapped(projection, { kind: 'tool-arguments-ended', tool, owner: sibling });
  mapped(projection, success);
});

const streams: readonly (readonly [ProjectionFact, ProjectionFact])[] = [
  [{ kind: 'text-started', message, role: 'assistant', owner: child }, { kind: 'text-ended', message, owner: child }],
  [{ kind: 'tool-started', tool, name: '', owner: child }, { kind: 'tool-arguments-ended', tool, owner: child }],
  [{ kind: 'step-started', step: ref('step'), owner: child }, { kind: 'step-finished', step: ref('step'), owner: child }],
  [{ kind: 'reasoning-message-started', message, role: 'reasoning', owner: child }, { kind: 'reasoning-message-ended', message, owner: child }],
  [{ kind: 'reasoning-started', span: ref('span'), owner: child }, { kind: 'reasoning-ended', span: ref('span'), owner: child }],
];
test('child terminals leave owned streams open and accept later attribution with immutable owners', () => {
  for (const terminal of terminals) for (const [opener, closer] of streams) {
    const projection = running([start, { ...start, subagent: sibling }, opener]);
    mapped(projection, terminal);
    mapped(projection, { kind: 'text-complete', message: ref('sibling-message'), role: 'assistant', text: '', owner: sibling });
    mapped(projection, closer);
    mapped(projection, { kind: 'text-complete', message: ref('later'), role: 'assistant', text: '', owner: child });
    mapped(projection, { ...end, subagent: sibling });
    mapped(projection, terminal === suspended ? interrupted : success);
    rejects(running([start, opener, terminal]), { ...closer, owner: sibling }, 'identity-conflict');
  }
});

test('every root finish independently requires all actual streams and announced invocations closed', () => {
  for (const terminal of [success, { kind: 'run-finished', outcome: 'cancelled' }, interrupted] satisfies TerminalFact[]) {
    rejects(running([start]), terminal, 'invalid-order');
    for (const [opener] of streams) rejects(running([start, opener, end]), terminal, 'invalid-order');
  }
  const projection = running([start, { ...start, subagent: sibling }, ...streams.filter(([opener]) => opener.kind !== 'reasoning-message-started').map(([opener]) => opener), suspended]);
  assert.deepEqual(mapped(projection, { kind: 'run-failed', failure: 'native-failure' }), [{
    type: 'RUN_ERROR', code: 'native-failure', message: 'The native run failed.',
  }]);
  rejects(projection, success, 'invalid-order');
});

test('suspension references match exact terminal IDs and owners while preserving duplicates and empty forms', () => {
  for (const references of [[interrupt], [interrupt, interrupt]]) {
    const projection = running([start]);
    const event: ProjectionEvent | undefined = mapped(projection, { ...end, outcome: { type: 'suspended', interrupts: references } })[0];
    assert(event?.type === 'SUBAGENT_FINISHED' && event.outcome?.type === 'suspended');
    assert.deepEqual(event.outcome.interruptIds, references.map(id => encoded('interrupt', id)));
    mapped(projection, interrupted);
  }
  for (const owner of [undefined, sibling]) {
    rejects(running([start, suspended]), { ...interrupted, interrupts: [{ interrupt, reason: '', ...(owner ? { owner } : {}) }] }, 'identity-conflict');
  }
  rejects(running([start, suspended]), { ...interrupted, interrupts: [{ interrupt: ref('missing'), reason: '', owner: child }] }, 'identity-conflict');
  for (const terminal of [success, { kind: 'run-finished', outcome: 'cancelled' }] satisfies TerminalFact[]) {
    rejects(running([start, suspended]), terminal, 'identity-conflict');
  }
  for (const outcome of [{ type: 'suspended' }, { type: 'suspended', interrupts: [] }] as const) {
    const projection = running([start, { ...start, subagent: sibling, parentSubagent: child },
      { ...end, outcome }, { ...end, subagent: sibling, outcome: { type: 'suspended', interrupts: [interrupt] } }]);
    mapped(projection, { ...interrupted, interrupts: [{ interrupt, reason: '', owner: sibling }] });
    mapped(running([start, { ...end, outcome }]), success);
  }
  const second = ref('second');
  const projection = running([start, { ...start, subagent: sibling }, suspended,
    { ...end, subagent: sibling, outcome: { type: 'suspended', interrupts: [second] } }]);
  mapped(projection, { ...interrupted, interrupts: [{ interrupt: second, reason: '', owner: sibling },
    { interrupt: ref('root-extra'), reason: '' }, { interrupt, reason: '', owner: child }] });
  mapped(running([start, suspended]), { kind: 'run-failed', failure: 'transport-failure' });
});

test('the existing entity budget charges observations, correlations, invocation tombstones and interrupt IDs once', () => {
  for (const maxEntities of [2, 3]) {
    const projection = running([], { maxEntities });
    const fact = { ...start, parentTool: tool, parentMessage: message };
    if (maxEntities === 2) rejects(projection, fact, 'bounds-exceeded');
    else {
      mapped(projection, fact);
      mapped(projection, end);
      mapped(projection, { kind: 'tool-started', tool, name: '' });
      mapped(projection, { kind: 'tool-arguments-ended', tool });
      mapped(projection, { ...success, pendingTools: [tool] });
    }
  }
  const projection = running([start], { maxEntities: 2 });
  mapped(projection, { ...end, outcome: { type: 'suspended', interrupts: [interrupt, interrupt] } });
  mapped(projection, interrupted);
  rejects(running([start], { maxEntities: 1 }), suspended, 'bounds-exceeded');
  rejects(running([start, end], { maxEntities: 1 }), { ...start, subagent: sibling }, 'bounds-exceeded');
  const known = running([{ kind: 'reasoning-encrypted-value', target: { kind: 'tool', tool }, encryptedValue: '', owner: child }], { maxEntities: 2 });
  rejects(known, start, 'identity-conflict');
  const ordering = running([{ ...start, parentTool: tool }, end,
    { kind: 'tool-started', tool: ref('first'), name: '' }, { kind: 'tool-arguments-ended', tool: ref('first') },
    { kind: 'tool-started', tool, name: '' }, { kind: 'tool-arguments-ended', tool }]);
  mapped(ordering, { ...success, pendingTools: [ref('first'), tool] });
});

test('captured results and references are detached, frozen and scoped across independent actors', () => {
  const mutable = { scope: ['before'], id: 'before' }, result = { nested: [null, 1] };
  const projection = running();
  const first = mapped(projection, { ...start, subagent: mutable });
  mutable.scope.push('after');
  mutable.id = 'after';
  assert.equal(first[0]?.type === 'SUBAGENT_STARTED' && first[0].subagentRunId, encoded('subagent', ref('before', ['before'])));
  const terminal = mapped(projection, { ...end, subagent: ref('before', ['before']), result })[0];
  result.nested.push(2);
  assert(terminal?.type === 'SUBAGENT_FINISHED');
  assert.deepEqual(terminal.result, { nested: [null, 1] });
  assert(Object.isFrozen(terminal.result));
  assert(terminal.result && typeof terminal.result === 'object' && 'nested' in terminal.result && Object.isFrozen(terminal.result.nested));
  const ids = new Set<string>();
  for (const native of [child, ref('child', ['other']), ref('\ud800'), ref('\ud801')]) for (const source of ['source', 'other']) {
    const one = actor({}, source), two = actor({}, source);
    mapped(one, { kind: 'run-started' });
    mapped(two, { kind: 'run-started' });
    const event: ProjectionEvent | undefined = mapped(one, { ...start, subagent: native })[0];
    assert.deepEqual(mapped(two, { ...start, subagent: native }), [event]);
    assert(event?.type === 'SUBAGENT_STARTED');
    ids.add(event.subagentRunId);
    rejects(one, { ...start, subagent: native }, 'identity-conflict');
    mapped(two, { ...end, subagent: native });
    mapped(two, success);
  }
  assert.equal(ids.size, 8);
});

test('closed shapes, hostile inputs and bounded capture reject atomically with fixed local errors', () => {
  for (const invalid of [{ ...start, subagent: 'wire' }, { ...start, subagent: { scope: [0], id: '' } },
    { ...start, parentTool: { scope: [], id: '', extra: '' } }, { ...start, name: null }, { ...start, description: 1 },
    { ...start, timestamp: 0.1 }, { ...start, owner: child }, { ...start, usage: [] },
    { ...end, usage: [] }, { ...end, outcome: { type: 'success', interrupts: [] } },
    { ...end, outcome: { type: 'suspended', interrupts: null } }, { ...end, outcome: { type: 'cancelled' } },
    { ...end, outcome: { type: 'suspended', interrupts: ['wire'] } },
    { kind: 'subagent-failed', subagent: child, failure: 'private-stack' },
    { kind: 'subagent-failed', subagent: child, failure: 'native-failure', message: 'private-stack' }]) rejects(running([start]), invalid);
  let reads = 0;
  const accessor = { get value() { reads++; return 'private'; } };
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const result of [accessor, cycle, new Date(), Object.create({ inherited: true }), { value: 1n }]) rejects(running([start]), { ...end, result });
  assert.equal(reads, 0);
  rejects(running([start], { maxJsonDepth: 4 }), { ...end, result: { a: { b: { c: { d: 1 } } } } }, 'bounds-exceeded');
  rejects(running([start], { maxJsonNodes: 40 }), { ...end, result: Array(40).fill(0) }, 'bounds-exceeded');
  rejects(running([start], { maxJsonNodes: 60 }), { ...end, outcome: { type: 'suspended', interrupts: Array(10).fill(interrupt) } }, 'bounds-exceeded');
  const source = 's'.repeat(100), baseline = actor({}, source);
  mapped(baseline, { kind: 'run-started' });
  const expected = mapped(baseline, { ...start, parentTool: tool, parentMessage: message });
  const bytes = Buffer.byteLength(JSON.stringify(expected));
  for (const maxPayloadBytes of [bytes, bytes - 1]) {
    const bounded = actor({ maxPayloadBytes }, source);
    mapped(bounded, { kind: 'run-started' });
    if (maxPayloadBytes === bytes) assert.deepEqual(mapped(bounded, { ...start, parentTool: tool, parentMessage: message }), expected);
    else rejects(bounded, { ...start, parentTool: tool, parentMessage: message }, 'bounds-exceeded');
  }
});


test('simultaneous sibling streams and suspension reference mutation preserve independent captured owners', () => {
  const pair = streams[0];
  assert(pair);
  const projection = running([start, { ...start, subagent: sibling }, pair[0],
    { kind: 'text-started', message: ref('other'), role: 'assistant', owner: sibling }]);
  mapped(projection, end);
  mapped(projection, { kind: 'text-content', message: ref('other'), delta: 'still open', owner: sibling });
  mapped(projection, pair[1]);
  mapped(projection, { kind: 'text-ended', message: ref('other'), owner: sibling });
  mapped(projection, { ...end, subagent: sibling });
  mapped(projection, success);
  const references = [{ scope: ['native'], id: 'interrupt' }];
  const suspendedActor = running([start]);
  const event = mapped(suspendedActor, { ...end, outcome: { type: 'suspended', interrupts: references } })[0];
  const original = references[0];
  assert(original);
  original.id = 'changed';
  references.push({ scope: [], id: 'new' });
  assert(event?.type === 'SUBAGENT_FINISHED' && event.outcome?.type === 'suspended');
  assert.deepEqual(event.outcome.interruptIds, [encoded('interrupt', interrupt)]);
  assert(Object.isFrozen(event.outcome.interruptIds));
  mapped(suspendedActor, interrupted);
  const correlated = running([], { maxEntities: 4 });
  mapped(correlated, { ...start, parentMessage: message, parentTool: tool });
  mapped(correlated, { ...start, subagent: sibling, parentMessage: message, parentTool: tool });
  mapped(correlated, end);
  mapped(correlated, { ...end, subagent: sibling });
  mapped(correlated, success);
});
