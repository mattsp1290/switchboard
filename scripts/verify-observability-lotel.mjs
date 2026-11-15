import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactSourceDigest, assertPrivacy, collectorImage, command, delay, evidenceFor, expectedSpanCount, installedFixture, jsonCommand, lotelCommit, safeFailure, writeReport } from './support/observability-backends.mjs';

const report = { lane: 'lotel', status: 'failed', lotelCommit, collectorImage, startedAt: new Date().toISOString(), scenarios: [], cleanup: 'not-started' };
let ownedContainer;
let temporary;
let lotel;
let options;
let cleanupConfirmed = true;
async function portFree(port) {
  for (const host of ['0.0.0.0', '::']) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port, exclusive: true }, resolve); });
    } catch (error) {
      if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) continue;
      throw new Error(`lotel port ${port} on ${host} is unavailable (${error.code})`);
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
async function resolveLotel(directory) {
  if (process.env.LOTEL_BIN) return process.env.LOTEL_BIN;
  try { return await command('which', ['lotel']); } catch {}
  let source = process.env.LOTEL_SOURCE;
  if (!source) {
    source = join(directory, 'source');
    await command('git', ['init', source]);
    await command('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/mattsp1290/lotel.git', lotelCommit], { timeout: 120_000 });
    await command('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
  }
  assert.equal(await command('git', ['-C', source, 'rev-parse', 'HEAD']), lotelCommit, 'lotel source must match reviewed commit');
  const binary = join(directory, 'lotel');
  await command('go', ['build', '-o', binary, './cmd/lotel'], { cwd: source, timeout: 300_000 });
  return binary;
}
const query = (args) => jsonCommand(lotel, ['query', ...args], options);
function baseArgs(scenario) {
  return ['--service', scenario.service, '--since', new Date(Date.parse(scenario.startedAt) - 1000).toISOString(), '--until', new Date(Date.parse(scenario.endedAt) + 1000).toISOString()];
}
function verifyCalls(scenario, calls, traces, privacy) {
  assert(Array.isArray(calls) && Array.isArray(traces), 'lotel queries must return bare arrays');
  assert.equal(calls.length, expectedSpanCount(scenario), `${scenario.id} GenAI count`);
  assert.equal(traces.length, calls.length, `${scenario.id} raw trace count`);
  const bySpan = new Map(calls.map((call) => [call.span_id, call]));
  const rawBySpan = new Map(traces.map((span) => [span.span_id, span]));
  for (const expected of scenario.spans) {
    const call = bySpan.get(expected.spanId);
    const raw = rawBySpan.get(expected.spanId);
    assert(call && raw, `${scenario.id} missing original span identity`);
    assert.equal(call.trace_id, expected.traceId, 'original trace ID');
    assert.equal(raw.scope_name, '@mattsp1290/switchboard', 'versioned library instrumentation scope');
    assert.equal(raw.scope_version, '0.0.0', 'versioned library instrumentation scope');
    assert.equal(call.parent_span_id || undefined, expected.parentSpanId, 'original parent span ID');
    assert(call.duration_ms > 0 && raw.duration_ns > 0, 'positive observed duration');
    assert.equal(call.operation, { agent: 'invoke_agent', model: 'chat', tool: 'execute_tool' }[expected.kind]);
    assert.equal(call.status_code, expected.outcome === 'error' ? 2 : 0, 'honest terminal status');
    assert.equal(raw.attributes['switchboard.outcome'], expected.outcome);
    assert.equal(raw.attributes['switchboard.run_id'], scenario.runId);
    assert.equal(raw.attributes['switchboard.request_id'], expected.requestId);
    const agent = scenario.spans.find((candidate) => candidate.kind === 'agent' && candidate.spanId === (expected.parentSpanId ?? expected.spanId));
    const invocationIndex = agent.requestId.split('-').at(-1);
    assert.equal(call.conversation_id, `${scenario.runId}-conversation-${invocationIndex}`, 'exact conversation correlation retained');
    if (expected.kind !== 'tool') assert.equal(call.provider, 'openai');
    if (expected.kind === 'model') {
      assert.equal(call.request_model, 'switchboard-fixture');
      if (expected.outcome === 'success') assert.equal(call.response_model, 'switchboard-fixture');
      assert.equal(call.input_tokens, expected.usage?.inputTokens ?? null, 'per-request input usage');
      assert.equal(call.output_tokens, expected.usage?.outputTokens ?? null, 'per-request output usage');
      if (expected.outcome === 'error') assert.equal(call.error_type, 'provider-error');
    } else {
      assert.equal(call.input_tokens, null, 'nonmodel span has no usage');
      assert.equal(call.output_tokens, null, 'nonmodel span has no usage');
    }
    assert.equal(call.event_count, 0, 'fixture emits no content events');
  }
  assertPrivacy({ calls, traces }, privacy, scenario.contentPolicy);
}
try {
  temporary = await mkdtemp(join(tmpdir(), 'switchboard-lotel-'));
  lotel = await resolveLotel(temporary);
  const buildInfo = await command('go', ['version', '-m', lotel]);
  assert(buildInfo.includes(`vcs.revision=${lotelCommit}`) && buildInfo.includes('vcs.modified=false'), 'lotel binary must be built from the exact clean reviewed commit');
  report.lotelBuild = { revision: lotelCommit, modified: false, go: buildInfo.split('\n')[0].split(': ').at(-1) };
  if (process.env.LOTEL_SOURCE) assert.equal(await command('git', ['-C', process.env.LOTEL_SOURCE, 'rev-parse', 'HEAD']), lotelCommit);
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  const existing = await command('docker', ['ps', '-a', '--filter', 'name=^/lotel-collector$', '--format', '{{.ID}}']);
  assert.equal(existing, '', 'pre-existing lotel-collector is preserved; use a dedicated free Docker daemon');
  for (const port of [4317, 4318, 13133]) await portFree(port);
  options = { cwd: temporary, env: { ...process.env, HOME: temporary }, timeout: 60_000 };
  for (const signal of ['traces', 'metrics', 'logs']) {
    const dataDirectory = join(temporary, '.lotel', 'data', signal);
    await mkdir(dataDirectory, { recursive: true });
    await chmod(dataDirectory, 0o777);
  }
  cleanupConfirmed = false;
  try { await command(lotel, ['start', '--wait'], options); }
  finally {
    try {
      const state = JSON.parse(await readFile(join(temporary, '.lotel', 'collector.state'), 'utf8'));
      ownedContainer = state.container_id;
      cleanupConfirmed = false;
    } catch {
      try {
        const containers = await jsonCommand('docker', ['inspect', 'lotel-collector']);
        if (containers[0]?.Mounts?.some((mount) => mount.Source === join(temporary, '.lotel', 'data'))) { ownedContainer = containers[0].Id; cleanupConfirmed = false; }
      } catch {}
      if (!ownedContainer) {
        try { cleanupConfirmed = (await command('docker', ['ps', '-a', '--filter', 'name=^/lotel-collector$', '--format', '{{.ID}}'])) === ''; } catch {}
      }
    }
  }
  assert(ownedContainer, 'collector did not persist an owned container identity');
  await command(lotel, ['health'], options);
  report.collector = { id: ownedContainer, ownership: 'created' };
  report.cleanup = 'pending';
  const destinations = [{ kind: 'lotel', url: 'http://127.0.0.1:4318/v1/traces' }];
  if (process.env.DATADOG_ENDPOINT) destinations.push({ kind: 'datadog', url: process.env.DATADOG_ENDPOINT });
  const sourceDigest = await artifactSourceDigest();
  const fixture = await installedFixture(destinations);
  assert.equal(await artifactSourceDigest(), sourceDigest, 'artifact sources changed during fixture export');
  report.sourceDigest = sourceDigest;
  report.fixtureReport = await writeReport('fixture', { sourceDigest, tarballSha256: fixture.tarballSha256, sdk: fixture.sdk, rawPrivacy: 'passed', destinations: destinations.map(({kind, url}) => ({kind, url})), scenarios: fixture.scenarios.map((scenario) => ({ ...evidenceFor(scenario), contentPolicy: scenario.contentPolicy })) });
  report.tarballSha256 = fixture.tarballSha256;
  report.sdk = fixture.sdk;
  const deadline = Date.now() + 30_000;
  let interval = 250;
  for (;;) {
    const ingest = await jsonCommand(lotel, ['ingest'], options);
    assert(ingest.signals && typeof ingest.signals === 'object', 'malformed ingest report');
    for (const signal of Object.values(ingest.signals)) {
      assert.equal(signal.skipped_lines, 0, 'malformed collector records');
      assert.equal(signal.skipped_records, 0, 'malformed collector spans');
    }
    const counts = [];
    for (const scenario of fixture.scenarios) counts.push(await query(['genai', 'calls', ...baseArgs(scenario), '--limit', '100']));
    if (counts.every((calls, index) => Array.isArray(calls) && calls.length === expectedSpanCount(fixture.scenarios[index]))) break;
    if (Date.now() >= deadline) throw new Error(`lotel indexing timeout; observed scenario counts ${counts.map((calls) => calls?.length ?? 'malformed').join(',')}`);
    await delay(interval);
    interval = Math.min(interval * 2, 2000);
  }
  for (const scenario of fixture.scenarios) {
    const base = baseArgs(scenario);
    const calls = await query(['genai', 'calls', ...base, '--limit', '100']);
    const content = await query(['genai', 'calls', ...base, '--limit', '100', '--content']);
    const traces = await query(['traces', ...base, '--limit', '100']);
    verifyCalls(scenario, content, traces, fixture.privacy);
    assertPrivacy(calls, fixture.privacy, 'none');
    if (scenario.contentPolicy === 'sanitized') {
      for (const approved of fixture.privacy.content) assert(JSON.stringify(content).includes(approved), 'sanitized content missing from stored lotel view');
    }
    const usageArgs = ['genai', 'usage', ...base, '--operation', 'chat', '--group-by', 'provider,model,operation'];
    if (scenario.id.startsWith('success-')) {
      usageArgs.push('--trace-id', scenario.roots[0].traceId);
      const modelCalls = await query(['genai', 'calls', ...base, '--trace-id', scenario.roots[0].traceId, '--operation', 'chat', '--limit', '100']);
      assert.equal(modelCalls.length, 2, 'successful trace has exactly two model calls');
      assert.equal(modelCalls.reduce((sum, call) => sum + call.input_tokens, 0), 7);
      assert.equal(modelCalls.reduce((sum, call) => sum + call.output_tokens, 0), 4);
    }
    const usage = await query(usageArgs);
    assert(Array.isArray(usage) && usage.length === 1, 'one model usage group');
    assert.equal(usage[0].calls, scenario.expected.modelCount, 'model calls exclude agent and tool');
    assert.equal(usage[0].input_tokens, scenario.expected.inputTokens ?? 0);
    assert.equal(usage[0].output_tokens, scenario.expected.outputTokens ?? 0);
    assert.equal(usage[0].calls_missing_usage, scenario.expected.inputTokens === undefined ? scenario.expected.modelCount : 0);
    await jsonCommand(lotel, ['ingest'], options);
    const repeated = await query(['genai', 'calls', ...base, '--limit', '100']);
    assert.deepEqual(repeated, calls, 'repeated ingest must not duplicate or alter records');
    report.scenarios.push({ ...evidenceFor(scenario), observedCount: calls.length, modelUsage: usage.map(({ calls: count, input_tokens, output_tokens, calls_missing_usage }) => ({ calls: count, inputTokens: input_tokens, outputTokens: output_tokens, missingUsage: calls_missing_usage })) });
  }
  const rawLines = (await readFile(join(temporary, '.lotel', 'data', 'traces', 'traces.jsonl'), 'utf8')).trim().split('\n');
  let rawSpanCount = 0;
  for (const line of rawLines) {
    const envelope = JSON.parse(line);
    for (const resource of envelope.resourceSpans ?? []) {
      const service = resource.resource?.attributes?.find((attribute) => attribute.key === 'service.name')?.value?.stringValue;
      const scenario = fixture.scenarios.find((entry) => entry.service === service);
      if (!scenario) continue;
      assertPrivacy(resource, fixture.privacy, scenario.contentPolicy);
      for (const scope of resource.scopeSpans ?? []) rawSpanCount += scope.spans?.length ?? 0;
    }
  }
  assert.equal(rawSpanCount, fixture.scenarios.reduce((sum, scenario) => sum + expectedSpanCount(scenario), 0), 'runner-owned raw JSONL exact span count');
  report.rawPrivacy = 'passed';
  report.status = 'passed';
} catch (error) { report.failure = safeFailure(error); process.exitCode = 1; }
finally {
  if (ownedContainer) {
    try {
      const actual = await command('docker', ['inspect', '--format', '{{.Id}}', 'lotel-collector']);
      assert(actual === ownedContainer || actual.startsWith(ownedContainer), 'collector identity changed; preserving replacement');
      if (report.status === 'failed') {
        try { report.collectorDiagnostics = (await command('docker', ['logs', '--tail', '12', ownedContainer], { includeStderr: true })).slice(0, 3000); } catch (error) { report.collectorDiagnostics = safeFailure(error); }
      }
      await command('docker', ['stop', ownedContainer]);
      await command('docker', ['rm', ownedContainer]);
      const remaining = await command('docker', ['ps', '-a', '--filter', `id=${ownedContainer}`, '--format', '{{.ID}}']);
      assert.equal(remaining, '', 'owned collector must be removed before deleting its data');
      cleanupConfirmed = true;
      report.cleanup = 'owned collector stopped';
    } catch (error) { report.cleanup = safeFailure(error); report.status = 'failed'; process.exitCode = 1; }
  }
  if (temporary && cleanupConfirmed) await rm(temporary, { recursive: true, force: true });
  else if (temporary) {
    report.retainedDirectory = temporary;
    if (!ownedContainer) report.cleanup = 'collector ownership unconfirmed; temporary state retained';
  }
  report.endedAt = new Date().toISOString();
  const path = await writeReport('lotel', report);
  console.log(`lotel ${report.status}. ${report.failure ?? ''} Report ${path}`);
}
