import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const src = new URL('../../src/', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (!url.startsWith(src) || !url.endsWith('.ts')) return next(url, context);
  return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    shortCircuit: true };
} });
const { createRunBaseline } = await import(new URL('baseline/index.ts', src).href);
const { createToolTracker, declaredToolObservations, emitObservation, jsonString, normalizedUsageFromCounts, normalizeUsage } = await import(new URL('core/run-observation.ts', src).href);
hook.deregister();

const bounds = { maxEntities: 256, maxPayloadBytes: 65536, maxJsonDepth: 32, maxJsonNodes: 4096 };
const families = ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'usage', 'reasoning', 'subagents'];
const freeze = value => Object.freeze(value);
const started = freeze({ kind: 'run-started' });
const success = freeze({ kind: 'terminal', outcome: 'success' });

function setup(t, extra = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const created = createRunBaseline({
    projection: { threadId: 'thread-1', runId: 'run-1', sourceKey: 'fixture', bounds },
    tracer: provider.getTracer('baseline-test'), parentContext: ROOT_CONTEXT, contentPolicy: { kind: 'none' },
    allowedToolNames: [], admitObservedToolNames: true, provider: 'fixture', ...extra,
  });
  assert.equal(created.kind, 'ok', JSON.stringify(created));
  const baseline = created.value;
  const events = [];
  const diagnostics = [];
  const feed = (...observations) => {
    for (const observation of observations) {
      const result = baseline.accept(freeze(observation));
      assert.equal(result.projection.kind, 'mapped', JSON.stringify({ observation, result }));
      events.push(...result.projection.events);
      diagnostics.push(...result.diagnostics);
    }
  };
  t.after(async () => { baseline.close(); await provider.shutdown(); });
  return { baseline, events, diagnostics, feed, spans: () => exporter.getFinishedSpans() };
}
const types = events => events.map(event => event.type);
const contentKeys = span => Object.keys(span.attributes).filter(key => /argument|result|messages/u.test(key));

test('a snapshot series emits one start, the suffix deltas, and one end', t => {
  const { events, feed } = setup(t);
  feed(started, { kind: 'text', messageId: 'm', mode: 'snapshot', text: 'a' },
    { kind: 'text', messageId: 'm', mode: 'snapshot', text: 'ab' }, success);
  assert.deepEqual(types(events).filter(type => type.startsWith('TEXT_')),
    ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
  assert.deepEqual(events.filter(event => event.type === 'TEXT_MESSAGE_CONTENT').map(event => event.delta), ['a', 'b']);
  assert.equal(events.find(event => event.type === 'TEXT_MESSAGE_START').role, 'assistant');
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
});

test('a snapshot that does not extend the previous one is dropped with a diagnostic', t => {
  const { events, diagnostics, feed } = setup(t);
  feed(started, { kind: 'text', messageId: 'm', mode: 'snapshot', text: 'ab' });
  const before = events.length;
  feed({ kind: 'text', messageId: 'm', mode: 'snapshot', text: 'a' });
  assert.equal(events.length, before);
  assert.deepEqual(diagnostics, [{ code: 'snapshot-not-extension' }]);
  feed(success);
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
});

test('tool arguments project without a span until execution is observed, then one span carries no payload', t => {
  const { events, feed, spans } = setup(t);
  const argumentsJson = jsonString({ path: 'secret.txt' });
  feed(started, { kind: 'tool', callId: 'call-1', name: 'read_file', phase: 'arguments-ended', argumentsJson });
  assert.deepEqual(types(events).slice(1), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']);
  assert.equal(events[2].delta, argumentsJson);
  assert.equal(spans().filter(span => span.name.startsWith('execute_tool')).length, 0);
  const resultJson = jsonString({ text: 'contents' });
  feed({ kind: 'tool', callId: 'call-1', name: 'read_file', phase: 'completed', resultJson });
  const result = events.find(event => event.type === 'TOOL_CALL_RESULT');
  assert.equal(result.content, resultJson);
  feed(success);
  const tools = spans().filter(span => span.name.startsWith('execute_tool'));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].attributes['gen_ai.tool.name'], 'read_file');
  assert.equal(tools[0].attributes['switchboard.run_id'], 'run-1');
  assert.deepEqual(contentKeys(tools[0]), []);
  assert(!JSON.stringify(tools[0].attributes).includes('secret.txt'));
});

test('a terminal closes a tool that only started before RUN_FINISHED', t => {
  const { events, feed } = setup(t);
  feed(started, { kind: 'tool', callId: 'call-1', name: 'read_file', phase: 'started' }, success);
  assert.deepEqual(types(events).slice(1), ['TOOL_CALL_START', 'TOOL_CALL_END', 'RUN_FINISHED']);
});

test('an invalid usage row is dropped and RUN_FINISHED still appears without it', t => {
  const { events, diagnostics, feed } = setup(t);
  feed(started, { kind: 'usage', rows: [{ inputTokens: 2, outputTokens: 3, totalTokens: 9 }] }, success);
  assert.deepEqual(diagnostics, [{ code: 'usage-row-dropped' }]);
  const finished = events.at(-1);
  assert.equal(finished.type, 'RUN_FINISHED');
  assert.equal(finished.usage, undefined);
});

test('a model boundary records one model span with tokens; cache counts stay on RUN_FINISHED', async t => {
  const { events, feed, spans } = setup(t);
  feed(started, { kind: 'model-boundary', requestModel: 'model-a', responseModel: 'model-a',
    usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 6 } },
  { kind: 'usage', rows: [{ provider: 'fixture', model: 'model-a', inputTokens: 10, outputTokens: 4, cachedInputTokens: 6, cacheWriteInputTokens: 1 }] },
  success);
  const models = spans().filter(span => span.attributes['gen_ai.operation.name'] === 'chat');
  assert.equal(models.length, 1);
  const [model] = models;
  assert.equal(model.attributes['switchboard.outcome'], 'success');
  assert.equal(model.attributes['gen_ai.request.model'], 'model-a');
  assert.equal(model.attributes['gen_ai.response.model'], 'model-a');
  assert.equal(model.attributes['gen_ai.usage.input_tokens'], 10);
  assert.equal(model.attributes['gen_ai.usage.output_tokens'], 4);
  assert(!Object.keys(model.attributes).some(key => key.includes('cache')));
  const agent = spans().find(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent');
  assert.equal(model.parentSpanContext.spanId, agent.spanContext().spanId);
  const finished = events.at(-1);
  assert.equal(finished.type, 'RUN_FINISHED');
  assert.deepEqual(finished.usage, [{ provider: 'fixture', model: 'model-a', inputTokens: 10, outputTokens: 4, cachedInputTokens: 6, cacheWriteInputTokens: 1 }]);
});

test('a continuation baseline projects a tool result without the earlier start', t => {
  const { events, feed, spans } = setup(t);
  const argumentsJson = jsonString({ a: 1 });
  feed(started,
    { kind: 'tool', callId: 'call-1', name: 'add', phase: 'started' },
    { kind: 'tool', callId: 'call-1', name: 'add', phase: 'arguments', argumentsJson },
    { kind: 'tool', callId: 'call-1', name: 'add', phase: 'arguments-ended' },
    { kind: 'tool', callId: 'call-1', name: 'add', phase: 'completed', resultJson: '2' }, success);
  assert.deepEqual(types(events).slice(1), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'RUN_FINISHED']);
  assert.equal(spans().filter(span => span.name === 'execute_tool add').length, 1);
});

test('a fresh baseline that only sees completed still emits start, arguments, end, and result', t => {
  const { events, feed } = setup(t);
  feed(started, { kind: 'tool', callId: 'call-1', name: 'add', phase: 'completed', argumentsJson: '{"a":1}', resultJson: '2' }, success);
  assert.deepEqual(types(events).slice(1), ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'RUN_FINISHED']);
});

test('argument deltas append in order for phase arguments', t => {
  const { events, feed } = setup(t);
  feed(started, { kind: 'tool', callId: 'c', name: 'add', phase: 'started' },
    { kind: 'tool', callId: 'c', name: 'add', phase: 'arguments', argumentsJson: '{"a"' },
    { kind: 'tool', callId: 'c', name: 'add', phase: 'arguments', argumentsJson: ':1}' },
    { kind: 'tool', callId: 'c', name: 'add', phase: 'arguments-ended' }, success);
  assert.equal(events.filter(event => event.type === 'TOOL_CALL_ARGS').map(event => event.delta).join(''), '{"a":1}');
});

test('a pending success encodes the pending tool id and emits no tool result', t => {
  const { events, feed } = setup(t);
  feed(started, { kind: 'tool', callId: 'call-1', name: 'add', phase: 'arguments-ended', argumentsJson: '{}' },
    { kind: 'terminal', outcome: 'success', pendingTools: ['call-1'] });
  const finished = events.at(-1);
  assert.equal(finished.type, 'RUN_FINISHED');
  const toolCallId = events.find(event => event.type === 'TOOL_CALL_START').toolCallId;
  assert.deepEqual(finished.outcome.pendingToolCallIds, [toolCallId]);
  assert(!events.some(event => event.type === 'TOOL_CALL_RESULT'));
});

test('Cursor-shaped observations keep text and thinking apart and project an error result', t => {
  const { events, feed, spans } = setup(t);
  feed(started, { kind: 'text', messageId: 'assistant', mode: 'snapshot', text: 'Hello' },
    { kind: 'reasoning', messageId: 'reasoning', mode: 'snapshot', text: 'thinking do-not-leak' },
    { kind: 'text', messageId: 'assistant', mode: 'snapshot', text: 'Hello world' },
    { kind: 'tool', callId: 'tool\n1', name: 'shell', phase: 'started' },
    { kind: 'tool', callId: 'tool\n1', name: 'shell', phase: 'arguments', argumentsJson: '{"cmd":"do-not-leak"}' },
    { kind: 'tool', callId: 'tool\n1', name: 'shell', phase: 'failed', resultJson: jsonString('do-not-leak') }, success);
  assert(events.some(event => event.type === 'REASONING_MESSAGE_START' && event.role === 'reasoning'));
  const textIds = new Set(events.filter(event => event.type.startsWith('TEXT_MESSAGE')).map(event => event.messageId));
  const reasoningIds = new Set(events.filter(event => event.type.startsWith('REASONING_MESSAGE')).map(event => event.messageId));
  assert.equal(textIds.size, 1);
  assert.equal(reasoningIds.size, 1);
  assert.notDeepEqual([...textIds], [...reasoningIds]);
  assert.equal(events.find(event => event.type === 'TOOL_CALL_RESULT').content, '"do-not-leak"');
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
  const [tool] = spans().filter(span => span.name.startsWith('execute_tool'));
  assert.equal(tool.attributes['switchboard.outcome'], 'error');
  assert.equal(tool.attributes['error.type'], 'tool-error');
  assert.equal(tool.attributes['gen_ai.tool.call.id'], undefined);
  assert(!JSON.stringify(spans().map(span => span.attributes)).includes('do-not-leak'));
});

test('close after a text-only success reports every gap as unsupported and unqualified', t => {
  const { baseline, feed } = setup(t);
  feed(started, { kind: 'text', messageId: 'm', mode: 'delta', text: 'hi' }, success);
  const report = baseline.close();
  assert.equal(report.error, undefined);
  assert.deepEqual(report.families.map(row => row.family), families);
  for (const row of report.families) {
    assert.equal(row.availability, 'unsupported', row.family);
    assert.equal(row.qualification, 'unqualified');
  }
  assert.deepEqual(report.baseline, [
    { family: 'text', availability: 'supported', qualification: 'unqualified' },
    { family: 'tools', availability: 'unsupported', qualification: 'unqualified' },
    { family: 'steps', availability: 'unsupported', qualification: 'unqualified' },
  ]);
});

test('usage and reasoning families are supported when observed', t => {
  const { baseline, feed } = setup(t);
  feed(started, { kind: 'reasoning', messageId: 'r', mode: 'delta', text: 'x' },
    { kind: 'usage', rows: [{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }] }, success);
  const report = baseline.close();
  const supported = report.families.filter(row => row.availability === 'supported').map(row => row.family);
  assert.deepEqual(supported, ['usage', 'reasoning']);
});

test('outcome-unknown finishes the agent span unknown and emits no terminal event', t => {
  const { events, feed, spans } = setup(t);
  feed(started, { kind: 'text', messageId: 'm', mode: 'delta', text: 'partial' }, { kind: 'terminal', outcome: 'outcome-unknown' });
  assert(!events.some(event => event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'));
  const [agent] = spans();
  assert.equal(agent.attributes['gen_ai.operation.name'], 'invoke_agent');
  assert.equal(agent.attributes['switchboard.outcome'], 'outcome-unknown');
});

test('failed and cancelled terminals map to RUN_ERROR and a cancelled RUN_FINISHED', t => {
  const failed = setup(t);
  failed.feed(started, { kind: 'interrupt', id: 'p', reason: 'permission' }, { kind: 'terminal', outcome: 'failed' });
  assert.equal(failed.events.at(-1).type, 'RUN_ERROR');
  assert(!failed.events.some(event => event.type === 'RUN_FINISHED'));
  assert.equal(failed.spans()[0].attributes['error.type'], 'unknown-error');
  const cancelled = setup(t);
  cancelled.feed(started, { kind: 'terminal', outcome: 'cancelled' });
  assert.equal(cancelled.events.at(-1).outcome.type, 'cancelled');
  assert.equal(cancelled.spans()[0].attributes['switchboard.outcome'], 'cancelled');
});

test('a second run-started is an error result and starts no second agent span', t => {
  const { baseline, feed, spans } = setup(t);
  feed(started);
  const second = baseline.accept(started);
  assert.deepEqual(second.projection, { kind: 'error', error: { code: 'invalid-order' } });
  feed(success);
  assert.equal(spans().filter(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent').length, 1);
});

test('observations after the terminal are dropped with a diagnostic', t => {
  const { baseline, feed } = setup(t);
  feed(started, success);
  const late = baseline.accept({ kind: 'usage', rows: [{ inputTokens: 1 }] });
  assert.deepEqual(late.diagnostics, [{ code: 'after-terminal' }]);
});

test('jsonString returns strings for JSON values and undefined otherwise without throwing', () => {
  const cycle = {};
  cycle.self = cycle;
  for (const value of [undefined, () => {}, Symbol('x'), 1n, cycle, { nested: 1n }]) assert.equal(jsonString(value), undefined);
  assert.equal(jsonString({ a: [1, 'b', null] }), '{"a":[1,"b",null]}');
  assert.equal(jsonString('x'), '"x"');
});

test('repeated execution observations for one call record one tool span and one result', t => {
  const { feed, diagnostics, events, spans } = setup(t);
  feed(started, { kind: 'tool', callId: 'c', name: 'add', phase: 'completed', resultJson: '1' },
    { kind: 'tool', callId: 'c', name: 'add', phase: 'completed', resultJson: '1' },
    { kind: 'tool', callId: 'c', name: 'add', phase: 'failed' }, success);
  assert.equal(spans().filter(span => span.name === 'execute_tool add').length, 1);
  assert.equal(events.filter(event => event.type === 'TOOL_CALL_RESULT').length, 1);
  assert.deepEqual(diagnostics, [{ code: 'tool-result-repeated' }]);
});

test('a duplicate run-started is reported by close', t => {
  const { baseline, feed } = setup(t);
  feed(started);
  baseline.accept(started);
  assert.deepEqual(baseline.close().error, { code: 'invalid-order' });
});

test('spans are not recorded before run-started', t => {
  const { baseline, spans } = setup(t);
  for (const observation of [{ kind: 'model-boundary', requestModel: 'm', responseModel: 'm' },
    { kind: 'tool', callId: 'c', name: 'add', phase: 'completed', resultJson: '1' }]) {
    assert.deepEqual(baseline.accept(observation).diagnostics, [{ code: 'not-running' }]);
  }
  assert.equal(spans().length, 0);
});

test('normalized native usage with cache above input and reasoning above output reaches RUN_FINISHED', t => {
  const row = normalizeUsage({ inputTokens: 2, outputTokens: 3, cachedInputTokens: 10, cacheWriteInputTokens: 1, reasoningTokens: 9, totalTokens: 5 });
  assert.deepEqual(row, { outputTokens: 3, cachedInputTokens: 10, cacheWriteInputTokens: 1, inputTokens: 13 });
  const { feed, diagnostics, events } = setup(t);
  feed(started, { kind: 'usage', rows: [row] }, success);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(events.at(-1).usage, [row]);
  assert.deepEqual(normalizeUsage({ inputTokens: 20, outputTokens: 3, cachedInputTokens: 5, totalTokens: 23 }),
    { outputTokens: 3, cachedInputTokens: 5, inputTokens: 20, totalTokens: 23 });
});

test('usage is not reported supported when outcome-unknown attaches no terminal', t => {
  const { baseline, feed } = setup(t);
  feed(started, { kind: 'usage', rows: [{ inputTokens: 1, outputTokens: 1 }] }, { kind: 'terminal', outcome: 'outcome-unknown' });
  assert.equal(baseline.close().families.find(row => row.family === 'usage').availability, 'unsupported');
});

test('a pending id the baseline never saw is dropped with a diagnostic', t => {
  const { feed, diagnostics, events } = setup(t);
  feed(started, { kind: 'tool', callId: 'c', name: 'add', phase: 'arguments-ended', argumentsJson: '{}' },
    { kind: 'terminal', outcome: 'success', pendingTools: ['c', 'never-seen'] });
  assert.deepEqual(diagnostics, [{ code: 'pending-tool-unknown' }]);
  assert.equal(events.at(-1).outcome.pendingToolCallIds.length, 1);
});

test('a started tool with no arguments takes the arguments carried by arguments-ended', t => {
  const { events, diagnostics, feed } = setup(t);
  feed(started, { kind: 'tool', callId: 'c', name: 'run', phase: 'started' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments-ended', argumentsJson: '{"command":"ls"}' }, success);
  assert.deepEqual(events.filter(event => event.type === 'TOOL_CALL_ARGS').map(event => event.delta), ['{"command":"ls"}']);
  assert.deepEqual(diagnostics, []);
});

test('non-append arguments that differ from those already sent are reported and not sent again', t => {
  const { events, diagnostics, feed } = setup(t);
  feed(started, { kind: 'tool', callId: 'c', name: 'run', phase: 'completed', argumentsJson: '{"a":1}' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'completed', argumentsJson: '{"a":2}' }, success);
  assert.deepEqual(events.filter(event => event.type === 'TOOL_CALL_ARGS').map(event => event.delta), ['{"a":1}']);
  assert.deepEqual(diagnostics.map(row => row.code), ['tool-arguments-changed']);
});

test('the tool tracker holds back a {} placeholder until the first other arguments', () => {
  const track = createToolTracker();
  assert.deepEqual(track('c', 'run', '{}'), [{ kind: 'tool', callId: 'c', name: 'run', phase: 'started' }]);
  assert.deepEqual(track('c', 'run', '{"a":1}'), [{ kind: 'tool', callId: 'c', name: 'run', phase: 'arguments', argumentsJson: '{"a":1}' }]);
  assert.deepEqual(track('c', 'run', '{"a":2}'), []);
});

test('appended arguments are accumulated: a later full value that differs is reported, a matching one is not', t => {
  const same = setup(t);
  same.feed(started, { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments', argumentsJson: '{"a"' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments', argumentsJson: ':1}' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments-ended', argumentsJson: '{"a":1}' }, success);
  assert.deepEqual(same.diagnostics.map(row => row.code), []);
  const differs = setup(t);
  differs.feed(started, { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments', argumentsJson: '{"a"' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments', argumentsJson: ':1}' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'completed', argumentsJson: '{"a":2}' }, success);
  assert.deepEqual(differs.diagnostics.map(row => row.code), ['tool-arguments-changed']);
});

test('an arguments delta after the arguments closed is reported, not dropped silently', t => {
  const { events, diagnostics, feed } = setup(t);
  feed(started, { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments', argumentsJson: '{"a":1}' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments-ended' },
    { kind: 'tool', callId: 'c', name: 'run', phase: 'arguments', argumentsJson: 'late' }, success);
  assert.deepEqual(events.filter(event => event.type === 'TOOL_CALL_ARGS').map(event => event.delta), ['{"a":1}']);
  assert.deepEqual(diagnostics.map(row => row.code), ['tool-arguments-changed']);
});

test('text, reasoning, and usage before run-started are dropped as not-running', t => {
  const { events, diagnostics, feed } = setup(t);
  feed({ kind: 'text', messageId: 'm', mode: 'delta', text: 'hi' }, { kind: 'reasoning', messageId: 'r', mode: 'delta', text: 'hm' },
    { kind: 'usage', rows: [{ inputTokens: 1, outputTokens: 1 }] });
  assert.deepEqual(diagnostics.map(row => row.code), ['not-running', 'not-running', 'not-running']);
  assert.deepEqual(events, []);
});

test('the report says whether a terminal was processed', t => {
  const done = setup(t);
  done.feed(started, success);
  assert.equal(done.baseline.close().terminated, true);
  const open = setup(t);
  open.feed(started);
  assert.equal(open.baseline.close().terminated, false);
});

test('declaredToolObservations declares a call with JSON-safe arguments only', () => {
  assert.deepEqual(declaredToolObservations('c1', 'tool', { a: 1 }), [
    { kind: 'tool', callId: 'c1', name: 'tool', phase: 'started' },
    { kind: 'tool', callId: 'c1', name: 'tool', phase: 'arguments-ended', argumentsJson: '{"a":1}' },
  ]);
  assert.deepEqual(declaredToolObservations('c1', 'tool', undefined).map(o => o.phase), ['started', 'arguments-ended']);
  assert.equal('argumentsJson' in declaredToolObservations('c1', 'tool', undefined)[1], false);
});

test('normalizedUsageFromCounts maps counts then normalizes, or is undefined without counts', () => {
  assert.equal(normalizedUsageFromCounts({ inputTokens: -1, outputTokens: 'x' }), undefined);
  assert.deepEqual(normalizedUsageFromCounts({ inputTokens: 3, outputTokens: 2 }),
    normalizeUsage({ inputTokens: 3, outputTokens: 2 }));
});

test('a terminal before run-started is dropped as not-running and does not terminate the segment', t => {
  const { baseline } = setup(t);
  const result = baseline.accept(success);
  assert.deepEqual(result.diagnostics, [{ code: 'not-running' }]);
  assert.equal(result.projection.kind, 'mapped');
  assert.deepEqual(result.projection.events, []);
  assert.equal(baseline.close().terminated, false);
});

test('an observation after close is dropped as after-close without touching the projector', t => {
  const { baseline } = setup(t);
  baseline.accept(started);
  const report = baseline.close();
  const late = baseline.accept({ kind: 'text', messageId: 'm', mode: 'delta', text: 'late' });
  assert.deepEqual(late.diagnostics, [{ code: 'after-close' }]);
  assert.deepEqual(late.projection.events, []);
  assert.equal(baseline.close(), report);
});

test('emitObservation delivers a deeply frozen copy and never freezes the caller object', () => {
  const original = { kind: 'usage', rows: [{ inputTokens: 1 }] };
  let delivered;
  emitObservation(observation => { delivered = observation; }, original);
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(original.rows), false);
  assert.equal(Object.isFrozen(original.rows[0]), false);
  assert.deepEqual(delivered, original);
  assert.notEqual(delivered, original);
  assert.equal(Object.isFrozen(delivered), true);
  assert.equal(Object.isFrozen(delivered.rows), true);
  assert.equal(Object.isFrozen(delivered.rows[0]), true);
});

test('invalid observer configuration returns an invalid-input error instead of throwing', () => {
  const created = createRunBaseline({
    projection: { threadId: 'thread-1', runId: 'run-1', sourceKey: 'fixture', bounds },
    tracer: new BasicTracerProvider().getTracer('baseline-test'), parentContext: ROOT_CONTEXT, contentPolicy: { kind: 'none' },
    allowedToolNames: ['bad name\n'], admitObservedToolNames: true, provider: 'fixture',
  });
  assert.deepEqual(created, { kind: 'error', error: { code: 'invalid-input' } });
});

test('a malformed observation is reported as invalid-observation and changes no state', t => {
  const { baseline, events, feed } = setup(t);
  for (const bad of [null, undefined, 'text', 7, [], {}, { kind: 'bogus' }, { kind: 5 }]) {
    const result = baseline.accept(bad);
    assert.equal(result.projection.kind, 'mapped');
    assert.deepEqual(result.projection.events, []);
    assert.deepEqual(result.diagnostics, [{ code: 'invalid-observation' }]);
  }
  feed(started, success);
  assert.deepEqual(types(events), ['RUN_STARTED', 'RUN_FINISHED']);
});
