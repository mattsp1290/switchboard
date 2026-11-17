import {
  assessFrontendRestore, compareRestoreDecisions, decideFrontendRestore, frontendRestoreCapabilities,
  frontendRestoreDelivery, frontendRestoreFact, parsePendingFrontendBatch, validateRestoreDecision,
} from '@mattsp1290/switchboard';
import type {
  Capability, DeliveryClass, FrontendRestoreCapabilities, FrontendRestoreError, FrontendRestoreFact,
  FrontendRestorePayload, FrontendRestorePolicy, Outcome, PendingFrontendBatch, RestoreAdapter, RestoreChoice,
  RestoreDecision, RestoreDecisionComparison, RestoreMechanism, RestoreMechanismSupport, RestoreObservation,
  RestoreSituation, ToolTarget,
} from '@mattsp1290/switchboard';
import { sessionReference } from './sessions.test.js';

const target: ToolTarget = { kind: 'tool', session: sessionReference, nativeToolCallId: 'native-a' };
export const pendingBatch: PendingFrontendBatch = {
  formatVersion: 1, adapter: 'codex', session: sessionReference, nativeTurnId: 'turn-a', epoch: 'epoch-1',
  sourceRunId: 'run-a', calls: [{ target, publicToolCallId: 'public-a', argumentsDigest: `sha256:${'a'.repeat(64)}`,
    definitionDigest: `sha256:${'b'.repeat(64)}` }],
};
export const observations: readonly RestoreObservation[] = [
  { kind: 'live-original', epoch: 'epoch-1' }, { kind: 'rejoined-original', epoch: 'epoch-2' },
  { kind: 'native-ended', settledToolCallIds: [] }, { kind: 'unobservable', reason: 'lookup-failed' },
];
export const parsed: Outcome<PendingFrontendBatch, FrontendRestoreError> = parsePendingFrontendBatch({
  value: JSON.parse('{}') as unknown, expected: { adapter: 'codex', session: sessionReference },
});
const assessed: Outcome<RestoreSituation, FrontendRestoreError> = assessFrontendRestore({
  batch: pendingBatch, observation: { kind: 'native-ended', settledToolCallIds: [] }, admission: 'production',
});

export function describe(situation: RestoreSituation): string {
  switch (situation.kind) {
    case 'warm': case 'original-lost': case 'already-settled': return situation.key;
    case 'rejoinable': return situation.epoch;
    case 'indeterminate': return situation.reason;
    default: { const exhaustive: never = situation; return exhaustive; }
  }
}
export function detail(decision: RestoreDecision): string {
  switch (decision.kind) {
    case 'settle-interrupted': return decision.reason;
    case 'continue-new-turn': return decision.successorRunId;
    case 'redispatch': return `${decision.executionGeneration}:${decision.replay}`;
    case 'defer': case 'deliver-original': case 'paired-repair': return decision.policyRevision;
    default: { const exhaustive: never = decision; return exhaustive; }
  }
}
export const delivery: DeliveryClass = frontendRestoreDelivery['paired-repair'];
export function errorDetail(error: FrontendRestoreError): string {
  return error.code === 'invalid-policy' ? error.field : error.code;
}
export const policy: FrontendRestorePolicy = {
  revision: 'app-v1',
  decide: (situation): RestoreChoice => situation.options.some((option) => option.mechanism === 'settle-interrupted')
    ? { kind: 'settle-interrupted', reason: 'endpoint-lost' } : { kind: 'defer' },
};
export async function decide(): Promise<Outcome<RestoreDecision, FrontendRestoreError> | null> {
  if (assessed.kind === 'error') return null;
  const situation = assessed.value;
  const decided = await decideFrontendRestore({ situation, policy });
  await decideFrontendRestore({ situation, policy: null });
  if (decided.kind === 'ok') {
    validateRestoreDecision({ situation, decision: decided.value });
    const compared: Outcome<RestoreDecisionComparison, FrontendRestoreError> = compareRestoreDecisions({ situation, stored: null, proposed: decided.value });
    const fact: Outcome<FrontendRestoreFact, FrontendRestoreError> = frontendRestoreFact({ phase: 'decided', situation, decision: decided.value });
    if (fact.kind === 'ok') {
      const payload: FrontendRestorePayload = fact.value.publicPayload;
      if (payload.phase === 'decided') void payload.deliveryClass;
      else void payload.options;
    }
    void compared;
  }
  return decided;
}
export const tables: { readonly [A in RestoreAdapter]: FrontendRestoreCapabilities } = frontendRestoreCapabilities;
export const codexOriginal: Capability<RestoreMechanismSupport> = frontendRestoreCapabilities.codex['deliver-original'];
export const mechanisms: readonly RestoreMechanism[] = ['defer', 'deliver-original', 'settle-interrupted', 'paired-repair', 'continue-new-turn', 'redispatch'];
