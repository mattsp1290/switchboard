import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createGenAiObserver, instrumentationScope } from '@mattsp1290/switchboard/observability';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AlwaysOnSampler, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { createDatadogExporter } from './datadog-exporter.mjs';
import { fixtureBatchOptions, fixtureCanaries, fixtureContentPolicy, fixtureScenarios, runFixtureScenario, withHostDeadline } from './observability-fixture.mjs';

const [destinationsJson, outputPath] = process.argv.slice(2);
const destinations = JSON.parse(destinationsJson);
const privacy = { secrets: [fixtureCanaries.secretInput, fixtureCanaries.secretOutput], content: [fixtureCanaries.approvedInput, fixtureCanaries.approvedOutput] };
const scenarios = [];
for (const scenario of fixtureScenarios) {
  const service = `switchboard-observability-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const raw = [];
  const failures = [];
  const processors = destinations.map(({ kind, url }, index) => {
    let downstream = new OTLPTraceExporter({ url, timeoutMillis: 5000 });
    if (kind === 'datadog') downstream = createDatadogExporter(downstream);
    const exporter = {
      export(spans, callback) {
        try {
          for (const span of spans) {
            const view = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
              parentSpanId: span.parentSpanContext?.spanId, name: span.name, attributes: span.attributes,
              events: span.events, links: span.links, status: span.status, duration: span.duration,
              startTime: span.startTime, endTime: span.endTime, resource: span.resource.attributes, instrumentationScope: span.instrumentationScope };
            assert.equal(span.instrumentationScope.name, instrumentationScope.name);
            assert.equal(span.instrumentationScope.version, instrumentationScope.version);
            const serialized = JSON.stringify(view);
            for (const canary of privacy.secrets) assert(!serialized.includes(canary), 'raw exported span contains secret canary');
            if (scenario.contentPolicy === 'none') {
              for (const content of privacy.content) assert(!serialized.includes(content), 'default policy contains content');
              assert(!Object.keys(span.attributes).some((key) => /^gen_ai\.(input\.messages|output\.messages|system_instructions|tool\.(definitions|call\.(arguments|result)))$/.test(key)), 'default policy contains content attributes');
            }
            assert.equal(span.events.length, 0, 'fixture must not export content through events');
            if (index === 0) raw.push(view);
          }
        } catch (error) { failures.push(error.message); callback({ code: 1, error }); return; }
        downstream.export(spans, (result) => {
          if (result.code !== 0) failures.push(`${kind} exporter failed`);
          callback(result);
        });
      },
      forceFlush: () => downstream.forceFlush?.(),
      shutdown: () => downstream.shutdown(),
    };
    return new BatchSpanProcessor(exporter, fixtureBatchOptions);
  });
  const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), resource: resourceFromAttributes({
    'service.name': service, 'service.version': '0.0.0', 'deployment.environment.name': 'qualification', dd_llmobs_enabled: true,
  }), spanProcessors: processors });
  const observer = createGenAiObserver({ tracer: provider.getTracer(instrumentationScope.name, instrumentationScope.version),
    contentPolicy: fixtureContentPolicy(scenario), allowedToolNames: ['fixture-add'], includeConversationId: true });
  let result;
  try {
    result = await runFixtureScenario({ scenario, observer });
  } finally {
    observer.close();
    try { await withHostDeadline(() => provider.forceFlush(), 'provider flush'); }
    finally { await withHostDeadline(() => provider.shutdown(), 'provider shutdown'); }
  }
  assert.deepEqual(failures, [], 'backend export failed');
  assert.equal(result.requests, scenario.expected.modelCount, 'actual HTTP request count');
  assert.equal(result.toolExecutions, scenario.expected.toolCount, 'actual tool execution count');
  assert.equal(raw.length, scenario.expected.agentCount + scenario.expected.modelCount + scenario.expected.toolCount, 'raw span count');
  if (scenario.contentPolicy === 'sanitized') {
    const serialized = JSON.stringify(raw);
    for (const approved of privacy.content) assert(serialized.includes(approved), 'approved sanitized content absent from raw spans');
  }
  scenarios.push({ ...result, id: scenario.id, contentPolicy: scenario.contentPolicy, expected: scenario.expected, service, raw });
}
await writeFile(outputPath, JSON.stringify({ scenarios, privacy, sdk: { api: '1.9.0', sdk: '2.12.0', exporter: '0.223.0' } }));
