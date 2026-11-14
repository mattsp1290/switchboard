import assert from 'node:assert/strict';
import test from 'node:test';
import { createAguiProjection, describeProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, NativeInterrupt, NativeRef, NativeTokenUsage, ProjectionBounds, ProjectionEvent, ProjectionFact, TerminalFact } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const bounds: ProjectionBounds = { maxEntities: 32, maxPayloadBytes: 16384, maxJsonDepth: 24, maxJsonNodes: 1024 };
const ref = (id: string, scope: readonly string[] = ['native']): NativeRef => ({ scope, id });
const tool = ref('tool'), owner = ref('owner');
const selected: NativeInterrupt = { interrupt: ref('interrupt'), reason: 'open-reason' };
const interrupted: TerminalFact = { kind: 'run-finished', outcome: 'interrupt', interrupts: [selected] };
const success: TerminalFact = { kind: 'run-finished', outcome: 'success' };
const failure: TerminalFact = { kind: 'run-failed', failure: 'native-failure' };
const encoded = (kind: string, value: NativeRef, source = 'source') => JSON.stringify([1, source, kind, value.scope, value.id]);
let batch = 0;
function actor(limits: Partial<ProjectionBounds> = {}, sourceKey = 'source', runId = 'run'): AguiProjection {
  const made = createAguiProjection({ threadId: 'thread', runId, sourceKey, bounds: { ...bounds, ...limits } });
  assert(made.kind === 'ok');
  return made.value;
}
function mapped(projection: AguiProjection, fact: ProjectionFact): readonly ProjectionEvent[] {
  const result = projection.accept(fact);
  assert(result.kind === 'mapped', JSON.stringify(result));
  collectEvents(`terminals/${batch++}/${fact.kind}`, result.events);
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
function terminal(projection: AguiProjection, fact: TerminalFact) {
  const event = mapped(projection, fact)[0];
  assert(event?.type === 'RUN_FINISHED' || event?.type === 'RUN_ERROR');
  return event;
}
const closedTool = (attribution?: NativeRef): readonly ProjectionFact[] => [
  { kind: 'tool-started', tool, name: 'fn', ...(attribution === undefined ? {} : { owner: attribution }) },
  { kind: 'tool-arguments-ended', tool, ...(attribution === undefined ? {} : { owner: attribution }) },
];

test('terminal capability descriptions retain undeclared native evidence', () => {
  for (const family of ['interrupts', 'usage'] as const) {
    assert.deepEqual(describeProjection(family), { kind: 'ok', value: { family, representability: 'represented', availability: 'undeclared', qualification: 'undeclared' } });
  }
});

test('every terminal preserves usage and fixed safe failure messages, including idle and late errors', () => {
  const usage = [{ provider: '', model: '', inputTokens: 0, outputTokens: 0, totalTokens: 0 }];
  for (const fact of [success, { kind: 'run-finished', outcome: 'cancelled' }, interrupted] satisfies TerminalFact[]) {
    const projection = running();
    const event = terminal(projection, { ...fact, usage, timestamp: 0 });
    assert.equal(event.timestamp, 0);
    assert.deepEqual(event.usage, usage);
    assert(event.type === 'RUN_FINISHED');
    assert.equal(event.threadId, 'thread');
    assert.equal(event.runId, 'run');
    const late = terminal(projection, { kind: 'run-failed', failure: 'transport-failure', usage });
    assert.deepEqual(late, { type: 'RUN_ERROR', code: 'transport-failure', message: 'The native run transport failed.', usage });
  }
  for (const projection of [actor(), running()]) {
    assert.deepEqual(terminal(projection, { ...failure, usage }), {
      type: 'RUN_ERROR', code: 'native-failure', message: 'The native run failed.', usage,
    });
    rejects(projection, failure, 'invalid-order');
  }
});

test('interrupts transform only explicit references and detach opaque nested JSON', () => {
  const metadata = { id: 'opaque-id', values: [null, 0] };
  const responseSchema = { id: 'opaque-schema-id', properties: { answer: { type: 'string' } } };
  const input: NativeInterrupt = { ...selected, tool, owner, message: '', expiresAt: 'opaque-expiry', metadata, responseSchema };
  const projection = running(closedTool(owner));
  const event = terminal(projection, { ...interrupted, interrupts: [input, { ...selected, interrupt: ref('other'), reason: '' }] });
  assert(event.type === 'RUN_FINISHED' && event.outcome?.type === 'interrupt');
  assert.deepEqual(event.outcome.interrupts, [{ id: encoded('interrupt', selected.interrupt), reason: selected.reason,
    toolCallId: encoded('tool', tool), subagentRunId: encoded('subagent', owner), message: '', expiresAt: 'opaque-expiry', metadata, responseSchema },
  { id: encoded('interrupt', ref('other')), reason: '' }]);
  const before = JSON.stringify(event);
  metadata.values.push(1);
  responseSchema.properties.answer.type = 'changed';
  assert.equal(JSON.stringify(event), before);
  assert(Object.isFrozen(event.outcome.interrupts[0]?.metadata));
  assert(Object.isFrozen(event.outcome.interrupts[0]?.responseSchema));
});

test('scoped terminal identities are stable across actors and separate domains and sources', () => {
  const ids = new Set<string>();
  for (const native of [ref('same'), ref('same', ['other']), ref('\ud800'), ref('\ud801'), ref('\ufffd')]) {
    const outputs: string[] = [];
    for (const runId of ['first', 'second']) {
      const projection = actor({}, 'source', runId);
      mapped(projection, { kind: 'run-started' });
      const event = terminal(projection, { ...interrupted, interrupts: [{ interrupt: native, tool: native, owner: native, reason: '' }] });
      assert(event.type === 'RUN_FINISHED' && event.outcome?.type === 'interrupt');
      const item = event.outcome.interrupts[0];
      assert(item);
      assert.equal(item.id, encoded('interrupt', native));
      assert.equal(item.toolCallId, encoded('tool', native));
      assert.equal(item.subagentRunId, encoded('subagent', native));
      assert.equal(new Set([item.id, item.toolCallId, item.subagentRunId]).size, 3);
      outputs.push(item.id);
      ids.add(item.id);
    }
    assert.equal(outputs[0], outputs[1]);
  }
  assert.equal(ids.size, 5);
  const projection = actor({}, 'other-source');
  mapped(projection, { kind: 'run-started' });
  const event = terminal(projection, interrupted);
  assert(event.type === 'RUN_FINISHED' && event.outcome?.type === 'interrupt');
  assert.equal(event.outcome.interrupts[0]?.id, encoded('interrupt', selected.interrupt, 'other-source'));
});

test('duplicate interrupts and actual tool owner disagreement reject atomically', () => {
  rejects(running(), { ...interrupted, interrupts: [selected, selected] }, 'identity-conflict');
  for (const [actual, declared] of [[undefined, owner], [owner, undefined], [owner, ref('different')]]) {
    rejects(running(closedTool(actual)), { ...interrupted, interrupts: [{ ...selected, tool,
      ...(declared === undefined ? {} : { owner: declared }) }] }, 'identity-conflict');
  }
  terminal(running(closedTool()), { ...interrupted, interrupts: [{ ...selected, tool }] });
  terminal(running(), { ...interrupted, interrupts: [{ ...selected, tool, owner }] });
  terminal(running(), { ...interrupted, interrupts: [{ ...selected, owner }] });
  terminal(running(), interrupted);
});

test('snapshot tool descriptors do not replace actual tool ownership evidence', () => {
  const snapshot: ProjectionFact = { kind: 'messages-snapshot', messages: [{ id: ref('message'), role: 'assistant',
    subagentRunId: ref('snapshot-owner'), toolCalls: [{ id: tool, type: 'function', function: { name: '', arguments: '' } }] }] };
  terminal(running([snapshot]), { ...interrupted, interrupts: [{ ...selected, tool, owner }] });
  terminal(running([...closedTool(owner), snapshot]), { ...interrupted, interrupts: [{ ...selected, tool, owner }] });
  rejects(running([...closedTool(owner), snapshot]), { ...interrupted, interrupts: [{ ...selected, tool, owner: ref('snapshot-owner') }] }, 'identity-conflict');
  terminal(running(), { ...interrupted, interrupts: [{ ...selected, responseSchema: {}, metadata: {} }] });
});

test('all finish outcomes require actual streams closed and pending calls remain compatible', () => {
  for (const open of [{ kind: 'text-started', message: ref('message'), role: 'assistant' },
    { kind: 'tool-started', tool, name: 'fn' }, { kind: 'step-started', step: ref('step') }] satisfies ProjectionFact[]) {
    for (const fact of [success, interrupted, { kind: 'run-finished', outcome: 'cancelled' }] satisfies TerminalFact[]) {
      rejects(running([open]), { ...fact, usage: [] }, 'invalid-order');
    }
    terminal(running([open]), { ...failure, usage: [] });
  }
  for (const fact of [success, interrupted, { kind: 'run-finished', outcome: 'cancelled' }] satisfies TerminalFact[]) {
    terminal(running(closedTool()), fact);
  }
  terminal(running(closedTool()), { ...success, pendingTools: [tool], usage: [] });
  rejects(running(closedTool()), { ...success, pendingTools: [], usage: [] }, 'identity-conflict');
});

test('usage preserves omission, empty rows, incomplete labels, zeros and partial accounting', () => {
  const valid: readonly (readonly NativeTokenUsage[])[] = [[], [{}], [{ provider: 'p' }, { provider: 'p' }],
    [{ model: 'm' }, { model: 'm' }], [{}, {}], [{ provider: '' }, { model: '' }],
    [{ provider: '', model: '' }, { provider: 'p', model: '' }],
    [{ cachedInputTokens: 2, cacheWriteInputTokens: 3, reasoningTokens: 4, totalTokens: 9 }],
    [{ inputTokens: 5, cachedInputTokens: 2, cacheWriteInputTokens: 3, outputTokens: 4, reasoningTokens: 4, totalTokens: 9 }],
    [{ inputTokens: 2, reasoningTokens: 3, totalTokens: 5 }], [{ cachedInputTokens: 3, outputTokens: 2, totalTokens: 5 }],
    [{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER }],
    [{ cachedInputTokens: Number.MAX_SAFE_INTEGER }], [{ reasoningTokens: Number.MAX_SAFE_INTEGER }],
    [{ provider: 'p', model: 'm' }], [{ totalTokens: 0 }], [{ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }],
    [{ inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER }],
    [{ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: Number.MAX_SAFE_INTEGER - 1, cacheWriteInputTokens: 1 }]];
  assert(!('usage' in terminal(running(), success)));
  for (const usage of valid) assert.deepEqual(terminal(running(), { ...success, usage }).usage, usage);
  const usage = [{ provider: 'before', inputTokens: 0 }];
  const event = terminal(running(), { ...success, usage });
  const row = usage[0];
  assert(row);
  row.provider = 'after';
  assert.deepEqual(event.usage, [{ provider: 'before', inputTokens: 0 }]);
  assert(Object.isFrozen(event.usage?.[0]));
});

test('usage rejects invalid counts, labels, unknown fields, duplicate known pairs and impossible sums', () => {
  const invalid: unknown[] = [null, {}, [null], [[]], [{ extra: 0 }], [{ provider: null }], [{ model: 0 }],
    [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }], [{ provider: '', model: '' }, { provider: '', model: '' }],
    [{ inputTokens: 1, cachedInputTokens: 2 }], [{ inputTokens: 4, cachedInputTokens: 2, cacheWriteInputTokens: 3 }],
    [{ outputTokens: 1, reasoningTokens: 2 }], [{ inputTokens: 2, outputTokens: 3, totalTokens: 6 }],
    [{ inputTokens: 2, outputTokens: 3, totalTokens: 4 }], [{ inputTokens: 2, totalTokens: 1 }],
    [{ outputTokens: 2, totalTokens: 1 }], [{ cachedInputTokens: 2, cacheWriteInputTokens: 3, totalTokens: 4 }],
    [{ reasoningTokens: 2, totalTokens: 1 }], [{ cachedInputTokens: 3, reasoningTokens: 2, totalTokens: 4 }],
    [{ inputTokens: 2, reasoningTokens: 3, totalTokens: 4 }], [{ cachedInputTokens: 3, outputTokens: 2, totalTokens: 4 }],
    [{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }],
    [{ cachedInputTokens: Number.MAX_SAFE_INTEGER, cacheWriteInputTokens: 1 }],
    [{ cachedInputTokens: Number.MAX_SAFE_INTEGER, reasoningTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }]];
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheWriteInputTokens']) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) invalid.push([{ [key]: value }]);
  }
  for (const usage of invalid) rejects(running(), { ...success, usage });
  rejects(actor(), { ...failure, usage: [{ totalTokens: -1 }] });
});

test('terminal boundaries reject unknown fields, accessors, prototypes and nonobject payloads', () => {
  for (const extra of [{ toolCallId: 'wire' }, { id: 'wire' }, { subagentRunId: 'wire' }, { message: 1 },
    { reason: null }, { expiresAt: 0 }, { responseSchema: true }, { responseSchema: [] }, { metadata: null },
    { metadata: [] }, { interrupt: { id: 'missing-scope' } }, { tool: { scope: [0], id: '' } }]) {
    rejects(running(), { ...interrupted, interrupts: [{ ...selected, ...extra }] });
  }
  for (const fact of [{ ...interrupted, interrupts: [] }, { ...interrupted, interrupts: null },
    { ...interrupted, result: {} }, { ...success, interrupts: [selected] }, { ...failure, outcome: 'success' }]) rejects(running(), fact);
  let reads = 0;
  const accessor = { get hidden() { reads++; return 'secret'; } };
  for (const value of [accessor, new Date(), Object.create({ inherited: true })]) {
    for (const field of ['metadata', 'responseSchema']) rejects(running(), { ...interrupted, interrupts: [{ ...selected, [field]: value }] });
    rejects(running(), { ...success, usage: [value] });
  }
  assert.equal(reads, 0);
});

test('unique terminal references and expanded output obey entity, byte, depth and node limits', () => {
  const fact: TerminalFact = { ...interrupted, interrupts: [{ ...selected, tool, owner }, { ...selected, interrupt: ref('second'), tool, owner }] };
  terminal(running([], { maxEntities: 4 }), fact);
  rejects(running([], { maxEntities: 3 }), fact, 'bounds-exceeded');
  terminal(running(closedTool(owner), { maxEntities: 3 }), { ...interrupted, interrupts: [{ ...selected, tool, owner }] });
  const projection = actor({}, 's'.repeat(100));
  mapped(projection, { kind: 'run-started' });
  const expected = mapped(projection, fact);
  const bytes = Buffer.byteLength(JSON.stringify(expected));
  assert(Buffer.byteLength(JSON.stringify(fact)) < bytes);
  for (const limit of [bytes, bytes - 1]) {
    const bounded = actor({ maxPayloadBytes: limit }, 's'.repeat(100));
    mapped(bounded, { kind: 'run-started' });
    if (limit === bytes) assert.deepEqual(mapped(bounded, fact), expected);
    else rejects(bounded, fact, 'bounds-exceeded');
  }
  const nested = { ...interrupted, interrupts: [{ ...selected, metadata: { nested: [[[[[0]]]]] } }] };
  rejects(running([], { maxJsonDepth: 6 }), nested, 'bounds-exceeded');
  rejects(running([], { maxJsonNodes: 40 }), { ...success, usage: Array.from({ length: 30 }, () => ({})) }, 'bounds-exceeded');
  const independent = running();
  rejects(running(), { ...interrupted, interrupts: [selected, selected] }, 'identity-conflict');
  terminal(independent, interrupted);
});

test('provisional custom usage observations declare delta or cumulative meaning without accumulation', () => {
  const projection = running();
  for (const interpretation of ['delta', 'cumulative']) {
    const payload = { provisional: true, interpretation, usage: [{ inputTokens: 3 }] };
    const event = mapped(projection, { kind: 'custom', namespace: 'example.usage', schemaVersion: '1', name: 'usage-observed', publicPayload: payload })[0];
    assert(event?.type === 'CUSTOM');
    assert.deepEqual(event.value, { namespace: 'example.usage', schemaVersion: '1', publicPayload: payload });
  }
  assert.deepEqual(terminal(projection, { ...success, usage: [{ inputTokens: 1 }] }).usage, [{ inputTokens: 1 }]);
});
