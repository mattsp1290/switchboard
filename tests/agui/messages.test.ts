import assert from 'node:assert/strict';
import test from 'node:test';
import { createAguiProjection, describeProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, NativeContent, NativeMessage, NativeRef, ProjectionBounds, ProjectionEvent, ProjectionFact } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const ref = (id: string, scope: readonly string[] = []): NativeRef => ({ scope, id });
const a = ref('A'), b = ref('B'), message = ref('message'), tool = ref('tool');
const bounds: ProjectionBounds = { maxEntities: 64, maxPayloadBytes: 16384, maxJsonDepth: 24, maxJsonNodes: 2048 };
const finish: ProjectionFact = { kind: 'run-finished', outcome: 'success' };
const text = (owner = a): ProjectionFact => ({ kind: 'text-started', message, role: 'assistant', owner });
const startTool = (owner = a, selected = tool): ProjectionFact => ({ kind: 'tool-started', tool: selected, name: 'fn', parentMessage: message, owner });
const endTool = (owner = a, selected = tool): ProjectionFact => ({ kind: 'tool-arguments-ended', tool: selected, owner });
const result = (resultMessage = ref('result')): ProjectionFact => ({ kind: 'tool-result', tool, resultMessage, owner: a, content: '' });
const snapshot = (messages: readonly NativeMessage[]): ProjectionFact => ({ kind: 'messages-snapshot', messages });
const parent = (owner = a): Extract<NativeMessage, { role: 'assistant' }> => ({ id: message, role: 'assistant', subagentRunId: owner });
const activity = (id = message): Extract<NativeMessage, { role: 'activity' }> => ({ id, role: 'activity', activityType: 'progress', content: {}, subagentRunId: b });
const delta = (id = message): ProjectionFact => ({ kind: 'activity-delta', message: id, activityType: 'changed', patch: [], owner: b });
const encoded = (kind: string, value: NativeRef, source = 'source') => JSON.stringify([1, source, kind, value.scope, value.id]);
let batch = 0;
function mapped(actor: AguiProjection, fact: ProjectionFact): readonly ProjectionEvent[] {
  const result = actor.accept(fact);
  assert(result.kind === 'mapped', JSON.stringify(result));
  collectEvents(`messages/${batch++}/${fact.kind}`, result.events);
  return result.events;
}
function running(prefix: readonly ProjectionFact[] = [], limits: Partial<ProjectionBounds> = {}, sourceKey = 'source'): AguiProjection {
  const made = createAguiProjection({ threadId: 'thread', runId: 'run', sourceKey, bounds: { ...bounds, ...limits } });
  assert(made.kind === 'ok');
  for (const fact of [{ kind: 'run-started' }, ...prefix] satisfies ProjectionFact[]) mapped(made.value, fact);
  return made.value;
}
function rejects(actor: AguiProjection, fact: unknown, code = 'identity-conflict'): void {
  assert.deepEqual(Reflect.apply(actor.accept, actor, [fact]), { kind: 'error', error: { code } });
  assert.deepEqual(actor.accept(finish), { kind: 'error', error: { code: 'closed' } });
}
function event(actor: AguiProjection, messages: readonly NativeMessage[]) {
  const value = mapped(actor, snapshot(messages))[0];
  assert(value?.type === 'MESSAGES_SNAPSHOT');
  return value;
}

test('all roles, parts and sources preserve opaque data and convert only scoped protocol references', () => {
  const metadata = { id: 'data-id', toolCallId: 'data-tool', nested: [null, true] };
  const parts = [
    { type: 'text', id: ref('part', ['scope']), text: '\ud800雪', metadata },
    { type: 'image', source: { type: 'data', value: 'opaque-data', mimeType: 'image/png' } },
    { type: 'audio', source: { type: 'url', value: 'opaque-url', mimeType: 'audio/wav' }, metadata: false },
    { type: 'video', source: { type: 'file', value: 'opaque-file', provider: 'native', mimeType: 'video/mp4' } },
    { type: 'document', source: { type: 'file', value: 'bare-file' }, metadata: ['citation'] },
  ] satisfies NativeContent;
  const call = { id: ref('nested', ['scope']), type: 'function', function: { name: 'fn', arguments: '{partial' }, encryptedValue: 'opaque-call', metadata } as const;
  const messages = [
    { id: ref('developer'), role: 'developer', name: '', content: '', encryptedValue: 'developer', metadata },
    { id: ref('system'), role: 'system', name: 'system', content: 's', subagentRunId: a },
    { ...parent(), name: 'assistant', content: '', toolCalls: [call], encryptedValue: 'opaque-message', metadata },
    { id: ref('user'), role: 'user', content: parts, name: 'user', encryptedValue: 'user', metadata },
    { id: ref('result'), role: 'tool', toolCallId: ref('external'), content: parts, error: 'observed error', encryptedValue: 'tool', metadata },
    { ...activity(), id: ref('activity'), metadata },
    { id: ref('reasoning'), role: 'reasoning', content: 'visible', encryptedValue: 'reasoning', metadata },
  ] satisfies readonly NativeMessage[];
  const output = event(running(), messages);
  assert.deepEqual(output.messages.map(item => item.role), messages.map(item => item.role));
  assert(!('subagentRunId' in output));
  const assistant = output.messages[2], user = output.messages[3], answer = output.messages[4];
  assert(assistant?.role === 'assistant' && user?.role === 'user' && answer?.role === 'tool');
  assert.equal(assistant.id, encoded('message', message));
  assert.equal(assistant.subagentRunId, encoded('subagent', a));
  assert.deepEqual(assistant.toolCalls, [{ ...call, id: encoded('tool', call.id) }]);
  assert.equal(answer.toolCallId, encoded('tool', ref('external')));
  assert.deepEqual(user.content, [{ ...parts[0], id: encoded('part', ref('part', ['scope'])) }, ...parts.slice(1)]);
  assert.equal(answer.error, 'observed error');
  const before = JSON.stringify(output);
  metadata.id = 'mutated'; metadata.nested.push(false);
  assert.equal(JSON.stringify(output), before);
  assert(Object.isFrozen(output.messages) && Object.isFrozen(assistant.toolCalls?.[0]?.metadata));
  assert.equal(Reflect.set(assistant, 'content', 'changed'), false);
  assert.deepEqual(event(running(), []).messages, []);
  assert.equal(describeProjection('messages').kind, 'ok');
});

test('snapshot-only parents constrain actual tools but never become immutable explicit openers', () => {
  rejects(running([snapshot([parent()])]), startTool(b));
  mapped(running([snapshot([parent()])]), text(b));
  rejects(running([snapshot([parent()]), startTool()]), text(b));
  rejects(running([snapshot([parent()]), startTool()]), { kind: 'activity-snapshot', message, activityType: 'x', content: {} });
  const nonAssistant = [
    { id: message, role: 'user', content: '' }, { id: message, role: 'system', content: '' },
    { id: message, role: 'developer', content: '' }, { id: message, role: 'reasoning', content: '' },
    { id: message, role: 'tool', content: '', toolCallId: tool }, activity(),
  ] satisfies NativeMessage[];
  for (const value of nonAssistant) rejects(running([snapshot([value])]), startTool());
});

test('unknown and omitted parents infer one current actual-tool constraint and charge it once', () => {
  for (const prefix of [[], [snapshot([parent()]), snapshot([])]] satisfies ProjectionFact[][]) {
    const actor = running(prefix);
    mapped(actor, startTool(b));
    rejects(actor, startTool(a, ref('second')));
  }
  rejects(running([], { maxEntities: 2 }), startTool(), 'bounds-exceeded');
  const actor = running([], { maxEntities: 3 });
  mapped(actor, startTool()); mapped(actor, endTool()); mapped(actor, startTool()); mapped(actor, endTool());
  mapped(actor, finish);
});

test('reminting clears current constraints while old tools continue and reopen with their explicit descriptor', () => {
  const actor = running([text(), startTool(), snapshot([parent(b)])]);
  mapped(actor, startTool(b, ref('second')));
  mapped(actor, { kind: 'tool-arguments', tool, owner: a, delta: '{' });
  mapped(actor, endTool()); mapped(actor, startTool()); mapped(actor, endTool());
  mapped(actor, endTool(b, ref('second')));
  mapped(actor, { kind: 'text-ended', message, owner: a });
  mapped(actor, text()); mapped(actor, { kind: 'text-ended', message, owner: a });
  mapped(actor, { ...finish, pendingTools: [tool, ref('second')] });
  rejects(running([startTool(), snapshot([])]), finish, 'invalid-order');
});

test('explicit text reopening stays immutable across replacement, omission and active continuations', () => {
  const ended: ProjectionFact = { kind: 'text-ended', message, owner: a };
  for (const replacement of [[parent(b)], []]) {
    const prefix = [text(), ended, snapshot(replacement)];
    mapped(running(prefix), text()); rejects(running(prefix), text(b));
    const actor = running([text(), snapshot(replacement)]);
    mapped(actor, { kind: 'text-content', message, owner: a, delta: 'continued' });
    mapped(actor, ended);
    mapped(actor, startTool(b));
    rejects(actor, startTool(a, ref('second')));
    rejects(running([text(), snapshot(replacement)]), finish, 'invalid-order');
  }
  const actor = running([text(), snapshot([{ id: message, role: 'user', content: '' }])]);
  mapped(actor, ended); rejects(actor, startTool());
});

test('activity current baseline can coexist with immutable text and emitted-result evidence', () => {
  const textActor = running([text(), { kind: 'text-ended', message, owner: a }, snapshot([activity()])]);
  mapped(textActor, delta());
  mapped(textActor, { kind: 'activity-snapshot', message, owner: b, activityType: 'ignored', content: {}, replace: false });
  mapped(textActor, text()); mapped(textActor, { kind: 'text-ended', message, owner: a });
  const resultActor = running([startTool(), endTool(), result(), snapshot([activity(ref('result'))])]);
  mapped(resultActor, delta(ref('result')));
  rejects(resultActor, { kind: 'text-started', message: ref('result'), role: 'assistant' });
  rejects(running([{ kind: 'activity-snapshot', message, activityType: 'old', content: {} }]), text());
  rejects(running([snapshot([activity()])]), { ...delta(), owner: a });
  rejects(running([text(), { kind: 'text-ended', message, owner: a }, snapshot([])]),
    { kind: 'activity-snapshot', message, activityType: 'new', content: {} });
});

test('activity omission is per role and same-ID replacements win over exemptions', () => {
  const baseline = snapshot([activity(), { id: ref('reasoning'), role: 'reasoning', content: '' }]);
  mapped(running([baseline, snapshot([])]), delta());
  rejects(running([baseline, snapshot([activity(ref('other'))])]), delta(), 'invalid-order');
  rejects(running([baseline, snapshot([{ id: message, role: 'assistant' }]), snapshot([])]), delta(), 'invalid-order');
  const actor = running([baseline, snapshot([])], { maxEntities: 4 });
  mapped(actor, snapshot([{ id: ref('third'), role: 'reasoning', content: '' }]));
  rejects(actor, snapshot([{ id: ref('fourth'), role: 'reasoning', content: '' }]), 'bounds-exceeded');
});

test('snapshots never create pending calls or results and actual first-start order survives', () => {
  const calls = [ref('second'), tool].map(id => ({ id, type: 'function', function: { name: 'fn', arguments: 'opaque' } } as const));
  const actor = running([snapshot([{ ...parent(), toolCalls: calls }, { id: ref('result'), role: 'tool', toolCallId: tool, content: '' }])]);
  mapped(actor, startTool()); mapped(actor, endTool());
  mapped(actor, startTool(a, ref('second'))); mapped(actor, endTool(a, ref('second')));
  mapped(actor, snapshot([]));
  mapped(actor, { ...finish, pendingTools: [tool, ref('second')] });
  mapped(running([snapshot([{ ...parent(), toolCalls: calls }])]), { ...finish, pendingTools: [] });
  const answered = running([startTool(), endTool(), snapshot([{ id: ref('result'), role: 'tool', toolCallId: tool, content: '' }])]);
  mapped(answered, result()); mapped(answered, snapshot([]));
  mapped(answered, { ...finish, pendingTools: [] });
  rejects(running([startTool(), endTool(), result(), snapshot([parent()]), startTool(), endTool()]), result(), 'invalid-order');
  const other = ref('other');
  rejects(running([startTool(), endTool(), result(), snapshot([]), { kind: 'tool-started', tool: other, name: 'fn', owner: a }, endTool(a, other)]),
    { kind: 'tool-result', tool: other, owner: a, resultMessage: ref('result'), content: '' });
});

test('snapshot and inferred identities share monotonic bounds, deduplicate owners and isolate actors', () => {
  const shared = [parent(), { id: ref('second'), role: 'assistant', subagentRunId: a }] satisfies NativeMessage[];
  const actor = running([], { maxEntities: 3 });
  mapped(actor, snapshot(shared)); mapped(actor, snapshot(shared)); mapped(actor, snapshot([])); mapped(actor, snapshot(shared));
  rejects(actor, snapshot([{ id: ref('third'), role: 'user', content: '' }]), 'bounds-exceeded');
  rejects(running([], { maxEntities: 2 }), snapshot(shared), 'bounds-exceeded');
  mapped(running([], { maxEntities: 1 }), snapshot([{ id: message, role: 'assistant', toolCalls: [
    { id: tool, type: 'function', function: { name: 'fn', arguments: '' } },
  ] }]));
  const independent = running([snapshot([parent(b)])]);
  const closed = running([snapshot([parent()])]); closed.close();
  rejects(closed, snapshot([]), 'closed'); mapped(independent, startTool(b));
});

test('exact role fields, duplicate references and malformed values fail atomically', () => {
  const invalid = [
    { ...parent(), name: null }, { ...parent(), encryptedContent: 'wrong' }, { ...parent(), content: [] },
    { ...parent(), metadata: [] }, { ...parent(), metadata: null }, { ...parent(), metadata: 2 },
    { ...parent(), toolCalls: {} }, { ...parent(), toolCalls: [{ id: tool, type: 'function', function: { name: 'fn' } }] },
    { ...parent(), toolCalls: [{ id: tool, type: 'function', function: { name: 'fn', arguments: '' }, subagentRunId: a }] },
    { ...parent(), toolCalls: [{ id: tool, type: 'function', function: { name: 'fn', arguments: '' }, metadata: [] }] },
    { id: message, role: 'tool', content: '', toolCallId: tool, name: 'forbidden' },
    { ...activity(), encryptedValue: 'forbidden' }, { ...activity(), name: 'forbidden' }, { ...activity(), content: [] },
    { id: message, role: 'reasoning', content: '', name: 'forbidden' }, { id: message, role: 'unknown', content: '' },
    { id: message, role: 'user', content: [{ type: 'text', text: '', metadata: null }] },
    { id: message, role: 'user', content: [{ type: 'image', source: { type: 'data', value: 'opaque' } }] },
  ];
  for (const item of invalid) rejects(running(), { kind: 'messages-snapshot', messages: [item] }, 'invalid-input');
  for (const role of ['developer', 'system', 'user', 'tool', 'activity', 'reasoning']) rejects(running(),
    { kind: 'messages-snapshot', messages: [{ id: message, role }] }, 'invalid-input');
  for (const fact of [{ kind: 'messages-snapshot', messages: [], owner: a }, { kind: 'messages-snapshot', messages: {} },
    { kind: 'messages-snapshot', messages: [], timestamp: 0.5 }]) rejects(running(), fact, 'invalid-input');
  rejects(running(), snapshot([parent(), parent()]));
  const call = { id: tool, type: 'function', function: { name: 'fn', arguments: '' } } as const;
  rejects(running(), snapshot([{ ...parent(), toolCalls: [call, call] }]));
  rejects(running(), snapshot([{ ...parent(), toolCalls: [call] }, { id: ref('second'), role: 'assistant', toolCalls: [call] }]));
  for (const value of [NaN, 1n, undefined, () => {}, new Date(), Object.defineProperty({}, 'secret', { enumerable: true, get() { throw Error('secret'); } })]) {
    rejects(running(), { kind: 'messages-snapshot', messages: [{ ...parent(), metadata: { value } }] }, 'invalid-input');
  }
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  rejects(running(), { kind: 'messages-snapshot', messages: [{ ...parent(), metadata: cycle }] }, 'invalid-input');
});

test('expanded snapshot output and nested input consume exact byte, depth and work limits', () => {
  const source = 's'.repeat(120), messages = [{ ...parent(), toolCalls: [
    { id: tool, type: 'function', function: { name: 'fn', arguments: '' } },
  ] }] satisfies NativeMessage[];
  const output = mapped(running([], {}, source), snapshot(messages));
  const bytes = Buffer.byteLength(JSON.stringify(output));
  assert(bytes > Buffer.byteLength(JSON.stringify(snapshot(messages))));
  assert.deepEqual(mapped(running([], { maxPayloadBytes: bytes }, source), snapshot(messages)), output);
  rejects(running([], { maxPayloadBytes: bytes - 1 }, source), snapshot(messages), 'bounds-exceeded');
  rejects(running([], { maxJsonDepth: 5 }), snapshot([{ ...parent(), metadata: { nested: [[[[[]]]]] } }]), 'bounds-exceeded');
  rejects(running([], { maxJsonNodes: 50 }), snapshot([{ ...parent(), metadata: { nodes: Array(50).fill(null) } }]), 'bounds-exceeded');
});


test('minimal roles preserve optional omission and reasoning omission has its own exemption', () => {
  const minimal = [
    { id: ref('developer'), role: 'developer', content: '' }, { id: ref('system'), role: 'system', content: '' },
    { id: message, role: 'assistant' }, { id: ref('user'), role: 'user', content: '' },
    { id: ref('tool'), role: 'tool', toolCallId: tool, content: '' },
    { id: ref('activity'), role: 'activity', activityType: '', content: {} },
    { id: ref('reasoning'), role: 'reasoning', content: '' },
  ] satisfies NativeMessage[];
  assert.deepEqual(event(running(), minimal).messages, minimal.map(value => ({ ...value,
    id: encoded('message', value.id), ...(value.role === 'tool' ? { toolCallId: encoded('tool', tool) } : {}),
  })));
  const reasoning = { id: message, role: 'reasoning', content: '' } satisfies NativeMessage;
  rejects(running([snapshot([reasoning]), snapshot([])]), startTool());
  mapped(running([snapshot([reasoning]), snapshot([{ ...reasoning, id: ref('other') }])]), startTool());
  mapped(running([snapshot([reasoning]), snapshot([parent(b)])]), startTool(b));
});

test('snapshots may change role without amending active or closed tool opener evidence', () => {
  const replacement = snapshot([{ id: message, role: 'user', content: '' }]);
  const actor = running([startTool(), replacement]);
  mapped(actor, { kind: 'tool-arguments', tool, owner: a, delta: 'continued' });
  mapped(actor, endTool()); mapped(actor, startTool()); mapped(actor, endTool());
  rejects(actor, startTool(a, ref('new')));
  const failed = running([snapshot([parent()])]);
  mapped(failed, { kind: 'run-failed', failure: 'native-failure' });
  rejects(failed, snapshot([]), 'invalid-order');
  const finished = running([snapshot([parent()]), finish]);
  mapped(finished, { kind: 'run-failed', failure: 'native-failure' });
});


test('equal native IDs remain distinct across scopes within one actual snapshot', () => {
  const native = [ref('same'), ref('same', ['a', 'b']), ref('same', ['a,b']), ref('\ud800'), ref('\ud801')];
  const output = event(running(), native.map(id => ({ id, role: 'assistant', subagentRunId: a, toolCalls: [
    { id, type: 'function', function: { name: 'same', arguments: '' } },
  ] })));
  assert.deepEqual(output.messages.map(value => value.id), native.map(id => encoded('message', id)));
  assert.equal(new Set(output.messages.map(value => value.id)).size, native.length);
  assert(output.messages.every(value => value.role === 'assistant' && value.toolCalls?.[0]?.id !== value.id));
});
