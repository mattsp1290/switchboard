import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixtureScenarios } from './observability-fixture.mjs';

const execute = promisify(execFile);
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const lotelCommit = '8b7023e08d317cf079b7a63f93d1f17e67a0083d';
export const collectorImage = 'otel/opentelemetry-collector-contrib:0.165.0';
export const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
export async function command(file, args = [], options = {}) {
  const { includeStderr = false, ...executionOptions } = options;
  const { stdout, stderr } = await execute(file, args, { cwd: root, env: process.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...executionOptions, encoding: 'utf8' });
  return (includeStderr ? `${stdout}\n${stderr}` : stdout).trim();
}
export async function jsonCommand(file, args, options) {
  const output = await command(file, args, options);
  try { return JSON.parse(output); } catch { throw new Error(`${file.split('/').at(-1)} returned malformed JSON`); }
}
export function safeFailure(error) {
  const message = [String(error?.message ?? error).split('\n')[0], error?.stderr?.trim(), error?.stdout?.trim()].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  return message.replace(/(?:DD_[A-Z_]*(?:KEY|TOKEN)|authorization|api[_-]?key|token)[=: ]+\S+/gi, '[credential redacted]').slice(0, 1000);
}
export async function writeReport(lane, report) {
  const directory = join(root, '.audit', 'llm-observability');
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${lane}.json`);
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  return destination;
}
export async function installedFixture(destinations) {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-observability-consumer-'));
  try {
    const { tarball, ...identity } = await prepareProducerArtifact(directory);
    const outputPath = join(directory, 'result.json');
    await command(process.execPath, [join(directory, 'observability-producer.mjs'), tarball, JSON.stringify(destinations), outputPath], { cwd: directory, timeout: 240_000 });
    const data = JSON.parse(await readFile(outputPath, 'utf8'));
    return { ...data, ...identity };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const producerModules = ['observability-producer.mjs', 'observability-fixture.mjs', 'datadog-exporter.mjs', 'observability-backend-consumer.mjs'];
export async function prepareProducerArtifact(directory, projectRoot = root) {
  const npm = process.env.npm_execpath;
  const npmFile = npm ? process.execPath : 'npm';
  const npmArgs = npm ? [npm] : [];
  await command(npmFile, [...npmArgs, 'run', 'build'], { cwd: projectRoot, timeout: 120_000 });
  const packs = await jsonCommand(npmFile, [...npmArgs, 'pack', '--json', '--pack-destination', directory], { cwd: projectRoot, timeout: 120_000 });
  const tarball = join(directory, packs[0].filename);
  const tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const digest = createHash('sha256');
  for (const filename of producerModules) {
    const bytes = await readFile(join(projectRoot, 'scripts', 'support', filename));
    await writeFile(join(directory, filename), bytes);
    digest.update(filename).update('\0').update(bytes).update('\0');
  }
  return { tarball, tarballSha256, producerDigest: digest.digest('hex') };
}
export async function currentProducerIdentity(projectRoot = root) {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-observability-identity-'));
  try {
    const { tarballSha256, producerDigest } = await prepareProducerArtifact(directory, projectRoot);
    return { tarballSha256, producerDigest };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export function assertPrivacy(value, privacy, contentPolicy) {
  const serialized = JSON.stringify(value);
  for (const canary of privacy.secrets) assert(!serialized.includes(canary), 'secret canary reached telemetry');
  for (const content of privacy.content) {
    if (contentPolicy === 'none') assert(!serialized.includes(content), 'default policy exported content');
  }
}
export function expectedSpanCount(scenario) {
  const expected = scenario.expected;
  return expected.agentCount + expected.modelCount + expected.toolCount;
}
export function evidenceFor(scenario) {
  return { id: scenario.id, service: scenario.service, runId: scenario.runId, startedAt: scenario.startedAt, endedAt: scenario.endedAt,
    requests: scenario.requests, toolExecutions: scenario.toolExecutions, roots: scenario.roots, spans: scenario.spans,
    expected: scenario.expected, privacy: 'passed' };
}
export function matchesOtelId(returnedId, expectedHex) {
  assert(typeof returnedId === 'string', 'backend identifiers must remain lossless strings');
  if (!/^[a-fA-F0-9]{1,32}$/.test(returnedId)) return false;
  const hexMatch = returnedId.toLowerCase().padStart(expectedHex.length, '0') === expectedHex.toLowerCase();
  const decimalMatch = /^\d+$/.test(returnedId) && BigInt(returnedId) === BigInt(`0x${expectedHex}`);
  return hexMatch || decimalMatch;
}
export function validateFixtureHandoff(fixture, contracts = fixtureScenarios) {
  assert(/^[0-9a-f]{64}$/.test(fixture.tarballSha256), 'fixture artifact digest malformed');
  assert(/^[0-9a-f]{64}$/.test(fixture.producerDigest), 'fixture producer digest malformed');
  assert(Array.isArray(fixture.scenarios) && fixture.scenarios.length === contracts.length, 'fixture handoff requires every scenario');
  for (const field of ['id', 'service', 'runId']) {
    assert.equal(new Set(fixture.scenarios.map((scenario) => scenario[field])).size, contracts.length, `fixture ${field} must be unique`);
  }
  const allSpanIds = new Set();
  for (const contract of contracts) {
    const scenario = fixture.scenarios.find((entry) => entry.id === contract.id);
    assert(scenario, 'fixture handoff missing required scenario');
    assert.equal(scenario.contentPolicy, contract.contentPolicy, 'fixture content policy');
    assert.deepEqual(scenario.expected, JSON.parse(JSON.stringify(contract.expected)), 'fixture expected facts');
    assert.equal(scenario.requests, contract.expected.modelCount, 'fixture actual HTTP request count');
    assert.equal(scenario.toolExecutions, contract.expected.toolCount, 'fixture actual tool count');
    assert.equal(scenario.spans?.length, expectedSpanCount(contract), 'fixture span count');
    assert.equal(scenario.roots?.length, contract.expected.agentCount, 'fixture root count');
    assert(typeof scenario.service === 'string' && typeof scenario.runId === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(scenario.service) && /^[A-Za-z0-9_.:-]{1,256}$/.test(scenario.runId), 'fixture correlations malformed');
    assert(Number.isFinite(Date.parse(scenario.startedAt)) && Date.parse(scenario.endedAt) >= Date.parse(scenario.startedAt), 'fixture run window malformed');
    const roots = new Map(scenario.roots.map((span) => [span.spanId, span.traceId]));
    assert.equal(roots.size, contract.expected.agentCount, 'fixture roots must be distinct');
    assert.equal(new Set(roots.values()).size, roots.size, 'fixture roots must have disjoint traces');
    for (const [kind, count] of [['agent', contract.expected.agentCount], ['model', contract.expected.modelCount], ['tool', contract.expected.toolCount]]) {
      assert.equal(scenario.spans.filter((span) => span.kind === kind).length, count, `fixture ${kind} count`);
    }
    for (const span of scenario.spans) {
      assert(/^[0-9a-f]{32}$/.test(span.traceId) && !/^0+$/.test(span.traceId) && /^[0-9a-f]{16}$/.test(span.spanId) && !/^0+$/.test(span.spanId), 'fixture OTel identity malformed');
      assert(!allSpanIds.has(span.spanId), 'fixture span identities must be unique');
      allSpanIds.add(span.spanId);
      assert.equal(span.outcome, contract.expected.outcome, 'fixture terminal observation');
      assert(typeof span.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(span.requestId), 'fixture request correlation malformed');
      if (span.kind === 'agent') {
        assert.equal(span.parentSpanId, undefined, 'fixture agent must be a root');
        assert.equal(roots.get(span.spanId), span.traceId, 'fixture agent root identity');
      } else assert.equal(roots.get(span.parentSpanId), span.traceId, 'fixture child has original direct parent');
    }
  }
}
export function validateFixtureOrigin(fixture, lotelReport, current) {
  assert.equal(lotelReport.status, 'passed', 'originating lotel qualification must pass');
  assert(/^[0-9a-f]{64}$/.test(fixture.tarballSha256), 'fixture artifact digest malformed');
  assert.equal(fixture.tarballSha256, lotelReport.tarballSha256, 'both backends must qualify the same tarball');
  assert.equal(fixture.tarballSha256, current.tarballSha256, 'packed artifact changed; export a new fixture');
  assert(/^[0-9a-f]{64}$/.test(fixture.producerDigest), 'fixture producer digest malformed');
  assert.equal(fixture.producerDigest, current.producerDigest, 'fixture producer changed; export a new fixture');
  assert.equal(lotelReport.producerDigest, current.producerDigest, 'originating lotel report describes a different producer');
  assert.equal(lotelReport.scenarios?.length, fixture.scenarios.length, 'originating lotel report requires every scenario');
  for (const contract of fixture.scenarios) {
    const scenario = contract;
    const origin = lotelReport.scenarios.find((entry) => entry.id === contract.id);
    for (const field of ['service', 'runId', 'startedAt', 'endedAt', 'requests', 'toolExecutions', 'roots', 'spans', 'expected']) {
      assert.deepEqual(scenario[field], origin?.[field], 'fixture facts differ from originating lotel evidence');
    }
  }
}
export function validateBackendTraceTrees(scenario, associations) {
  assert.equal(associations.length, scenario.spans.length, 'every original span needs a backend association');
  const byOriginal = new Map(associations.map((association) => [association.otelSpanId, association]));
  assert.equal(byOriginal.size, scenario.spans.length, 'original span associations must be unique');
  const rootTraces = new Set();
  for (const original of scenario.spans) {
    const association = byOriginal.get(original.spanId);
    assert(association && typeof association.backendTraceId === 'string' && association.backendTraceId.length > 0, 'backend trace identity absent');
    assert.equal(association.otelTraceId, original.traceId, 'original trace association changed');
    if (original.parentSpanId) {
      const parent = byOriginal.get(original.parentSpanId);
      assert(parent, 'original parent backend association absent');
      assert.equal(association.backendTraceId, parent.backendTraceId, 'backend child and parent must share a trace');
    } else {
      assert(!rootTraces.has(association.backendTraceId), 'disjoint original roots must remain disjoint backend traces');
      rootTraces.add(association.backendTraceId);
    }
  }
}
