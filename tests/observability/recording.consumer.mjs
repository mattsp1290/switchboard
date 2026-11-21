import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createTraceState, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SamplingDecision, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import Ajv2020 from 'ajv/dist/2020.js';
import { createGenAiObserver, instrumentationScope } from '@mattsp1290/switchboard/observability';

const agent = { kind: 'agent', provider: 'openai', name: 'fixture' };
const model = { kind: 'model', provider: 'openai', operation: 'chat', requestModel: 'requested' };
const input = (content = 'safe input') => [{ role: 'user', parts: [{ type: 'text', content }] }];
const output = (content = 'safe output') => [{ role: 'assistant', parts: [{ type: 'text', content }], finish_reason: 'stop' }];
const success = { kind: 'success' };
const canary = 'PRIVATE-CANARY-OBSERVABILITY';
function unwrap(result) { assert.equal(result.kind, 'ok', JSON.stringify(result)); return result.value; }
function rejected(result, code) { assert.deepEqual(result, { kind: 'error', error: { code } }); }
function host(t, options = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const observer = createGenAiObserver({ tracer: provider.getTracer(instrumentationScope.name, instrumentationScope.version),
    allowedToolNames: ['add'], contentPolicy: { kind: 'none' }, ...options });
  t.after(async () => { observer.close(); await provider.shutdown(); });
  return { observer, exporter, provider };
}
function spans(exporter) { return exporter.getFinishedSpans(); }
function serialized(exporter) {
  return JSON.stringify(spans(exporter).map(span => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })));
}

test('observability records explicit parentage, independent requests, and missing versus zero usage', async t => {
  const { observer, exporter, provider } = host(t, { includeConversationId: true });
  const correlation = { runId: 'run-1', requestId: 'request-1', conversationId: 'conversation-1' };
  const root = unwrap(observer.start(agent, ROOT_CONTEXT, correlation));
  const other = unwrap(observer.start(agent, ROOT_CONTEXT));
  const first = unwrap(observer.start(model, root.context, correlation));
  const second = unwrap(observer.start(model, root.context, correlation));
  const tool = unwrap(observer.start({ kind: 'tool', name: 'add', callId: 'call-1' }, root.context, correlation));
  assert.equal(root.kind, 'agent');
  assert.equal(trace.getSpan(root.context).isRecording(), false);
  trace.getSpan(root.context).end();
  assert.equal(spans(exporter).length, 0, 'Handle context cannot end the owned SDK span');
  unwrap(first.update({ responseModel: 'actual', usage: { inputTokens: 0, outputTokens: 3 } }));
  unwrap(second.update({ usage: { outputTokens: 1 } }));
  for (const handle of [first, second, tool, root, other]) unwrap(handle.finish(success));
  await provider.forceFlush();
  const actual = spans(exporter);
  assert.equal(actual.length, 5);
  assert.equal(new Set(actual.filter(span => span.name.startsWith('invoke_agent')).map(span => span.spanContext().traceId)).size, 2);
  for (const child of actual.slice(0, 3)) {
    assert.equal(child.parentSpanContext.spanId, root.spanContext.spanId);
    assert.equal(child.spanContext().traceId, root.spanContext.traceId);
    assert.equal(child.attributes['switchboard.run_id'], 'run-1');
    assert.equal(child.attributes['gen_ai.conversation.id'], 'conversation-1');
    assert.equal(child.status.code, SpanStatusCode.UNSET);
    assert(child.duration[0] >= 0 && child.duration[1] >= 0 && child.duration[1] < 1e9);
  }
  assert.equal(actual[0].kind, SpanKind.CLIENT);
  assert.equal(actual[0].attributes['gen_ai.request.model'], 'requested');
  assert.equal(actual[0].attributes['gen_ai.response.model'], 'actual');
  assert.equal(actual[0].attributes['gen_ai.usage.input_tokens'], 0);
  assert.equal(actual[1].attributes['gen_ai.usage.input_tokens'], undefined);
  assert.equal(actual[2].kind, SpanKind.INTERNAL);
  assert.equal(actual[2].attributes['gen_ai.usage.output_tokens'], undefined);
  assert.equal(actual[2].attributes['gen_ai.tool.call.id'], 'call-1');
  assert.equal(actual[0].instrumentationScope.name, instrumentationScope.name);
  assert.equal(actual[0].instrumentationScope.version, instrumentationScope.version);
});

test('observability terminal outcomes remain separate from backend error status', t => {
  const { observer, exporter } = host(t);
  const outcomes = [success, { kind: 'error', category: 'rate-limit' }, { kind: 'cancelled' }, { kind: 'outcome-unknown' }];
  for (const outcome of outcomes) {
    const handle = unwrap(observer.start(model, ROOT_CONTEXT));
    unwrap(handle.finish(outcome));
    unwrap(handle.finish({ kind: 'error', category: 'unknown-error' }));
    rejected(handle.update({ usage: { inputTokens: 99 } }), 'finished');
  }
  assert.equal(spans(exporter).length, 4);
  for (const [index, span] of spans(exporter).entries()) {
    assert.equal(span.attributes['switchboard.outcome'], outcomes[index].kind);
    assert.equal(span.status.code, index === 1 ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
    assert.equal(span.attributes['error.type'], index === 1 ? 'rate-limit' : undefined);
    assert.deepEqual(span.events, []);
  }
});

test('observability supplies private validated metadata to real SDK sampling and onStart', async t => {
  const sampled = [];
  const started = [];
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    sampler: {
      shouldSample(_parent, _traceId, _name, _kind, attributes) {
        sampled.push({ ...attributes });
        return { decision: attributes['gen_ai.operation.name'] === 'chat' &&
          attributes['gen_ai.provider.name'] === 'openai' && attributes['gen_ai.request.model'] === 'requested'
          ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
      },
      toString: () => 'ChatMetadataSampler',
    },
    spanProcessors: [{ onStart: span => started.push({ ...span.attributes }), onEnd() {},
      forceFlush: async () => {}, shutdown: async () => {} }, new SimpleSpanProcessor(exporter)],
  });
  const observer = observerWith(provider.getTracer('sampling'), { includeConversationId: true });
  t.after(async () => { observer.close(); await provider.shutdown(); });
  const correlation = { runId: 'run-1', requestId: 'request-1', conversationId: 'conversation-1' };
  unwrap(unwrap(observer.start({ ...model, inputMessages: input(canary) }, ROOT_CONTEXT, correlation)).finish(success));
  unwrap(unwrap(observer.start(agent, ROOT_CONTEXT, correlation)).finish(success));
  await provider.forceFlush();
  assert.deepEqual(sampled.map(attributes => attributes['gen_ai.operation.name']), ['chat', 'invoke_agent']);
  assert.equal(sampled[0]['gen_ai.provider.name'], 'openai');
  assert.equal(sampled[0]['gen_ai.request.model'], 'requested');
  assert.equal(sampled[0]['switchboard.run_id'], correlation.runId);
  assert.equal(sampled[0]['switchboard.request_id'], correlation.requestId);
  assert.equal(sampled[0]['gen_ai.conversation.id'], correlation.conversationId);
  assert.deepEqual(started, [sampled[0]]);
  assert.equal(spans(exporter).length, 1);
  assert.equal(spans(exporter)[0].attributes['gen_ai.operation.name'], 'chat');
  assert(!JSON.stringify({ sampled, started }).includes(canary));
  assert.equal(sampled[0]['gen_ai.input.messages'], undefined);
  assert(!serialized(exporter).includes(canary));
});

test('observability closes a real SDK span acquired after onStart revokes its reservation', async t => {
  const exporter = new InMemorySpanExporter();
  let observer;
  let ended = 0;
  const provider = new BasicTracerProvider({ spanProcessors: [{
    onStart: () => observer.close(), onEnd: () => { ended++; },
    forceFlush: async () => {}, shutdown: async () => {},
  }, new SimpleSpanProcessor(exporter)] });
  observer = observerWith(provider.getTracer('reentrant-close'));
  t.after(async () => { observer.close(); await provider.shutdown(); });
  rejected(observer.start(model, ROOT_CONTEXT, { runId: 'run-1' }), 'closed');
  observer.close();
  await provider.forceFlush();
  assert.equal(ended, 1);
  assert.equal(spans(exporter).length, 1);
  const [span] = spans(exporter);
  assert.equal(span.attributes['gen_ai.operation.name'], 'chat');
  assert.equal(span.attributes['gen_ai.provider.name'], 'openai');
  assert.equal(span.attributes['gen_ai.request.model'], 'requested');
  assert.equal(span.attributes['switchboard.run_id'], 'run-1');
  assert.equal(span.attributes['switchboard.outcome'], 'outcome-unknown');
  assert.equal(span.status.code, SpanStatusCode.UNSET);
  assert.equal(observer.diagnostics().started, 1);
  assert.equal(observer.diagnostics().finished, 1);
  assert.equal(observer.diagnostics().activeSpans, 0);
  assert.equal(observer.diagnostics().telemetryFailures, 0);
});

test('observability bounds and close release ownership without SDK shutdown', t => {
  const { observer, exporter, provider } = host(t, { bounds: { maxActiveSpans: 1 } });
  const first = unwrap(observer.start(agent, ROOT_CONTEXT));
  rejected(observer.start(agent, ROOT_CONTEXT), 'capacity');
  assert.equal(observer.diagnostics().activeSpans, 1);
  unwrap(first.finish(success));
  const second = unwrap(observer.start(model, ROOT_CONTEXT));
  observer.close(); observer.close();
  unwrap(second.finish(success));
  rejected(observer.start(agent, ROOT_CONTEXT), 'closed');
  assert.equal(observer.diagnostics().activeSpans, 0);
  assert.equal(observer.diagnostics().finished, 2);
  assert.equal(spans(exporter)[1].attributes['switchboard.outcome'], 'outcome-unknown');
  provider.getTracer('host-owned').startSpan('still available').end();
  assert.equal(spans(exporter).length, 3);
});

test('observability validates metadata and snapshots caller mutation without reading hostile objects', t => {
  const { observer, exporter } = host(t);
  let touched = 0;
  const proxy = new Proxy({}, { ownKeys() { touched++; throw new Error(canary); }, get() { touched++; throw new Error(canary); }, getPrototypeOf() { touched++; throw new Error(canary); } });
  const accessor = { ...model, get requestModel() { touched++; throw new Error(canary); } };
  const invalid = [proxy, accessor, { ...model, unknown: canary }, { ...model, [Symbol('secret')]: canary },
    { ...model, provider: '' }, { ...model, requestModel: 'x'.repeat(257) }, { ...model, provider: 'bad\nprovider' },
    { ...model, operation: { toString() { touched++; return 'chat'; } } },
    { ...agent, usage: { inputTokens: 1 } }, { kind: 'tool', name: 'unlisted' },
    { kind: 'tool', name: 'add', inputMessages: input(canary) }, { ...model, nativeHandle: canary }];
  for (const descriptor of invalid) rejected(observer.start(descriptor, ROOT_CONTEXT), 'invalid-input');
  rejected(observer.start(model, ROOT_CONTEXT, proxy), 'invalid-input');
  assert.equal(touched, 0);
  assert.equal(observer.diagnostics().activeSpans, 0);
  const operation = { ...model };
  const correlation = { runId: 'original', conversationId: canary };
  const handle = unwrap(observer.start(operation, ROOT_CONTEXT, correlation));
  operation.requestModel = canary; correlation.runId = canary;
  for (const usage of [{ inputTokens: -1 }, { outputTokens: 1.5 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 }, { outputTokens: NaN }, { cacheTokens: 3 }, proxy]) {
    rejected(handle.update({ usage }), 'invalid-input');
  }
  rejected(handle.finish({ kind: 'error', category: new Error(canary) }), 'invalid-input');
  rejected(handle.finish({ kind: 'error', category: 'provider-error', error: new Error(canary) }), 'invalid-input');
  rejected(handle.finish({ kind: 'cancelled', category: 'timeout' }), 'invalid-input');
  unwrap(handle.finish(success));
  assert.equal(spans(exporter)[0].attributes['switchboard.run_id'], 'original');
  assert.equal(spans(exporter)[0].attributes['gen_ai.conversation.id'], undefined);
  assert(!serialized(exporter).includes(canary));
});

test('observability none policy never traverses supplied content', t => {
  const { observer, exporter } = host(t);
  let touched = 0;
  const hostile = new Proxy({ secret: canary }, { get() { touched++; throw new Error(canary); }, ownKeys() { touched++; throw new Error(canary); } });
  const handle = unwrap(observer.start({ ...model, inputMessages: hostile }, ROOT_CONTEXT));
  unwrap(handle.update({ outputMessages: hostile }));
  unwrap(handle.finish(success));
  assert.equal(touched, 0);
  assert.equal(observer.diagnostics().contentDropped, 0);
  assert(!serialized(exporter).includes(canary));
  assert.equal(spans(exporter)[0].attributes['gen_ai.input.messages'], undefined);
  assert.equal(spans(exporter)[0].attributes['gen_ai.output.messages'], undefined);
});

test('observability sanitized text matches independently pinned upstream schemas', t => {
  const sanitizer = content => {
    assert(Object.isFrozen(content) && Object.isFrozen(content.messages));
    assert(Object.isFrozen(content.messages[0]) && Object.isFrozen(content.messages[0].parts[0]));
    return { kind: content.kind, messages: content.messages.map(message => ({ ...message,
      parts: message.parts.map(part => ({ ...part, content: part.content.replaceAll(canary, '[redacted]') })) })) };
  };
  const { observer, exporter } = host(t, { contentPolicy: { kind: 'sanitized', sanitize: sanitizer } });
  const messages = input(canary);
  const handle = unwrap(observer.start({ ...model, inputMessages: messages }, ROOT_CONTEXT));
  messages[0].parts[0].content = 'changed after start';
  unwrap(handle.update({ outputMessages: output(canary) }));
  unwrap(handle.finish(success));
  const attributes = spans(exporter)[0].attributes;
  const ajv = new Ajv2020({ strict: false });
  for (const direction of ['input', 'output']) {
    const schema = JSON.parse(readFileSync(new URL(`./fixtures/gen-ai-${direction}-messages.json`, import.meta.url), 'utf8'));
    const validate = ajv.compile(schema);
    const value = JSON.parse(attributes[`gen_ai.${direction}.messages`]);
    assert(validate(value), JSON.stringify(validate.errors));
    assert.equal(value[0].parts[0].content, '[redacted]');
  }
  assert(!serialized(exporter).includes(canary));
  assert.equal(observer.diagnostics().contentDropped, 0);
});

test('observability rejects unsupported content and sanitizer output with a bounded diagnostic', t => {
  let touched = 0;
  const proxy = new Proxy({}, { get() { touched++; throw new Error(canary); }, ownKeys() { touched++; throw new Error(canary); } });
  const invalid = [proxy, [{ role: 'user', content: canary }], [{ role: 'tool', parts: [] }],
    [{ role: 'user', parts: [{ type: 'image', content: canary }] }],
    [{ role: 'user', parts: [{ type: 'text', content: 'x'.repeat(17000) }] }],
    [{ role: 'user', parts: [{ type: 'text', content: 'ok', unknown: canary }] }],
    [{ role: 'user', get parts() { touched++; return []; } }]];
  const { observer, exporter } = host(t, { contentPolicy: { kind: 'sanitized', sanitize: value => value } });
  for (const inputMessages of invalid) unwrap(unwrap(observer.start({ ...model, inputMessages }, ROOT_CONTEXT)).finish(success));
  const noFinish = unwrap(observer.start(model, ROOT_CONTEXT));
  unwrap(noFinish.update({ outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: canary }] }] }));
  unwrap(noFinish.finish(success));
  assert.equal(touched, 0);
  assert.equal(observer.diagnostics().contentDropped, invalid.length + 1);
  assert(!serialized(exporter).includes(canary));
  for (const sanitize of [() => { throw new Error(canary); }, () => proxy, () => ({ kind: 'output', messages: output(canary) }),
    () => ({ kind: 'input', messages: input('x'.repeat(17000)) }), () => Promise.resolve({ kind: 'input', messages: input(canary) })]) {
    const isolated = host(t, { contentPolicy: { kind: 'sanitized', sanitize } });
    unwrap(unwrap(isolated.observer.start({ ...model, inputMessages: input(canary) }, ROOT_CONTEXT)).finish(success));
    assert.equal(isolated.observer.diagnostics().contentDropped, 1);
    assert(!serialized(isolated.exporter).includes(canary));
  }
});

test('observability content limit applies to UTF-8 input and output together', t => {
  const { observer, exporter } = host(t, { bounds: { maxContentBytes: 200 }, contentPolicy: { kind: 'sanitized', sanitize: value => value } });
  const handle = unwrap(observer.start({ ...model, inputMessages: input('é'.repeat(35)) }, ROOT_CONTEXT));
  unwrap(handle.update({ outputMessages: output('é'.repeat(35)) }));
  unwrap(handle.finish(success));
  const attributes = spans(exporter)[0].attributes;
  assert.equal(typeof attributes['gen_ai.input.messages'], 'string');
  assert.equal(attributes['gen_ai.output.messages'], undefined);
  assert.equal(observer.diagnostics().contentDropped, 1);
  assert(Buffer.byteLength(attributes['gen_ai.input.messages']) <= 200);
});

function faultTracer(hooks = {}) {
  const calls = { start: 0, end: 0, setters: 0, status: 0 };
  const span = {
    setAttributes() { calls.setters++; hooks.set?.(); return span; },
    setAttribute() { calls.setters++; hooks.set?.(); return span; },
    setStatus() { calls.status++; hooks.status?.(); return span; },
    spanContext() { hooks.context?.(); return { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }; },
    end() { calls.end++; hooks.end?.(); },
  };
  const tracer = { startSpan() { calls.start++; hooks.start?.(); return span; } };
  return { tracer, calls };
}
function observerWith(tracer, extra = {}) {
  return createGenAiObserver({ tracer, allowedToolNames: ['add'], contentPolicy: { kind: 'none' }, bounds: { maxActiveSpans: 1 }, ...extra });
}
const explode = () => { throw new Error(canary); };

test('observability isolates SDK creation and partial initialization faults', () => {
  for (const hooks of [{ start: explode }, { context: explode }, { context: explode, end: explode }]) {
    const { tracer, calls } = faultTracer(hooks);
    const observer = observerWith(tracer);
    for (let repeat = 0; repeat < 2; repeat++) {
      rejected(observer.start(model, ROOT_CONTEXT), 'telemetry-failure');
      assert.equal(observer.diagnostics().activeSpans, 0);
    }
    observer.close();
    assert.equal(calls.start, 2);
    assert.equal(calls.end, hooks.start ? 0 : 2);
    assert.equal(observer.diagnostics().telemetryFailures, 2);
  }
});

test('observability setter and end faults cannot retain capacity or escape finish and close', () => {
  for (const finishing of ['finish', 'close']) {
    const hooks = {};
    const { tracer, calls } = faultTracer(hooks);
    const observer = observerWith(tracer);
    const handle = unwrap(observer.start(model, ROOT_CONTEXT));
    hooks.set = explode; hooks.end = explode;
    rejected(handle.update({ usage: { inputTokens: 1 } }), 'telemetry-failure');
    if (finishing === 'finish') rejected(handle.finish({ kind: 'error', category: 'provider-error' }), 'telemetry-failure');
    else observer.close();
    unwrap(handle.finish(success)); observer.close();
    assert.equal(calls.end, 1);
    assert.equal(observer.diagnostics().activeSpans, 0);
    assert.equal(observer.diagnostics().telemetryFailures, 2);
  }
  const hooks = {};
  const { tracer, calls } = faultTracer(hooks);
  const observer = observerWith(tracer);
  const first = unwrap(observer.start(model, ROOT_CONTEXT));
  hooks.end = explode;
  rejected(first.finish(success), 'telemetry-failure');
  delete hooks.end;
  unwrap(unwrap(observer.start(model, ROOT_CONTEXT)).finish(success));
  assert.equal(calls.end, 2);
  assert.equal(observer.diagnostics().activeSpans, 0);
});

test('observability reserves capacity before sanitizers and revokes reentrant starts on close', () => {
  for (const closeAt of ['sanitize', 'start', 'context']) {
    const hooks = {};
    const { tracer, calls } = faultTracer(hooks);
    let observer;
    observer = observerWith(tracer, { contentPolicy: { kind: 'sanitized', sanitize: content => {
      rejected(observer.start(model, ROOT_CONTEXT), 'capacity');
      if (closeAt === 'sanitize') observer.close();
      return content;
    } } });
    if (closeAt !== 'sanitize') hooks[closeAt] = () => observer.close();
    rejected(observer.start({ ...model, inputMessages: input() }, ROOT_CONTEXT), 'closed');
    observer.close();
    assert.equal(calls.start, closeAt === 'sanitize' ? 0 : 1);
    assert.equal(calls.end, closeAt === 'sanitize' ? 0 : 1);
    assert.equal(observer.diagnostics().activeSpans, 0);
  }
});

test('observability releases acquisition-time close exactly once even when terminal setters or end throw', () => {
  for (const faults of [{ set: explode }, { end: explode }, { set: explode, end: explode }]) {
    let observer;
    const { tracer, calls } = faultTracer({ ...faults, start: () => observer.close() });
    observer = observerWith(tracer);
    rejected(observer.start(model, ROOT_CONTEXT), 'telemetry-failure');
    observer.close();
    assert.equal(calls.end, 1);
    assert.equal(calls.setters, 1);
    assert.equal(observer.diagnostics().started, 1);
    assert.equal(observer.diagnostics().finished, 1);
    assert.equal(observer.diagnostics().activeSpans, 0);
    assert.equal(observer.diagnostics().telemetryFailures, 1);
  }
});

test('observability latches finish before SDK reentrancy and rejects sanitizer updates after finish', () => {
  const hooks = {};
  const { tracer, calls } = faultTracer(hooks);
  const observer = observerWith(tracer);
  const handle = unwrap(observer.start(model, ROOT_CONTEXT));
  hooks.set = () => { unwrap(handle.finish(success)); observer.close(); };
  hooks.end = () => { unwrap(handle.finish(success)); observer.close(); };
  unwrap(handle.finish({ kind: 'error', category: 'provider-error' }));
  assert.equal(calls.end, 1);
  assert.equal(observer.diagnostics().activeSpans, 0);
  let updating;
  const second = observerWith(faultTracer().tracer, { contentPolicy: { kind: 'sanitized', sanitize: content => {
    if (updating) unwrap(updating.finish(success));
    return content;
  } } });
  updating = unwrap(second.start(model, ROOT_CONTEXT));
  rejected(updating.update({ outputMessages: output() }), 'finished');
  assert.equal(second.diagnostics().activeSpans, 0);
  second.close();
});

test('observability nonrecording tracers require no global registration', () => {
  const observer = observerWith(trace.getTracer('unregistered'));
  const handle = unwrap(observer.start(model, ROOT_CONTEXT));
  unwrap(handle.update({ usage: { outputTokens: 0 } }));
  unwrap(handle.finish(success));
  observer.close();
  assert.equal(observer.diagnostics().telemetryFailures, 0);
});

test('observability rejects invalid configuration before acquisition', () => {
  const { tracer, calls } = faultTracer();
  for (const value of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4']) {
    for (const key of ['maxActiveSpans', 'maxIdentifierLength', 'maxContentBytes']) {
      assert.throws(() => observerWith(tracer, { bounds: { [key]: value } }), { name: 'RangeError', message: 'Invalid observability bounds' });
    }
  }
  for (const extra of [{ contentPolicy: { kind: 'raw' } }, { contentPolicy: { kind: 'none', sanitize() {} } },
    { allowedToolNames: [''] }, { includeConversationId: 'yes' }, { bounds: { unknown: 1 } }, { extra: true }]) {
    assert.throws(() => observerWith(tracer, extra), { name: 'TypeError', message: 'Invalid observability configuration' });
  }
  assert.equal(calls.start, 0);
});

test('observability preserves trace state through safe explicit parent contexts', t => {
  const { observer, exporter } = host(t);
  const traceState = createTraceState('dd=s:1;t.dm:-0');
  const parent = trace.setSpanContext(ROOT_CONTEXT, { traceId: '3'.repeat(32), spanId: '4'.repeat(16), traceFlags: 1, traceState });
  const root = unwrap(observer.start(agent, parent));
  const child = unwrap(observer.start(model, root.context));
  unwrap(child.finish(success)); unwrap(root.finish(success));
  for (const span of spans(exporter)) {
    assert.equal(span.spanContext().traceState.serialize(), traceState.serialize());
    assert.equal(span.parentSpanContext.traceState.serialize(), traceState.serialize());
  }
  assert.equal(trace.getSpan(root.context).isRecording(), false);
});

test('observability contains rejected Promise sanitizer results without reading thenables', async t => {
  const { observer, exporter } = host(t, { contentPolicy: { kind: 'sanitized', sanitize: () => {
    const rejected = Promise.reject(new Error(canary));
    Object.defineProperty(rejected, 'then', { get() { throw new Error('Must use intrinsic Promise handler'); } });
    return rejected;
  } } });
  const handle = unwrap(observer.start({ ...model, inputMessages: input(canary) }, ROOT_CONTEXT));
  unwrap(handle.update({ outputMessages: output(canary) }));
  unwrap(handle.finish(success));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.diagnostics().contentDropped, 2);
  assert(!serialized(exporter).includes(canary));
  const thenable = host(t, { contentPolicy: { kind: 'sanitized', sanitize: () => ({
    get then() { throw new Error('Must not inspect arbitrary thenables'); },
  }) } });
  unwrap(unwrap(thenable.observer.start({ ...model, inputMessages: input() }, ROOT_CONTEXT)).finish(success));
  assert.equal(thenable.observer.diagnostics().contentDropped, 1);
});

test('observability admits an observed tool name only when the host opts in, and never records tool payloads', t => {
  const closed = host(t);
  assert.equal(closed.observer.start({ kind: 'tool', name: 'read_file', callId: 'call-1' }, ROOT_CONTEXT).kind, 'error');
  const open = host(t, { admitObservedToolNames: true, allowedToolNames: [] });
  unwrap(unwrap(open.observer.start({ kind: 'tool', name: 'read_file', callId: 'call-1' }, ROOT_CONTEXT)).finish(success));
  rejected(open.observer.start({ kind: 'tool', name: 'bad\nname' }, ROOT_CONTEXT), 'invalid-input');
  rejected(open.observer.start({ kind: 'tool', name: 'read_file', arguments: '{}' }, ROOT_CONTEXT), 'invalid-input');
  const [span] = spans(open.exporter);
  assert.equal(span.name, 'execute_tool read_file');
  assert.equal(span.attributes['gen_ai.tool.name'], 'read_file');
  assert.equal(span.attributes['gen_ai.tool.call.id'], 'call-1');
  assert(!Object.keys(span.attributes).some(key => /argument|result/u.test(key)), JSON.stringify(span.attributes));
  const { tracer } = faultTracer();
  assert.throws(() => observerWith(tracer, { admitObservedToolNames: 'yes' }), { name: 'TypeError', message: 'Invalid observability configuration' });
});
