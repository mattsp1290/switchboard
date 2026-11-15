import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  const npm = process.env.npm_execpath;
  const npmFile = npm ? process.execPath : 'npm';
  const npmArgs = npm ? [npm] : [];
  try {
    await command(npmFile, [...npmArgs, 'run', 'build'], { timeout: 120_000 });
    const packs = await jsonCommand(npmFile, [...npmArgs, 'pack', '--json', '--pack-destination', directory], { timeout: 120_000 });
    const tarball = join(directory, packs[0].filename);
    const tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await command(npmFile, [...npmArgs, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', tarball,
      '@opentelemetry/api@1.9.0', '@opentelemetry/resources@2.12.0', '@opentelemetry/sdk-trace-node@2.12.0',
      '@opentelemetry/sdk-trace-base@2.12.0', '@opentelemetry/exporter-trace-otlp-proto@0.223.0'], { cwd: directory, timeout: 120_000 });
    for (const filename of ['observability-fixture.mjs', 'datadog-exporter.mjs', 'observability-backend-consumer.mjs']) {
      await cp(join(root, 'scripts', 'support', filename), join(directory, filename));
    }
    const outputPath = join(directory, 'result.json');
    await command(process.execPath, [join(directory, 'observability-backend-consumer.mjs'), JSON.stringify(destinations), outputPath], { cwd: directory, timeout: 120_000 });
    const data = JSON.parse(await readFile(outputPath, 'utf8'));
    return { ...data, tarballSha256 };
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
export async function artifactSourceDigest() {
  const files = ['package.json', 'package-lock.json', 'scripts/support/observability-fixture.mjs', 'scripts/support/datadog-exporter.mjs', 'scripts/support/observability-backend-consumer.mjs'];
  async function collect(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else files.push(path);
    }
  }
  await collect('src');
  const digest = createHash('sha256');
  for (const file of files.sort()) digest.update(file).update('\0').update(await readFile(join(root, file))).update('\0');
  return digest.digest('hex');
}
export function validateFixtureHandoff(fixture, contracts = fixtureScenarios) {
  assert(/^[0-9a-f]{64}$/.test(fixture.tarballSha256), 'fixture artifact digest malformed');
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
export function validateFixtureOrigin(fixture, lotelReport, sourceDigest) {
  assert.equal(lotelReport.status, 'passed', 'originating lotel qualification must pass');
  assert(/^[0-9a-f]{64}$/.test(fixture.tarballSha256), 'fixture artifact digest malformed');
  assert.equal(fixture.tarballSha256, lotelReport.tarballSha256, 'both backends must qualify the same tarball');
  assert.equal(fixture.sourceDigest, sourceDigest, 'fixture source changed; export the current installed artifact again');
  assert.equal(lotelReport.sourceDigest, sourceDigest, 'originating lotel report describes stale sources');
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
