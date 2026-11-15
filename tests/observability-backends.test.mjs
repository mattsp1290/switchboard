import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesOtelId, validateBackendTraceTrees, validateFixtureHandoff, validateFixtureOrigin } from '../scripts/support/observability-backends.mjs';
import { fixtureScenarios } from '../scripts/support/observability-fixture.mjs';

const digest = 'a'.repeat(64);
const sourceDigest = 'b'.repeat(64);

function fixtureEvidence() {
  let identity = 1;
  const nextId = (length) => (identity++).toString(16).padStart(length, '0');
  return {
    tarballSha256: digest, sourceDigest,
    scenarios: fixtureScenarios.map((contract, index) => {
      const roots = Array.from({ length: contract.expected.agentCount }, () => ({ traceId: nextId(32), spanId: nextId(16) }));
      const spans = roots.map((root) => ({ ...root, kind: 'agent', requestId: nextId(16), outcome: contract.expected.outcome }));
      for (let model = 0; model < contract.expected.modelCount; model++) {
        const root = roots[model % roots.length];
        spans.push({ kind: 'model', traceId: root.traceId, spanId: nextId(16), parentSpanId: root.spanId,
          requestId: nextId(16), outcome: contract.expected.outcome });
      }
      for (let tool = 0; tool < contract.expected.toolCount; tool++) {
        spans.push({ kind: 'tool', traceId: roots[0].traceId, spanId: nextId(16), parentSpanId: roots[0].spanId,
          requestId: nextId(16), outcome: 'success' });
      }
      return { id: contract.id, contentPolicy: contract.contentPolicy, expected: JSON.parse(JSON.stringify(contract.expected)),
        service: `service-${index}`, runId: `run-${index}`, requests: contract.expected.modelCount,
        toolExecutions: contract.expected.toolCount, startedAt: '2026-11-15T00:00:00.000Z',
        endedAt: '2026-11-15T00:00:01.000Z', roots, spans };
    }),
  };
}

test('backend handoff requires all seven independently identified scenarios', () => {
  assert.deepEqual(fixtureScenarios.map(({ id }) => id), [
    'success-none', 'success-sanitized', 'missing-usage', 'http-error', 'disconnect', 'cancelled', 'parallel',
  ]);
  const valid = fixtureEvidence();
  assert.doesNotThrow(() => validateFixtureHandoff(valid));
  for (const scenarios of [[], valid.scenarios.slice(1)]) {
    assert.throws(() => validateFixtureHandoff({ ...valid, scenarios }), /every scenario/);
  }
  for (const field of ['id', 'service', 'runId']) {
    const changed = structuredClone(valid);
    changed.scenarios[1][field] = changed.scenarios[0][field];
    assert.throws(() => validateFixtureHandoff(changed), /unique/);
  }
});

test('backend handoff rejects altered HTTP counts, policies, usage expectations, and parent trees', () => {
  const mutations = [
    (fixture) => { fixture.scenarios[0].requests++; },
    (fixture) => { fixture.scenarios[1].contentPolicy = 'none'; },
    (fixture) => { fixture.scenarios[0].expected.inputTokens = 0; },
    (fixture) => { fixture.scenarios[0].spans.pop(); },
    (fixture) => { fixture.scenarios[0].spans[1].parentSpanId = 'f'.repeat(16); },
    (fixture) => { fixture.scenarios[0].roots[0].traceId = '0'.repeat(32); },
    (fixture) => { fixture.scenarios[0].spans[1].spanId = fixture.scenarios[0].spans[0].spanId; },
  ];
  for (const mutate of mutations) {
    const changed = fixtureEvidence();
    mutate(changed);
    assert.throws(() => validateFixtureHandoff(changed));
  }
});

test('reused backend evidence must match a passed origin and current implementation', () => {
  const fixture = fixtureEvidence();
  const origin = { ...structuredClone(fixture), status: 'passed' };
  assert.doesNotThrow(() => validateFixtureOrigin(fixture, origin, sourceDigest));
  assert.throws(() => validateFixtureOrigin(fixture, { ...origin, status: 'failed' }, sourceDigest), /must pass/);
  assert.throws(() => validateFixtureOrigin(fixture, origin, 'c'.repeat(64)), /source changed/);
  assert.throws(() => validateFixtureOrigin(fixture, { ...origin, tarballSha256: 'd'.repeat(64) }, sourceDigest), /same tarball/);
  const changed = structuredClone(fixture);
  changed.scenarios[0].spans[0].requestId = 'different';
  assert.throws(() => validateFixtureOrigin(changed, origin, sourceDigest), /differ/);
});

test('backend IDs match both lossless decimal and digit-only hexadecimal representations', () => {
  for (const expected of ['1234567890123456', 'abcdef1234567890', 'ffffffffffffffff']) {
    assert(matchesOtelId(expected, expected));
    assert(matchesOtelId(BigInt(`0x${expected}`).toString(10), expected));
  }
  assert(!matchesOtelId('1234567890123457', '1234567890123456'));
  assert(!matchesOtelId('not-an-id', '1234567890123456'));
  assert.throws(() => matchesOtelId(123, '1234567890123456'), /lossless strings/);
});

test('backend conversion preserves disjoint roots and keeps children with their parent', () => {
  const scenario = fixtureEvidence().scenarios.find(({ id }) => id === 'parallel');
  const associations = scenario.spans.map((span) => ({ otelTraceId: span.traceId, otelSpanId: span.spanId,
    backendTraceId: `converted-${span.traceId}`, backendSpanId: BigInt(`0x${span.spanId}`).toString(10) }));
  assert.doesNotThrow(() => validateBackendTraceTrees(scenario, associations));
  const merged = associations.map((association) => ({ ...association, backendTraceId: 'merged-trace' }));
  assert.throws(() => validateBackendTraceTrees(scenario, merged), /disjoint/);
  const disconnected = structuredClone(associations);
  disconnected.find((association) => association.otelSpanId === scenario.spans.find(({ kind }) => kind === 'model').spanId)
    .backendTraceId = 'disconnected-trace';
  assert.throws(() => validateBackendTraceTrees(scenario, disconnected), /share a trace/);
  assert.throws(() => validateBackendTraceTrees(scenario, associations.slice(1)), /every original span/);
});
