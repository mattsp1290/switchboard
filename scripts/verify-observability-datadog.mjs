import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fixtureCanaries, fixtureScenarios } from './support/observability-fixture.mjs';
import { assertPrivacy, command, currentProducerIdentity, delay, evidenceFor, expectedSpanCount, installedFixture, jsonCommand, matchesOtelId, safeFailure, validateBackendTraceTrees, validateFixtureHandoff, validateFixtureOrigin, writeReport } from './support/observability-backends.mjs';

const report = { lane: 'datadog', status: 'failed', startedAt: new Date().toISOString(), endpoint: 'http://127.0.0.1:14318/v1/traces', site: 'us3.datadoghq.com', scenarios: [], cleanup: 'shared agent preserved' };
const pup = process.env.PUP_BIN ?? 'pup';
const pupEnvironment = { ...process.env, DD_SITE: 'us3.datadoghq.com' };
delete pupEnvironment.PUP_NO_ENVELOPE;
const pupOptions = { env: pupEnvironment, timeout: 30_000 };
async function readPup(args) {
  const envelope = await jsonCommand(pup, ['llm-obs', 'spans', ...args, '--output=json'], pupOptions);
  assert.equal(envelope.status, 'success', 'Pup LLM query failed');
  assert(envelope.data && typeof envelope.data === 'object' && envelope.metadata && typeof envelope.metadata === 'object', 'unsupported Pup response envelope');
  return envelope.data;
}
async function search(scenario) {
  const spans = [];
  let cursor;
  const seen = new Set();
  do {
    const args = ['search', `--ml-app=${scenario.service}`, '--limit=100', `--from=${new Date(Date.parse(scenario.startedAt) - 1000).toISOString()}`, `--to=${new Date(Date.parse(scenario.endedAt) + 1000).toISOString()}`];
    if (cursor) args.push(`--cursor=${cursor}`);
    const data = await readPup(args);
    assert(Array.isArray(data.spans), 'unsupported Pup search response; spans array absent');
    spans.push(...data.spans);
    cursor = data.next_cursor ?? data.cursor ?? undefined;
    if (cursor) {
      assert(typeof cursor === 'string' && !seen.has(cursor), 'Pup pagination cursor repeated or malformed');
      seen.add(cursor);
      assert(seen.size < 10, 'Pup pagination exceeded fixture bound');
    }
  } while (cursor);
  return spans;
}

function usageFor(span) {
  return span.llm_info ?? {};
}
function modelFor(span) {
  return { provider: span.meta?.model_provider ?? span.llm_info?.model_provider ?? span.llm_info?.provider,
    model: span.meta?.model_name ?? span.llm_info?.model_name };
}
function schemaShape(value, prefix = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return [];
  return Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...schemaShape(child, `${prefix}${key}.`, depth + 1)]).slice(0, 120);
}
async function validate(scenario, indexed, privacy) {
  assert.equal(indexed.length, expectedSpanCount(scenario), `${scenario.id} exact LLM product count`);
  const detailed = [];
  const groups = Map.groupBy(indexed, (span) => span.trace_id);
  for (const [traceId, spans] of groups) {
    assert.equal(typeof traceId, 'string', 'backend trace IDs must remain lossless strings');
    for (const span of spans) assert.equal(typeof span.span_id, 'string', 'backend span IDs must remain lossless strings');
    const data = await readPup(['get-details', `--trace-id=${traceId}`, `--span-ids=${spans.map((span) => span.span_id).join(',')}`, `--from=${scenario.startedAt}`, '--to=now']);
    assert(Array.isArray(data.spans), 'unsupported Pup details response; spans absent');
    detailed.push(...data.spans.map((span) => ({ ...spans.find((candidate) => candidate.span_id === span.span_id), ...span, trace_id: span.trace_id ?? traceId })));
  }
  assert.equal(detailed.length, indexed.length, 'Pup detail span count');
  const bySpan = new Map();
  for (const span of detailed) {
    const matches = scenario.spans.filter((expected) => matchesOtelId(span.span_id, expected.spanId));
    assert.equal(matches.length, 1, 'backend ID must match exactly one original OTel span');
    assert(!bySpan.has(matches[0].spanId), 'backend span IDs must form a unique bijection');
    bySpan.set(matches[0].spanId, span);
  }
  const associations = [];
  const fullContent = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const expected of scenario.spans) {
    const span = bySpan.get(expected.spanId.toLowerCase());
    assert(span, `${scenario.id} missing original OTel span association`);
    const storedContent = {};
    for (const field of ['input', 'output', 'metadata']) {
      storedContent[field] = await readPup(['get-content', `--trace-id=${span.trace_id}`, `--span-id=${span.span_id}`, `--field=${field}`, '--max-tokens=4096', `--from=${scenario.startedAt}`, '--to=now']);
    }
    for (const [field, value] of Object.entries(storedContent)) {
      assert.equal(value.field, field, 'full-content response field');
      assert.equal(value.span_id, span.span_id, 'full-content response span identity');
      assert.equal(value.is_truncated, false, 'fixture content must not be truncated');
      assert(Object.hasOwn(value, 'content'), 'full-content payload absent');
    }
    assertPrivacy(storedContent, privacy, scenario.contentPolicy);
    fullContent.push(storedContent);
    const metadata = storedContent.metadata.content?.switchboard;
    if (!metadata) report.lastSchema = schemaShape(span);
    assert(metadata, 'Datadog custom switchboard metadata absent');
    assert.equal(metadata.run_id, scenario.runId, 'run correlation survives conversion');
    assert.equal(metadata.request_id, expected.requestId, 'request correlation survives conversion');
    assert.equal(metadata.outcome, expected.outcome, 'terminal observation survives conversion');
    const agent = scenario.spans.find((candidate) => candidate.kind === 'agent' && candidate.spanId === (expected.parentSpanId ?? expected.spanId));
    const invocationIndex = agent.requestId.split('-').at(-1);
    assert.equal(span.session_id, `${scenario.runId}-conversation-${invocationIndex}`, 'conversation correlation survives conversion');
    assert.equal(span.span_kind ?? span.meta?.span?.kind, { agent: 'agent', model: 'llm', tool: 'tool' }[expected.kind]);
    assert((span.duration_ms ?? span.duration ?? span.duration_ns) > 0, 'positive backend duration');
    if (expected.parentSpanId) {
      const matches = scenario.roots.filter((root) => matchesOtelId(span.parent_id, root.spanId));
      assert.equal(matches.length, 1, 'backend parent must match one original root');
      assert.equal(matches[0].spanId, expected.parentSpanId, 'backend parent association');
    }
    else assert(!span.parent_id || ['0', 'undefined'].includes(span.parent_id), 'agent remains root');
    const isError = span.status === 'error' || span.error === 1 || span.error === true;
    assert.equal(isError, expected.outcome === 'error', 'confirmed error differs from unknown/cancelled');
    if (expected.kind === 'model') {
      const model = modelFor(span);
      assert.equal(model.provider, 'openai', 'provider metadata');
      assert.equal(model.model, 'switchboard-fixture', 'model metadata');
      const usage = usageFor(span);
      for (const [field, expectedField] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']]) {
        const count = usage[field];
        if (expected.usage?.[expectedField] === undefined) assert(count === undefined || count === null, 'missing usage must remain absent');
        else {
          assert.equal(count, expected.usage[expectedField], 'per-request backend usage');
          assert.equal(span.metrics?.[field], count, 'detailed normalized usage agrees with reported usage');
        }
      }
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
    }
    assertPrivacy(span, privacy, scenario.contentPolicy);

    associations.push({ otelTraceId: expected.traceId, otelSpanId: expected.spanId, backendTraceId: span.trace_id, backendSpanId: span.span_id, kind: expected.kind, outcome: metadata.outcome });
  }
  validateBackendTraceTrees(scenario, associations);
  assert.equal(inputTokens, scenario.expected.inputTokens ?? 0);
  assert.equal(outputTokens, scenario.expected.outputTokens ?? 0);
  if (scenario.contentPolicy === 'sanitized') {
    for (const approved of privacy.content) assert(JSON.stringify(fullContent).includes(approved), 'approved sanitized content absent from stored Datadog details');
  }
  return { ...evidenceFor(scenario), associations, observedCount: detailed.length, modelUsage: { calls: scenario.expected.modelCount, inputTokens, outputTokens, missingUsage: scenario.expected.inputTokens === undefined ? scenario.expected.modelCount : 0 } };
}
try {
  report.pupVersion = await command(pup, ['--version'], pupOptions);
  await command(pup, ['llm-obs', 'spans', 'get-details', '--help'], pupOptions);
  report.agentVersion = (await command('datadog-agent', ['version'])).split('\n')[0];
  for (const unit of ['datadog-agent.service', 'datadog-agent-trace.service']) assert.equal(await command('systemctl', ['is-active', unit]), 'active', `${unit} must be active`);
  const listener = await command('ss', ['-ltnH', '( sport = :14318 )']);
  assert(listener && listener.split('\n').every((line) => /127\.0\.0\.1:14318|\[::1\]:14318/.test(line)), 'Datadog OTLP receiver must listen only on loopback');
  const response = await fetch(report.endpoint, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: new Uint8Array(), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, 'Datadog OTLP protocol preflight');
  await readPup(['search', '--ml-app=switchboard', '--from=1h', '--limit=1']);
  const destinations = [{ kind: 'datadog', url: report.endpoint }];
  if (process.env.LOTEL_ENDPOINT) destinations.push({ kind: 'lotel', url: process.env.LOTEL_ENDPOINT });
  const fixture = process.env.OBSERVABILITY_FIXTURE_REPORT
    ? JSON.parse(await readFile(process.env.OBSERVABILITY_FIXTURE_REPORT, 'utf8'))
    : await installedFixture(destinations);
  if (process.env.OBSERVABILITY_FIXTURE_REPORT) {
    const origin = JSON.parse(await readFile(join(dirname(resolve(process.env.OBSERVABILITY_FIXTURE_REPORT)), 'lotel.json'), 'utf8'));
    validateFixtureHandoff(fixture, fixtureScenarios);
    validateFixtureOrigin(fixture, origin, await currentProducerIdentity());
    assert.equal(fixture.rawPrivacy, 'passed', 'fixture handoff must include raw export privacy proof');
    assert(fixture.destinations?.some((destination) => destination.kind === 'datadog' && destination.url === report.endpoint), 'fixture handoff must prove export to the local Datadog receiver');
    fixture.privacy = { secrets: [fixtureCanaries.secretInput, fixtureCanaries.secretOutput], content: [fixtureCanaries.approvedInput, fixtureCanaries.approvedOutput] };
    report.fixtureReport = process.env.OBSERVABILITY_FIXTURE_REPORT;
  }
  report.tarballSha256 = fixture.tarballSha256;
  report.producerDigest = fixture.producerDigest;
  report.sdk = fixture.sdk;
  report.rawPrivacy = 'passed';
  report.usageEvidence = 'llm_info token fields; detailed metrics normalize absent usage to zero and are not usage observations';
  report.pending = fixture.scenarios.map(evidenceFor);
  await writeReport('datadog', report);
  const pending = new Map(fixture.scenarios.map((scenario) => [scenario.service, scenario]));
  const deadline = Date.now() + 10 * 60_000;
  const counts = new Map();
  while (pending.size) {
    for (const [service, scenario] of pending) {
      const spans = await search(scenario);
      counts.set(scenario.id, spans.length);
      assert(spans.length <= expectedSpanCount(scenario), 'unexpected extra current-run LLM spans');
      if (spans.length < expectedSpanCount(scenario)) continue;
      report.scenarios.push(await validate(scenario, spans, fixture.privacy));
      pending.delete(service);
      report.pending = [...pending.values()].map(evidenceFor);
      await writeReport('datadog', report);
    }
    report.indexingCounts = Object.fromEntries(counts);
    await writeReport('datadog', report);
    if (!pending.size) break;
    if (Date.now() >= deadline) throw new Error(`Datadog LLM indexing timeout after 10 minutes; observed ${JSON.stringify(Object.fromEntries(counts))}`);
    await delay(10_000);
  }
  validateBackendTraceTrees({ spans: fixture.scenarios.flatMap((scenario) => scenario.spans) }, report.scenarios.flatMap((scenario) => scenario.associations));
  delete report.pending;
  delete report.lastSchema;
  report.status = 'passed';
} catch (error) { report.failure = safeFailure(error); process.exitCode = 1; }
finally {
  report.endedAt = new Date().toISOString();
  const path = await writeReport('datadog', report);
  console.log(`Datadog ${report.status}. ${report.failure ?? ''} Report ${path}`);
}
