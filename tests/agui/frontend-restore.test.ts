import assert from 'node:assert/strict';
import test from 'node:test';
import { assessFrontendRestore, frontendRestoreFact, parsePendingFrontendBatch } from '@mattsp1290/switchboard';
import type { FrontendRestoreFact, RestoreSituation } from '@mattsp1290/switchboard';
import { createAguiProjection } from '@mattsp1290/switchboard/agui';
import type { AguiProjection, ProjectionBounds, ProjectionFact } from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const bounds: ProjectionBounds = { maxEntities: 24, maxPayloadBytes: 8192, maxJsonDepth: 20, maxJsonNodes: 512 };
const binding = { engine: 'codex', nativeVersion: '0.169.0', account: 'account', authorizedScope: 'scope', nativeFormat: 'app-server' };
const session = { kind: 'session', formatVersion: 1, binding, opaque: 'thread-a' } as const;
const digest = `sha256:${'a'.repeat(64)}`;

function situation(): RestoreSituation {
  const batch = parsePendingFrontendBatch({ expected: { adapter: 'codex', session }, value: {
    formatVersion: 1, adapter: 'codex', session, nativeTurnId: 'turn-a', epoch: 'epoch-1', sourceRunId: 'run-source',
    calls: [{ target: { kind: 'tool', session, nativeToolCallId: 'native-a' }, publicToolCallId: 'public-a',
      argumentsDigest: digest, definitionDigest: digest }],
  } });
  assert(batch.kind === 'ok');
  const assessed = assessFrontendRestore({ batch: batch.value, observation: { kind: 'native-ended', settledToolCallIds: [] },
    admission: 'production' });
  assert(assessed.kind === 'ok');
  return assessed.value;
}
function facts(current: RestoreSituation): readonly FrontendRestoreFact[] {
  const required = frontendRestoreFact({ phase: 'required', situation: current });
  const decided = frontendRestoreFact({ phase: 'decided', situation: current, decision: { formatVersion: 1,
    situationKey: current.key, policyRevision: 'app-v1', kind: 'settle-interrupted', reason: 'endpoint-lost' } });
  assert(required.kind === 'ok' && decided.kind === 'ok');
  return [required.value, decided.value];
}
function actor(runId: string): AguiProjection {
  const made = createAguiProjection({ threadId: 'thread', runId, sourceKey: 'source', bounds });
  assert(made.kind === 'ok');
  return made.value;
}

test('frontend restore facts project as one CUSTOM event each through the existing mapper', () => {
  const recovery = actor('run-recovery');
  assert.equal(recovery.accept({ kind: 'run-started' }).kind, 'mapped');
  for (const [index, fact] of facts(situation()).entries()) {
    const projected: ProjectionFact = fact;
    const result = recovery.accept(projected);
    assert(result.kind === 'mapped');
    collectEvents(`frontend-restore/${index}`, result.events);
    assert.deepEqual(result.events, [{ type: 'CUSTOM', name: 'frontend-restore', value: {
      namespace: 'switchboard.frontend-restore', schemaVersion: '1', publicPayload: fact.publicPayload } }]);
    assert(result.events.every((event) => event.type !== 'RUN_FINISHED' && event.type !== 'RUN_ERROR'));
  }
});

test('a finished source run rejects restore facts, so restore never reopens or re-terminates it', () => {
  const [required] = facts(situation());
  assert(required);
  const source = actor('run-source');
  assert.equal(source.accept({ kind: 'run-started' }).kind, 'mapped');
  const finished = source.accept({ kind: 'run-finished', outcome: 'success' });
  assert(finished.kind === 'mapped');
  assert.deepEqual(source.accept(required), { kind: 'error', error: { code: 'invalid-order' } });
});
