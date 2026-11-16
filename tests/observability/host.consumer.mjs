import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AlwaysOnSampler, BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { createGenAiObserver } from '@mattsp1290/switchboard/observability';
import { createDatadogExporter, datadogSpanView } from '../../support/datadog-exporter.mjs';
import { fixtureBatchOptions, fixtureCanaries, fixtureContentPolicy, fixtureScenarios,
  runFixtureScenario, withHostDeadline } from '../../support/observability-fixture.mjs';

function host(scenario, processors) {
  const memory = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(),
    resource: resourceFromAttributes({ 'service.name': `switchboard-host-${scenario.id}-${crypto.randomUUID()}` }),
    spanProcessors: processors ?? [new SimpleSpanProcessor(memory)] });
  const observer = createGenAiObserver({ tracer: provider.getTracer('@mattsp1290/switchboard', '0.0.0'),
    contentPolicy: fixtureContentPolicy(scenario), allowedToolNames: ['fixture-add'], includeConversationId: true });
  return { observer, provider, memory };
}

async function close(host) {
  host.observer.close();
  try { await withHostDeadline(() => host.provider.forceFlush(), 'provider forceFlush'); }
  finally { await withHostDeadline(() => host.provider.shutdown(), 'provider shutdown'); }
}

function assertScenario(report, spans, scenario) {
  assert.equal(report.requests, scenario.expected.modelCount, 'HTTP provider counts actual requests');
  assert.equal(report.toolExecutions, scenario.expected.toolCount, 'Tool count measures local executions');
  assert.equal(report.outcome, scenario.expected.outcome);
  assert.equal(spans.length, scenario.expected.agentCount + scenario.expected.modelCount + scenario.expected.toolCount);
  assert.equal(report.roots.length, scenario.expected.agentCount);
  assert.equal(new Set(report.roots.map((root) => root.traceId)).size, scenario.expected.agentCount);
  const modelSpans = spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
  assert.equal(modelSpans.length, scenario.expected.modelCount);
  assert.equal(spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'execute_tool').length, scenario.expected.toolCount);
  assert.equal(spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent').length, scenario.expected.agentCount);
  for (const span of spans) {
    const identity = span.spanContext();
    const observed = report.spans.find((entry) => entry.spanId === identity.spanId);
    assert(observed, 'Export identity matches the operation handle');
    assert.equal(identity.traceId, observed.traceId);
    assert.equal(span.parentSpanContext?.spanId, observed.parentSpanId, 'Every child has its explicit agent parent');
    assert.equal(span.attributes['switchboard.outcome'], observed.outcome);
    assert.equal(span.attributes['switchboard.run_id'], report.runId);
    assert.equal(span.attributes['switchboard.request_id'], observed.requestId);
    assert.equal(span.status.code, scenario.expected.outcome === 'error' ? 2 : 0);
    assert(span.duration[0] > 0 || span.duration[1] > 0, 'Observed operation has positive duration');
    assert.equal(span.attributes['error.type'], scenario.expected.outcome === 'error' ? 'provider-error' : undefined);
    if (observed.kind !== 'agent') {
      const root = report.roots.find((candidate) => candidate.spanId === observed.parentSpanId);
      assert(root, 'Parent is one of this invocation set\'s roots');
      assert.equal(root.traceId, identity.traceId);
    }
    if (observed.kind !== 'model') {
      assert.equal(span.attributes['gen_ai.usage.input_tokens'], undefined);
      assert.equal(span.attributes['gen_ai.usage.output_tokens'], undefined);
    }
    assert.equal(span.events.length, 0);
  }
  for (const span of modelSpans) {
    assert.equal(span.attributes['gen_ai.provider.name'], 'openai');
    assert.equal(span.attributes['gen_ai.request.model'], 'switchboard-fixture');
    assert.equal(span.attributes['gen_ai.response.model'], scenario.expected.outcome === 'success' ? 'switchboard-fixture' : undefined);
    const observed = report.spans.find((entry) => entry.spanId === span.spanContext().spanId);
    assert.equal(span.attributes['gen_ai.usage.input_tokens'], observed.usage?.inputTokens);
    assert.equal(span.attributes['gen_ai.usage.output_tokens'], observed.usage?.outputTokens);
  }
  for (const [field, expected] of [['input_tokens', scenario.expected.inputTokens], ['output_tokens', scenario.expected.outputTokens]]) {
    const values = modelSpans.map((span) => span.attributes[`gen_ai.usage.${field}`]);
    if (expected === undefined) assert(values.every((value) => value === undefined), 'Unknown usage stays absent');
    else assert.equal(values.reduce((sum, value) => sum + value, 0), expected);
  }
  const serialized = JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })));
  assert(!serialized.includes(fixtureCanaries.secretInput));
  assert(!serialized.includes(fixtureCanaries.secretOutput));
  assert(!JSON.stringify(report).includes(fixtureCanaries.secretInput));
  assert(!JSON.stringify(report).includes(fixtureCanaries.secretOutput));
  for (const span of modelSpans) {
    if (scenario.contentPolicy === 'sanitized') {
      const input = JSON.parse(span.attributes['gen_ai.input.messages']);
      const output = JSON.parse(span.attributes['gen_ai.output.messages']);
      assert.equal(input[0].parts[0].content, fixtureCanaries.approvedInput);
      assert.equal(output[0].parts[0].content, fixtureCanaries.approvedOutput);
      assert.equal(output[0].finish_reason, 'stop');
    } else {
      assert.equal(span.attributes['gen_ai.input.messages'], undefined);
      assert.equal(span.attributes['gen_ai.output.messages'], undefined);
    }
  }
}

for (const scenario of fixtureScenarios) {
  test(`real HTTP host records ${scenario.id}`, async () => {
    const owner = host(scenario);
    try {
      const report = await runFixtureScenario({ scenario, observer: owner.observer });
      owner.observer.close();
      await withHostDeadline(() => owner.provider.forceFlush(), 'scenario flush');
      assertScenario(report, owner.memory.getFinishedSpans(), scenario);
    } finally { await close(owner); }
  });
}

for (const scenario of fixtureScenarios) {
  test(`HTTP calls and ${scenario.id} outcome survive disabled telemetry and a throwing exporter`, async () => {
    const enabled = host(scenario);
    const disabled = host(scenario);
    let attempts = 0;
    const failing = host(scenario, [new BatchSpanProcessor({
      export() { attempts += 1; throw new Error('synthetic-export-failure'); },
      shutdown() { return Promise.resolve(); },
    }, fixtureBatchOptions)]);
    try {
      const reports = [];
      reports.push(await runFixtureScenario({ scenario, observer: enabled.observer }));
      reports.push(await runFixtureScenario({ scenario, observer: disabled.observer, enabled: false }));
      reports.push(await runFixtureScenario({ scenario, observer: failing.observer }));
      failing.observer.close();
      await assert.rejects(withHostDeadline(() => failing.provider.forceFlush(), 'failing exporter flush'));
      assert(attempts > 0);
      const businessResult = ({ requests, toolExecutions, result, outcome }) => ({ requests, toolExecutions, result, outcome });
      assert.deepEqual(businessResult(reports[1]), businessResult(reports[0]));
      assert.deepEqual(businessResult(reports[2]), businessResult(reports[0]));
      assert.equal(reports[0].requests, scenario.expected.modelCount);
      assert.equal(reports[0].outcome, scenario.expected.outcome);
      assert.equal(disabled.memory.getFinishedSpans().length, 0);
    } finally {
      await Promise.all([close(enabled), close(disabled), close(failing).catch(() => {})]);
    }
  });
}

test('Datadog copy preserves the readable span while adding only validated metadata', async () => {
  const scenario = fixtureScenarios[0];
  const owner = host(scenario);
  try {
    await runFixtureScenario({ scenario, observer: owner.observer });
    const original = owner.memory.getFinishedSpans()[0];
    const copy = datadogSpanView(original);
    assert.notEqual(copy, original);
    assert.notEqual(copy.attributes, original.attributes);
    assert.deepEqual(copy.spanContext(), original.spanContext());
    for (const field of ['name', 'kind', 'parentSpanContext', 'startTime', 'endTime', 'duration', 'status', 'events',
      'links', 'resource', 'instrumentationScope', 'ended', 'droppedAttributesCount', 'droppedEventsCount', 'droppedLinksCount']) {
      assert.deepEqual(copy[field], original[field], field);
    }
    assert.equal(original.attributes['_dd.ml_obs.metadata'], undefined);
    const metadata = JSON.parse(copy.attributes['_dd.ml_obs.metadata']);
    assert.deepEqual(metadata, { switchboard: { outcome: original.attributes['switchboard.outcome'],
      run_id: original.attributes['switchboard.run_id'], request_id: original.attributes['switchboard.request_id'] } });
    const copied = { ...copy.attributes };
    delete copied['_dd.ml_obs.metadata'];
    assert.deepEqual(copied, original.attributes);
    copy.status.code = 2;
    copy.startTime[0] = 0;
    copy.attributes['gen_ai.request.model'] = 'changed-copy';
    assert.notEqual(copy.startTime[0], original.startTime[0]);
    assert.notEqual(copy.attributes['gen_ai.request.model'], original.attributes['gen_ai.request.model']);
    const invalid = { ...datadogSpanView(original), attributes: {
      'switchboard.outcome': 'unrecognized', 'switchboard.run_id': 'unsafe\nvalue', 'switchboard.request_id': 'x'.repeat(257),
    } };
    assert.equal(datadogSpanView(invalid).attributes['_dd.ml_obs.metadata'], undefined);
    const publicIds = { ...datadogSpanView(original), attributes: {
      'switchboard.run_id': 'public run α', 'switchboard.request_id': 'request 1',
    } };
    assert.deepEqual(JSON.parse(datadogSpanView(publicIds).attributes['_dd.ml_obs.metadata']), {
      switchboard: { run_id: 'public run α', request_id: 'request 1' },
    });
  } finally { await close(owner); }
});

test('Datadog decorator preserves callback, flush, and shutdown contracts', async () => {
  let callbackResult;
  let flushes = 0;
  let shutdowns = 0;
  const result = { code: 0 };
  const exporter = createDatadogExporter({
    export(spans, callback) { assert.deepEqual(spans, []); callback(result); },
    forceFlush() { flushes += 1; return Promise.resolve(); },
    shutdown() { shutdowns += 1; return Promise.resolve(); },
  });
  exporter.export([], (value) => { callbackResult = value; });
  assert.equal(callbackResult, result);
  await exporter.forceFlush();
  await exporter.shutdown();
  assert.equal(flushes, 1);
  assert.equal(shutdowns, 1);
  let callbacks = 0;
  createDatadogExporter({ export() { throw new Error('synthetic failure'); }, shutdown() {} })
    .export([], (value) => { callbacks += 1; assert.equal(value.code, 1); });
  assert.equal(callbacks, 1);
});

test('real OTLP fanout delivers to the healthy endpoint when another endpoint refuses connections', async () => {
  let received = 0;
  let bytes = 0;
  const collector = createServer((request, response) => {
    received += 1;
    assert.equal(request.url, '/v1/traces');
    assert.equal(request.headers['content-type'], 'application/x-protobuf');
    request.on('data', (chunk) => { bytes += chunk.length; });
    request.on('end', () => { response.writeHead(200, { 'content-type': 'application/x-protobuf' }); response.end(); });
  });
  await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const refused = createServer();
  await new Promise((resolve) => refused.listen(0, '127.0.0.1', resolve));
  const refusedPort = refused.address().port;
  await new Promise((resolve) => refused.close(resolve));
  const goodMemory = new InMemorySpanExporter();
  const healthy = new OTLPTraceExporter({ url: `http://127.0.0.1:${collector.address().port}/v1/traces`, timeoutMillis: 1000 });
  const unhealthy = createDatadogExporter(new OTLPTraceExporter({ url: `http://127.0.0.1:${refusedPort}/v1/traces`, timeoutMillis: 1000 }));
  const owner = host(fixtureScenarios[0], [new BatchSpanProcessor(healthy, fixtureBatchOptions),
    new BatchSpanProcessor(unhealthy, fixtureBatchOptions), new SimpleSpanProcessor(goodMemory)]);
  try {
    const report = await runFixtureScenario({ scenario: fixtureScenarios[0], observer: owner.observer });
    owner.observer.close();
    await assert.rejects(withHostDeadline(() => owner.provider.forceFlush(), 'fanout flush'));
    assert(received > 0, 'Healthy exporter received HTTP OTLP even while the other destination failed');
    assert(bytes > 0, 'Collector received a nonempty protobuf payload');
    assert.equal(report.requests, 2, 'Export failure did not retry model calls');
    assert.equal(goodMemory.getFinishedSpans().length, 4);
    assert(goodMemory.getFinishedSpans().every((span) => span.attributes['_dd.ml_obs.metadata'] === undefined));
  } finally {
    await close(owner).catch(() => {});
    collector.closeAllConnections();
    await new Promise((resolve) => collector.close(resolve));
  }
});

test('host owns provider lifecycle independently from the borrowed observer', async () => {
  const owner = host(fixtureScenarios[0]);
  try {
    owner.observer.close();
    const unrelated = owner.provider.getTracer('host').startSpan('host-still-open', {}, ROOT_CONTEXT);
    unrelated.end();
    await owner.provider.forceFlush();
    assert.equal(owner.memory.getFinishedSpans().length, 1);
    assert.equal(owner.memory.getFinishedSpans()[0].name, 'host-still-open');
  } finally { await close(owner); }
});
