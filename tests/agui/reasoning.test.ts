import assert from 'node:assert/strict';
import test from 'node:test';
import { createAguiProjection, describeProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, NativeRef, ProjectionBounds, ProjectionEvent, ProjectionFact, ReasoningFact, ReasoningTarget, TerminalFact } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const bounds: ProjectionBounds = { maxEntities: 32, maxPayloadBytes: 16384, maxJsonDepth: 24, maxJsonNodes: 1024 };
const ref = (id: string, scope: readonly string[] = ['native']): NativeRef => ({ scope, id });
const message = ref('message'), span = ref('span'), owner = ref('owner'), tool = ref('tool');
const success: TerminalFact = { kind: 'run-finished', outcome: 'success' };
const started: ReasoningFact = { kind: 'reasoning-message-started', message, role: 'reasoning' };
const complete: ReasoningFact = { kind: 'reasoning-message-complete', message, role: 'reasoning', text: '' };
const spanStart: ReasoningFact = { kind: 'reasoning-started', span };
const encrypted: ReasoningFact = { kind: 'reasoning-encrypted-value', target: { kind: 'message', message }, encryptedValue: '\u0000opaque\ud800' };
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
  collectEvents(`reasoning/${batch++}/${fact.kind}`, result.events);
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
const snapshot = (messages: Extract<ProjectionFact, { kind: 'messages-snapshot' }>['messages']): ProjectionFact => ({ kind: 'messages-snapshot', messages });
const closedTool: readonly ProjectionFact[] = [{ kind: 'tool-started', tool, name: 'fn' }, { kind: 'tool-arguments-ended', tool }];

test('reasoning family preserves undeclared availability and qualification', () => {
  assert.deepEqual(describeProjection('reasoning'), { kind: 'ok', value: {
    family: 'reasoning', representability: 'represented', availability: 'undeclared', qualification: 'undeclared',
  } });
});

test('independent span and message lifecycles emit exact events without fabricated text or subagents', () => {
  const projection = running();
  const events = [
    ...mapped(projection, { ...complete, message: ref('standalone') }),
    ...mapped(projection, { ...spanStart, span: message, owner }),
    ...mapped(projection, { ...started, owner }),
    ...mapped(projection, { kind: 'reasoning-ended', span: message, owner }),
    ...mapped(projection, { kind: 'reasoning-message-content', message, delta: '', owner }),
    ...mapped(projection, { kind: 'reasoning-message-ended', message, owner }),
  ];
  assert.equal(events.length, 8);
  assert(events[3]?.type === 'REASONING_START' && events[4]?.type === 'REASONING_MESSAGE_START');
  assert.equal(events[3].messageId, encoded('reasoning-span', message));
  assert.equal(events[4].messageId, encoded('message', message));
  assert.notEqual(events[3].messageId, events[4].messageId);
  assert(events.every(event => event.type.startsWith('REASONING')));
  mapped(projection, success);
});

test('complete and streamed message triads match, support empty content and multiple messages per span', () => {
  const one = running(), two = running([spanStart]);
  const expected = mapped(one, { ...complete, timestamp: 0, owner });
  const actual = [
    ...mapped(two, { ...started, timestamp: 0, owner }),
    ...mapped(two, { kind: 'reasoning-message-content', message, delta: '', timestamp: 0, owner }),
    ...mapped(two, { kind: 'reasoning-message-ended', message, timestamp: 0, owner }),
  ];
  assert.deepEqual(actual, expected);
  assert.deepEqual(expected.map(event => event.type), ['REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END']);
  assert(expected[0]?.type === 'REASONING_MESSAGE_START' && expected[0].role === 'reasoning');
  mapped(two, { ...complete, message: ref('second') });
  mapped(two, { kind: 'reasoning-ended', span });
  mapped(one, success);
  mapped(two, success);
  mapped(running([spanStart, { kind: 'reasoning-ended', span }]), success);
});

test('reasoning interleaves with text and tools and preserves pending call order', () => {
  const projection = running([{ kind: 'text-started', message: ref('text'), role: 'assistant' }, spanStart, started, ...closedTool]);
  mapped(projection, encrypted);
  mapped(projection, { kind: 'reasoning-ended', span });
  mapped(projection, { kind: 'text-ended', message: ref('text') });
  mapped(projection, { kind: 'reasoning-message-ended', message });
  const event = mapped(projection, { ...success, pendingTools: [tool] })[0];
  assert(event?.type === 'RUN_FINISHED' && event.outcome?.type === 'success');
  assert.deepEqual(event.outcome.pendingToolCallIds, [encoded('tool', tool)]);
});

for (const reopen of [false, true]) for (const validOrder of [true, false]) {
  test(`encrypted tool promotion ${validOrder ? 'accepts actual' : 'rejects reversed'} first-start order with reopen ${reopen}`, () => {
    const first = ref('first'), second = ref('second');
    const prefix: ProjectionFact[] = [
      { ...encrypted, target: { kind: 'tool', tool: second } },
      { kind: 'tool-started', tool: first, name: '' }, { kind: 'tool-arguments-ended', tool: first },
      { kind: 'tool-started', tool: second, name: '' }, { kind: 'tool-arguments-ended', tool: second },
    ];
    if (reopen) prefix.push(
      { kind: 'tool-started', tool: first, name: '' }, { kind: 'tool-arguments-ended', tool: first },
    );
    const projection = running(prefix, { maxEntities: 2 });
    const finish: TerminalFact = { ...success, pendingTools: validOrder ? [first, second] : [second, first] };
    if (validOrder) {
      const event = mapped(projection, finish)[0];
      assert(event?.type === 'RUN_FINISHED' && event.outcome?.type === 'success');
      assert.deepEqual(event.outcome.pendingToolCallIds, [encoded('tool', first), encoded('tool', second)]);
    } else rejects(projection, finish, 'identity-conflict');
  });
}

test('orphan fragments and already open duplicates fault with no returned events', () => {
  for (const fact of [{ kind: 'reasoning-message-content', message, delta: '' },
    { kind: 'reasoning-message-ended', message }, { kind: 'reasoning-ended', span }] satisfies ReasoningFact[]) {
    rejects(running(), fact, 'invalid-order');
  }
  rejects(running([{ ...spanStart, span: message }]), { kind: 'reasoning-message-content', message, delta: '' }, 'invalid-order');
  for (const fact of [started, spanStart]) rejects(running([fact]), fact, 'invalid-order');
});

test('closed reopen preserves immutable owner and message identity kind', () => {
  for (const [open, close] of [[started, { kind: 'reasoning-message-ended', message }],
    [spanStart, { kind: 'reasoning-ended', span }]] satisfies ReasoningFact[][]) {
    assert(open && close);
    mapped(running([open, close]), open);
    rejects(running([open, close]), { ...open, owner }, 'identity-conflict');
    rejects(running([{ ...open, owner }]), close, 'identity-conflict');
  }
  rejects(running([complete]), { kind: 'text-started', message, role: 'assistant' }, 'identity-conflict');
  rejects(running([{ kind: 'text-complete', message, role: 'assistant', text: '' }]), complete, 'identity-conflict');
});

test('every finish requires each open set closed while native failure abandons both', () => {
  for (const opens of [[started], [spanStart], [started, spanStart]]) {
    for (const finish of [success, { kind: 'run-finished', outcome: 'cancelled' },
      { kind: 'run-finished', outcome: 'interrupt', interrupts: [{ interrupt: ref('interrupt'), reason: '' }] }] satisfies TerminalFact[]) {
      rejects(running(opens), finish, 'invalid-order');
    }
    const projection = running(opens);
    assert.equal(mapped(projection, { kind: 'run-failed', failure: 'native-failure' })[0]?.type, 'RUN_ERROR');
    rejects(projection, complete, 'invalid-order');
  }
});

test('encrypted observations accept unknown, activity, closed and snapshot-only targets without lifecycle or owner checks', () => {
  const projection = running([spanStart, started, ...closedTool]);
  mapped(projection, snapshot([{ id: ref('snapshot'), role: 'assistant', toolCalls: [{ id: ref('snapshot-tool'), type: 'function', function: { name: '', arguments: '' } }] }]));
  mapped(projection, { kind: 'activity-snapshot', message: ref('activity'), activityType: '', content: {} });
  for (const target of [encrypted.target, { kind: 'message', message: ref('unknown') },
    { kind: 'message', message: ref('activity') }, { kind: 'message', message: ref('snapshot') },
    { kind: 'tool', tool: ref('snapshot-tool') }, { kind: 'tool', tool }] satisfies ReasoningTarget[]) {
    const event: ProjectionEvent | undefined = mapped(projection, { ...encrypted, target, owner })[0];
    assert(event?.type === 'REASONING_ENCRYPTED_VALUE');
    assert.equal(event.encryptedValue, encrypted.encryptedValue);
    assert.equal(event.entityId, target.kind === 'message' ? encoded('message', target.message) : encoded('tool', target.tool));
    assert.equal(event.subtype, target.kind === 'message' ? 'message' : 'tool-call');
    assert.equal(event.subagentRunId, encoded('subagent', owner));
  }
  mapped(projection, { kind: 'reasoning-message-ended', message });
  mapped(projection, encrypted);
  mapped(projection, { kind: 'reasoning-ended', span });
  mapped(projection, { ...success, pendingTools: [tool] });
  mapped(running([encrypted]), success);
});

test('encryption uses snapshot and actual identity domains without replacing current knowledge', () => {
  const projection = running([encrypted, { kind: 'tool-started', tool, name: '', parentMessage: message }]);
  rejects(projection, complete, 'identity-conflict');
  const promoted = running([{ ...encrypted, owner }], { maxEntities: 2 });
  mapped(promoted, complete);
  mapped(promoted, success);
  const current = running([{ kind: 'activity-snapshot', message, activityType: '', content: {} }, encrypted]);
  mapped(current, { kind: 'activity-delta', message, activityType: '', patch: [] });
  rejects(current, complete, 'identity-conflict');
});

test('snapshots replace current knowledge but preserve open reasoning and immutable reopen history', () => {
  for (const messages of [[], [{ id: message, role: 'assistant', subagentRunId: owner }],
    [{ id: message, role: 'reasoning', content: '', subagentRunId: owner }],
    [{ id: ref('other'), role: 'reasoning', content: '' }]] satisfies Parameters<typeof snapshot>[0][]) {
    const projection = running([started, snapshot(messages)]);
    rejects(projection, success, 'invalid-order');
    const continued = running([started, snapshot(messages)]);
    mapped(continued, { kind: 'reasoning-message-content', message, delta: '' });
    mapped(continued, { kind: 'reasoning-message-ended', message });
    mapped(continued, success);
    const reopened = running([complete, snapshot(messages)]);
    mapped(reopened, complete);
    rejects(reopened, { ...complete, owner }, 'identity-conflict');
  }
  for (const messages of [[], [{ id: ref('other'), role: 'reasoning', content: '' }]] satisfies Parameters<typeof snapshot>[0][]) {
    const projection = running([complete, snapshot(messages)]);
    const next: ProjectionFact = { kind: 'tool-started', tool, name: '', parentMessage: message };
    if (messages.length === 0) rejects(projection, next, 'identity-conflict');
    else mapped(projection, next);
  }
});

test('historical reasoning reopen preserves newer actual-tool assistant parent constraints', () => {
  const prefix: ProjectionFact[] = [complete, snapshot([{ id: message, role: 'assistant' }]),
    { kind: 'tool-started', tool, name: '', parentMessage: message }, complete];
  const projection = running(prefix);
  rejects(projection, { kind: 'tool-started', tool: ref('other'), name: '', parentMessage: message, owner }, 'identity-conflict');
  rejects(running([{ kind: 'tool-started', tool, name: '', parentMessage: message }]), complete, 'identity-conflict');
  const snapshots = running();
  for (const encryptedValue of ['opaque', undefined]) {
    const value = { id: message, role: 'reasoning', content: '', ...(encryptedValue === undefined ? {} : { encryptedValue }) } as const;
    const event = mapped(snapshots, snapshot([value]))[0];
    assert(event?.type === 'MESSAGES_SNAPSHOT');
    assert.deepEqual(event.messages, [{ ...value, id: encoded('message', message) }]);
  }
});

test('same-reference spans and messages charge separate domains while reopen and known encryption are free', () => {
  const prefix: ProjectionFact[] = [{ ...spanStart, span: message, owner }, { kind: 'reasoning-ended', span: message, owner }, { ...complete, owner }];
  const projection = running(prefix, { maxEntities: 3 });
  mapped(projection, { ...complete, owner });
  mapped(projection, { ...encrypted, owner });
  mapped(projection, snapshot([]));
  rejects(projection, { ...encrypted, target: { kind: 'message', message: ref('fourth') } }, 'bounds-exceeded');
  for (const fact of [{ ...encrypted, owner }, { ...encrypted, target: { kind: 'tool', tool } }] satisfies ReasoningFact[]) {
    rejects(running([encrypted], { maxEntities: 1 }), fact, 'bounds-exceeded');
  }
  const separate = running([{ ...encrypted, owner }], { maxEntities: 3 });
  mapped(separate, { ...complete, owner: ref('actual-owner') });
  mapped(separate, { ...complete, owner: ref('actual-owner') });
  const toolPromotion = running([{ ...encrypted, target: { kind: 'tool', tool }, owner }], { maxEntities: 3 });
  mapped(toolPromotion, { kind: 'tool-started', tool, name: '', owner: ref('actual-owner') });
  mapped(toolPromotion, { kind: 'tool-arguments-ended', tool, owner: ref('actual-owner') });
  mapped(toolPromotion, { ...success, pendingTools: [tool] });
});

test('scope and source encoding is exact and actors retain independent lifecycles', () => {
  const ids = new Set<string>();
  for (const native of [message, ref('message', ['other']), ref('\ud800'), ref('\ud801'), ref('\ufffd')]) {
    for (const source of ['source', 'other']) {
      const one = actor({}, source), two = actor({}, source);
      mapped(one, { kind: 'run-started' });
      mapped(two, { kind: 'run-started' });
      const first = mapped(one, { ...complete, message: native });
      assert.deepEqual(mapped(two, { ...complete, message: native }), first);
      assert(first[0]?.type === 'REASONING_MESSAGE_START');
      assert.equal(first[0].messageId, encoded('message', native, source));
      ids.add(first[0].messageId);
      rejects(one, { kind: 'reasoning-ended', span: native }, 'invalid-order');
      mapped(two, success);
    }
  }
  assert.equal(ids.size, 10);
});

test('strict roles, references, fields, prototypes and accessors reject without reading getters', () => {
  for (const base of [started, complete]) for (const role of [undefined, 'assistant', null, 1]) {
    const { role: ignored, ...withoutRole } = base;
    void ignored;
    rejects(running(), role === undefined ? withoutRole : { ...withoutRole, role });
  }
  for (const extra of [{ role: 'reasoning' }, { name: '' }, { span }]) rejects(running([started]), { kind: 'reasoning-message-content', message, delta: '', ...extra });
  for (const target of [{ kind: 'message', message: 'wire' }, { kind: 'tool', tool: { id: '' } },
    { kind: 'message', message, tool }, { kind: 'activity', message }, { kind: 'message', message: { scope: [0], id: '' } }]) rejects(running(), { ...encrypted, target });
  for (const value of [null, 0, {}, new Date()]) rejects(running(), { ...encrypted, encryptedValue: value });
  let reads = 0;
  const accessor = { get hidden() { reads++; return 'private'; } };
  for (const value of [accessor, Object.create({ inherited: true }), new Date()]) rejects(running(), { ...encrypted, target: value });
  assert.equal(reads, 0);
  rejects(running(), { ...spanStart, span: { scope: [], id: '', extra: '' } });
});

test('mutation isolation, expanded triad budgets and JSON work limits apply atomically', () => {
  const native = { scope: ['before'], id: 'before' };
  const projection = running();
  const event = mapped(projection, { ...started, message: native })[0];
  native.scope.push('after');
  native.id = 'after';
  assert(event?.type === 'REASONING_MESSAGE_START');
  assert.equal(event.messageId, encoded('message', ref('before', ['before'])));
  assert(Object.isFrozen(event));
  const source = 's'.repeat(100);
  const baseline = actor({}, source);
  mapped(baseline, { kind: 'run-started' });
  const expected = mapped(baseline, complete);
  const bytes = Buffer.byteLength(JSON.stringify(expected));
  assert(Buffer.byteLength(JSON.stringify(complete)) < bytes);
  for (const maxPayloadBytes of [bytes, bytes - 1]) {
    const bounded = actor({ maxPayloadBytes }, source);
    mapped(bounded, { kind: 'run-started' });
    if (maxPayloadBytes === bytes) assert.deepEqual(mapped(bounded, complete), expected);
    else rejects(bounded, complete, 'bounds-exceeded');
  }
  rejects(running([], { maxJsonDepth: 3 }), { ...encrypted, target: { kind: 'message', message: ref('', ['deep']) } }, 'bounds-exceeded');
  rejects(running([], { maxJsonNodes: 30 }), { ...encrypted, target: { kind: 'message', message: ref('', Array(30).fill('')) } }, 'bounds-exceeded');
});
