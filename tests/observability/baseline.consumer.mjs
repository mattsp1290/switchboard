import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createRunBaseline } from '@mattsp1290/switchboard/baseline';
import { jsonString } from '@mattsp1290/switchboard';

test('installed baseline maps one observed turn into AG-UI events and payload-free spans', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const created = createRunBaseline({
    projection: { threadId: 'thread', runId: 'run', sourceKey: 'installed',
      bounds: { maxEntities: 64, maxPayloadBytes: 65536, maxJsonDepth: 16, maxJsonNodes: 1024 } },
    tracer: provider.getTracer('installed-baseline'), parentContext: ROOT_CONTEXT, contentPolicy: { kind: 'none' },
    allowedToolNames: [], admitObservedToolNames: true, provider: 'fixture', runId: 'run',
  });
  assert.equal(created.kind, 'ok');
  const baseline = created.value;
  const events = [];
  for (const observation of [
    { kind: 'run-started' },
    { kind: 'text', messageId: 'm', mode: 'delta', text: 'pong' },
    { kind: 'tool', callId: 'c', name: 'read', phase: 'completed', argumentsJson: jsonString({ path: 'canary-args' }), resultJson: jsonString('canary-result') },
    { kind: 'model-boundary', requestModel: 'model', usage: { inputTokens: 1, outputTokens: 1 } },
    { kind: 'terminal', outcome: 'success' },
  ]) {
    const result = baseline.accept(Object.freeze(observation));
    assert.equal(result.projection.kind, 'mapped', JSON.stringify(result));
    events.push(...result.projection.events);
  }
  const report = baseline.close();
  assert.equal(report.error, undefined);
  assert.equal(events[0].type, 'RUN_STARTED');
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
  assert(events.some(event => event.type === 'TOOL_CALL_RESULT' && event.content === '"canary-result"'));
  assert(report.families.every(row => row.qualification === 'unqualified'));
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.deepEqual(spans.map(span => span.attributes['gen_ai.operation.name']).sort(), ['chat', 'execute_tool', 'invoke_agent']);
  assert(!JSON.stringify(spans.map(span => span.attributes)).includes('canary'));
  await provider.shutdown();
});
