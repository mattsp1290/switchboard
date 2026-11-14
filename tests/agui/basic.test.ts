import assert from 'node:assert/strict';
import test from 'node:test';
import { createAguiProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, BasicFact, NativeContent, NativeRef, ProjectionBounds, ProjectionEvent } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const bounds: ProjectionBounds = { maxEntities: 32, maxPayloadBytes: 8192, maxJsonDepth: 20, maxJsonNodes: 512 };
const ref = (id: string, scope: readonly string[] = []): NativeRef => ({ scope, id });
const message = ref('message');
const tool = ref('tool');
const step = ref('step');
const owner = ref('child');
const start: BasicFact = { kind: 'run-started' };
const text: BasicFact = { kind: 'text-started', message, role: 'assistant', name: 'speaker' };
const toolStart: BasicFact = { kind: 'tool-started', tool, name: 'lookup', parentMessage: message };
const toolEnd: BasicFact = { kind: 'tool-arguments-ended', tool };
const finish: BasicFact = { kind: 'run-finished', outcome: 'success' };
let batch = 0;

function actor(limits: Partial<ProjectionBounds> = {}, sourceKey = 'source', runId = 'run'): AguiProjection {
  const made = createAguiProjection({ threadId: 'thread', runId, sourceKey, bounds: { ...bounds, ...limits } });
  assert(made.kind === 'ok');
  return made.value;
}

function mapped(projection: AguiProjection, fact: BasicFact): readonly ProjectionEvent[] {
  const result = projection.accept(fact);
  assert.equal(result.kind, 'mapped');
  assert(result.kind === 'mapped');
  collectEvents(`basic/${batch++}/${fact.kind}`, result.events);
  assert(Object.isFrozen(result.events));
  for (const event of result.events) assert(Object.isFrozen(event));
  return result.events;
}

function running(prefix: readonly BasicFact[] = [], limits: Partial<ProjectionBounds> = {}): AguiProjection {
  const projection = actor(limits);
  for (const fact of [start, ...prefix]) mapped(projection, fact);
  return projection;
}

function rejects(projection: AguiProjection, fact: unknown, code = 'invalid-order'): void {
  assert.deepEqual(Reflect.apply(projection.accept, projection, [fact]), { kind: 'error', error: { code } });
  assert.deepEqual(projection.accept(start), { kind: 'error', error: { code: 'closed' } });
}

function first(events: readonly ProjectionEvent[]): ProjectionEvent {
  assert(events[0]);
  return events[0];
}

const encoded = (kind: string, value: NativeRef, source = 'source') => JSON.stringify([1, source, kind, value.scope, value.id]);

test('text streams preserve observed fragments, owner, roles and complete boundaries', () => {
  const projection = running();
  const opened = first(mapped(projection, { ...text, owner, timestamp: 0 }));
  assert.deepEqual(opened, { type: 'TEXT_MESSAGE_START', timestamp: 0, subagentRunId: encoded('subagent', owner),
    messageId: encoded('message', message), role: 'assistant', name: 'speaker' });
  for (const delta of ['', '雪', '\ud800']) {
    assert.deepEqual(mapped(projection, { kind: 'text-content', message, owner, delta }), [{
      type: 'TEXT_MESSAGE_CONTENT', subagentRunId: encoded('subagent', owner), messageId: encoded('message', message), delta,
    }]);
  }
  mapped(projection, { kind: 'text-ended', message, owner });
  for (const role of ['assistant', 'developer', 'system', 'user'] as const) {
    const events = mapped(projection, { kind: 'text-complete', message: ref(role), role, text: '', timestamp: 7 });
    assert.deepEqual(events.map(event => event.type), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
    assert(events.every(event => event.timestamp === 7));
  }
  mapped(projection, finish);
});

test('tool streams preserve malformed partial arguments and answer a distinct message', () => {
  const projection = running([text, { kind: 'text-ended', message }]);
  assert.deepEqual(mapped(projection, toolStart), [{ type: 'TOOL_CALL_START', toolCallId: encoded('tool', tool),
    toolCallName: 'lookup', parentMessageId: encoded('message', message) }]);
  for (const delta of ['', '{"unfinished":']) mapped(projection, { kind: 'tool-arguments', tool, delta });
  mapped(projection, toolEnd);
  assert.deepEqual(mapped(projection, { kind: 'tool-result', tool, resultMessage: ref('answer'), content: 'observed result' }), [{
    type: 'TOOL_CALL_RESULT', toolCallId: encoded('tool', tool), messageId: encoded('message', ref('answer')), content: 'observed result',
  }]);
  mapped(projection, { ...finish, pendingTools: [] });
});

test('all five content parts and three source forms preserve order and bounded metadata', () => {
  const metadata = { id: 'application-id', nested: [true, null, 2] };
  const parts = [
    { type: 'text', id: ref('part'), text: 'text', metadata },
    { type: 'image', source: { type: 'data', value: 'AA==', mimeType: 'image/png' } },
    { type: 'audio', source: { type: 'url', value: 'opaque-url', mimeType: 'audio/wav' }, metadata: false },
    { type: 'video', source: { type: 'file', value: 'provider-handle', provider: 'native', mimeType: 'video/mp4' } },
    { type: 'document', source: { type: 'url', value: 'document' }, metadata: ['citation'] },
    { type: 'image', source: { type: 'file', value: 'without-optional-fields' } },
  ] satisfies NativeContent;
  const projection = running([toolStart, toolEnd]);
  const result = first(mapped(projection, { kind: 'tool-result', tool, resultMessage: ref('result'), content: parts }));
  assert(result.type === 'TOOL_CALL_RESULT');
  assert(typeof result.content !== 'string');
  assert.deepEqual(result.content, [{ ...parts[0], id: encoded('part', ref('part')) }, ...parts.slice(1)]);
  const before = JSON.stringify(result);
  metadata.id = 'changed';
  metadata.nested.push(false);
  assert.equal(JSON.stringify(result), before);
  assert(Array.isArray(result.content));
  assert(Object.isFrozen(result.content));
  assert(Object.isFrozen(result.content[0]?.metadata));
  assert.throws(() => Reflect.apply(Array.prototype.push, result.content, [{}]), TypeError);
  mapped(projection, finish);
});

test('step identities remain distinct with repeated display names and legal reopening', () => {
  const projection = running();
  for (const step of [ref('a'), ref('b')]) {
    assert.deepEqual(mapped(projection, { kind: 'step-started', step, name: 'same display' }), [{
      type: 'STEP_STARTED', stepName: encoded('step', step), metadata: { switchboard: { name: 'same display' } },
    }]);
    mapped(projection, { kind: 'step-finished', step });
  }
  for (let index = 0; index < 2; index++) {
    mapped(projection, { kind: 'step-started', step });
    mapped(projection, { kind: 'step-finished', step });
  }
  mapped(projection, finish);
});

test('scoped tuple identities are stable across actors and preserve lone surrogates', () => {
  const ids: string[] = [];
  for (const native of [ref('same'), ref('same', ['a', 'b']), ref('same', ['a,b']), ref('\ud800'), ref('\ud801'), ref('\ufffd')]) {
    const projection = running();
    const event = first(mapped(projection, { kind: 'text-complete', message: native, role: 'assistant', text: 'x' }));
    assert(event.type === 'TEXT_MESSAGE_START');
    assert.equal(event.messageId, encoded('message', native));
    ids.push(event.messageId);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const [sourceKey, runId] of [['source', 'other-run'], ['different-source', 'run']]) {
    const projection = actor({}, sourceKey, runId);
    mapped(projection, start);
    const events = mapped(projection, { kind: 'text-complete', message: ref('same'), role: 'assistant', text: 'x' });
    const event = first(events);
    assert(event.type === 'TEXT_MESSAGE_START');
    assert.equal(event.messageId, encoded('message', ref('same'), sourceKey));
    assert.equal(event.messageId === ids[0], sourceKey === 'source');
  }
  const projection = running();
  const toolEvent = first(mapped(projection, { kind: 'tool-started', tool: ref('same'), name: 'x' }));
  assert(toolEvent.type === 'TOOL_CALL_START');
  assert.notEqual(toolEvent.toolCallId, ids[0]);
});

test('identical text and tool reopeners preserve descriptors and first-start ordering', () => {
  const projection = running([text, { kind: 'text-ended', message }, text, { kind: 'text-ended', message }, toolStart, toolEnd]);
  mapped(projection, { kind: 'tool-started', tool: ref('second'), name: 'second' });
  mapped(projection, { kind: 'tool-arguments-ended', tool: ref('second') });
  mapped(projection, toolStart);
  mapped(projection, toolEnd);
  const event = first(mapped(projection, { ...finish, pendingTools: [tool, ref('second')] }));
  assert(event.type === 'RUN_FINISHED');
  assert(event.outcome?.type === 'success');
  assert.deepEqual(event.outcome.pendingToolCallIds, [encoded('tool', tool), encoded('tool', ref('second'))]);
});

test('pending tools require exactly unanswered first-start order when explicitly supplied', () => {
  const prefix: BasicFact[] = [toolStart, toolEnd, { kind: 'tool-started', tool: ref('second'), name: 'second' },
    { kind: 'tool-arguments-ended', tool: ref('second') }];
  for (const pendingTools of [[], [tool], [ref('second'), tool], [tool, tool], [tool, ref('missing')]]) {
    rejects(running(prefix), { ...finish, pendingTools }, 'identity-conflict');
  }
  mapped(running(prefix), finish);
  const projection = running(prefix);
  mapped(projection, { kind: 'tool-result', tool, resultMessage: ref('result'), content: [] });
  mapped(projection, { ...finish, pendingTools: [ref('second')] });
});

test('opener, parent and owner disagreement fault without emitting', () => {
  for (const next of [{ ...text, role: 'user' }, { ...text, name: 'changed' }, { ...text, owner },
    { kind: 'tool-result', tool, resultMessage: message, content: '' }]) {
    rejects(running([text, { kind: 'text-ended', message }, toolStart, toolEnd]), next, 'identity-conflict');
  }
  for (const next of [{ ...toolStart, name: 'changed' }, { ...toolStart, parentMessage: ref('different') }, { ...toolStart, owner }]) {
    rejects(running([toolStart, toolEnd]), next, 'identity-conflict');
  }
  for (const next of [{ kind: 'text-content', message, delta: '', owner }, { kind: 'text-ended', message, owner }]) {
    rejects(running([text]), next, 'identity-conflict');
  }
  rejects(running([{ ...text, owner }]), toolStart, 'identity-conflict');
  rejects(running([toolStart]), { ...text, owner }, 'identity-conflict');
  rejects(running([{ ...text, role: 'user' }]), toolStart, 'identity-conflict');
  rejects(running([toolStart]), { kind: 'tool-arguments', tool, delta: '', owner }, 'identity-conflict');
  rejects(running([toolStart, toolEnd]), { kind: 'tool-result', tool, resultMessage: ref('r'), content: '', owner }, 'identity-conflict');
  rejects(running([{ kind: 'step-started', step }]), { kind: 'step-finished', step, owner }, 'identity-conflict');
});

test('unopened, duplicate-open, closed-content and duplicate-result sequences fault', () => {
  for (const fact of [{ kind: 'text-content', message, delta: '' }, { kind: 'text-ended', message }, toolEnd,
    { kind: 'tool-result', tool, resultMessage: ref('r'), content: '' }, { kind: 'step-finished', step }] satisfies BasicFact[]) {
    rejects(running(), fact);
  }
  for (const prefix of [[text], [toolStart], [{ kind: 'step-started', step }]] satisfies BasicFact[][]) {
    assert(prefix[0]);
    rejects(running(prefix), prefix[0]);
  }
  rejects(running([text, { kind: 'text-ended', message }]), { kind: 'text-content', message, delta: '' });
  rejects(running([toolStart]), { kind: 'tool-result', tool, resultMessage: ref('r'), content: '' });
  const result: BasicFact = { kind: 'tool-result', tool, resultMessage: ref('r'), content: '' };
  rejects(running([toolStart, toolEnd, result]), result);
  rejects(running([toolStart, toolEnd, result]), { kind: 'text-complete', message: ref('r'), role: 'assistant', text: '' }, 'identity-conflict');
});

test('success and cancellation require all boundaries closed while native errors abandon', () => {
  for (const open of [text, toolStart, { kind: 'step-started', step }] satisfies BasicFact[]) {
    for (const outcome of ['success', 'cancelled'] as const) rejects(running([open]), { kind: 'run-finished', outcome });
    mapped(running([open]), { kind: 'run-failed', failure: 'native-failure' });
  }
  const projection = running([text, { kind: 'text-ended', message }, toolStart, toolEnd,
    { kind: 'step-started', step }, { kind: 'step-finished', step }]);
  mapped(projection, { kind: 'run-finished', outcome: 'cancelled' });
  mapped(projection, { kind: 'run-failed', failure: 'transport-failure' });
  rejects(actor(), text);
  rejects(running([finish]), text);
});

test('entity tombstones, result identities and attribution owners consume the entity ceiling', () => {
  const projection = running([], { maxEntities: 1 });
  mapped(projection, { kind: 'text-complete', message, role: 'assistant', text: '' });
  mapped(projection, { kind: 'text-complete', message, role: 'assistant', text: 'reopen' });
  rejects(projection, { kind: 'step-started', step }, 'bounds-exceeded');
  rejects(running([], { maxEntities: 1 }), { ...text, owner }, 'bounds-exceeded');
  rejects(running([toolStart, toolEnd], { maxEntities: 1 }),
    { kind: 'tool-result', tool, resultMessage: ref('result'), content: '' }, 'bounds-exceeded');
  mapped(running([], { maxEntities: 2 }), { ...text, owner });
});

test('expanded IDs and complete output batches consume exact byte limits', () => {
  const sourceKey = 's'.repeat(100);
  const projection = actor({}, sourceKey);
  mapped(projection, start);
  const fact: BasicFact = { kind: 'text-complete', message, role: 'assistant', text: '' };
  const events = mapped(projection, fact);
  const bytes = Buffer.byteLength(JSON.stringify(events));
  assert(Buffer.byteLength(JSON.stringify(fact)) < bytes - 1);
  for (const [limit, succeeds] of [[bytes, true], [bytes - 1, false]] as const) {
    const bounded = actor({ maxPayloadBytes: limit }, sourceKey);
    mapped(bounded, start);
    if (succeeds) assert.deepEqual(mapped(bounded, fact), events);
    else rejects(bounded, fact, 'bounds-exceeded');
  }
});

test('entity and content boundaries reject invalid shapes rather than leaking or inventing fields', () => {
  const invalid = [
    { ...text, role: 'tool' }, { ...text, message: { id: 'x' } }, { ...text, owner: { scope: [1], id: 'x' } },
    { ...text, message: { ...message, secret: 'x' } }, { ...text, name: null }, { ...toolStart, name: 1 },
    { kind: 'text-content', message, delta: 2 }, { kind: 'tool-arguments', tool, delta: null },
    { kind: 'step-started', step, name: 2 }, { ...finish, pendingTools: 'invalid' },
  ];
  for (const fact of invalid) rejects(running(), fact, 'invalid-input');
  for (const content of [null, {}, [{ type: 'text', text: 1 }], [{ type: 'text', text: '', metadata: null }],
    [{ type: 'image', source: { type: 'data', value: 'x' } }], [{ type: 'image', source: { type: 'url', value: 1 } }],
    [{ type: 'image', source: { type: 'unknown', value: '' } }], [{ type: 'unknown', text: '' }],
    [{ type: 'text', text: '', error: 'private' }]]) {
    rejects(running([toolStart, toolEnd]), { kind: 'tool-result', tool, resultMessage: ref('r'), content }, 'invalid-input');
  }
  rejects(running([toolStart, toolEnd]), { kind: 'tool-result', tool, resultMessage: ref('r'), content: '', error: 'private' }, 'invalid-input');
});

test('unseen assistant parents constrain all tool owners', () => {
  for (const earlier of [toolStart, { ...toolStart, owner }]) {
    const later = { ...toolStart, tool: ref('later'), ...(earlier.owner === undefined ? { owner } : {}) };
    for (const ended of [false, true]) {
      const prefix = ended ? [earlier, { ...toolEnd, ...(earlier.owner === undefined ? {} : { owner }) }] : [earlier];
      rejects(running(prefix), later, 'identity-conflict');
    }
  }
});

test('unseen assistant parent identities cannot become tool result messages', () => {
  for (const resultTool of [tool, ref('other')]) {
    const prefix: BasicFact[] = [toolStart, toolEnd];
    if (resultTool !== tool) prefix.push({ kind: 'tool-started', tool: resultTool, name: 'other' },
      { kind: 'tool-arguments-ended', tool: resultTool });
    rejects(running(prefix), { kind: 'tool-result', tool: resultTool, resultMessage: message, content: '' }, 'identity-conflict');
  }
  const projection = running([{ ...toolStart, owner }, { ...toolEnd, owner },
    { ...toolStart, tool: ref('other'), owner }, { kind: 'tool-arguments-ended', tool: ref('other'), owner }]);
  mapped(projection, { ...text, owner });
  mapped(projection, { kind: 'text-ended', message, owner });
  mapped(projection, finish);
});

test('entity facts carry resolved ownership and omitted owner means root', () => {
  rejects(running([{ ...text, owner }]), { kind: 'text-content', message, delta: '' }, 'identity-conflict');
  rejects(running([{ ...toolStart, owner }]), toolEnd, 'identity-conflict');
});
