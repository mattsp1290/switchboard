import { parseInteractionContinuation } from '@mattsp1290/switchboard';
import type {
  ApprovalTarget, DelegatedOutcome, DelegationTarget, HostApprovalIntent, HostApprovalPolicy,
  InteractionContinuation, InteractionError, InteractionTarget, NativeDelivery, NativeExtension,
  Outcome, PendingApproval, PendingInteraction, ToolEffect, ToolOutcome, ToolTarget,
} from '@mattsp1290/switchboard';
import { sessionReference } from './sessions.test.js';

export const native: NativeExtension = { namespace: 'fixture/native', schemaVersion: 1, data: undefined };
export const approvalTarget: ApprovalTarget = {
  kind: 'approval', session: sessionReference, nativeApprovalId: 'approval-a', tool: null,
};
export const toolTarget: ToolTarget = { kind: 'tool', session: sessionReference, nativeToolCallId: 'tool-a' };
export const delegationTarget: DelegationTarget = { kind: 'delegation', session: sessionReference, nativeDelegationId: 'child-a' };
export const approval: PendingApproval = { kind: 'approval', target: approvalTarget,
  nativePolicy: native, request: native, choices: [{ nativeChoiceId: 'native-once', label: 'Native once' }] };
export const policy: HostApprovalPolicy = async () => ({ kind: 'withhold' });
export const choosePolicy: HostApprovalPolicy = (pending) => {
  const choice = pending.choices[0];
  return choice ? { kind: 'choose-native-choice', nativeChoiceId: choice.nativeChoiceId } : { kind: 'withhold' };
};
export const pendingStates: readonly PendingInteraction[] = [
  approval, { kind: 'tool', target: toolTarget }, { kind: 'delegation', targets: [delegationTarget] },
];
export const toolOutcome: ToolOutcome = { target: toolTarget, result: { kind: 'error', error: native },
  effect: { kind: 'known', effect: 'occurred', evidence: native }, delivery: { kind: 'unknown' } };
export const continuations: readonly InteractionContinuation[] = [
  { formatVersion: 1, kind: 'approval', target: approvalTarget, nativeChoiceId: 'native-once' },
  { formatVersion: 1, kind: 'tool', outcome: toolOutcome },
  { formatVersion: 1, kind: 'delegation', outcomes: [{ kind: 'completed', target: delegationTarget,
    result: { kind: 'ok', value: native }, delivery: { kind: 'confirmed', evidence: native } }] },
];
export function targetId(target: InteractionTarget): string {
  switch (target.kind) {
    case 'approval': return target.nativeApprovalId;
    case 'tool': return target.nativeToolCallId;
    case 'delegation': return target.nativeDelegationId;
    default: { const exhaustive: never = target; return exhaustive; }
  }
}
export function pendingId(pending: PendingInteraction): string {
  switch (pending.kind) {
    case 'approval': return pending.request.namespace;
    case 'tool': return pending.target.nativeToolCallId;
    case 'delegation': return pending.targets.map(targetId).join(',');
    default: { const exhaustive: never = pending; return exhaustive; }
  }
}
export function continuationKind(continuation: InteractionContinuation): string {
  switch (continuation.kind) {
    case 'approval': return continuation.nativeChoiceId;
    case 'tool': return continuation.outcome.result.kind;
    case 'delegation': return continuation.outcomes.map(delegationState).join(',');
    default: { const exhaustive: never = continuation; return exhaustive; }
  }
}
export function delegationState(outcome: DelegatedOutcome): string {
  switch (outcome.kind) {
    case 'completed': return outcome.result.kind;
    case 'cancelled': return 'cancelled';
    case 'unknown': return 'unknown';
    default: { const exhaustive: never = outcome; return exhaustive; }
  }
}
export function effectState(effect: ToolEffect): string {
  switch (effect.kind) {
    case 'known': return effect.effect + effect.evidence.namespace;
    case 'unknown': return 'unknown';
    default: { const exhaustive: never = effect; return exhaustive; }
  }
}
export function deliveryState(delivery: NativeDelivery): string {
  switch (delivery.kind) {
    case 'confirmed': return delivery.evidence.namespace;
    case 'unknown': return 'unknown';
    default: { const exhaustive: never = delivery; return exhaustive; }
  }
}
export function intentState(intent: HostApprovalIntent): string {
  switch (intent.kind) {
    case 'choose-native-choice': return intent.nativeChoiceId;
    case 'withhold': return 'withhold';
    default: { const exhaustive: never = intent; return exhaustive; }
  }
}
const parsed: Outcome<InteractionContinuation, InteractionError> = parseInteractionContinuation({ value: continuations[0], expected: approval });
void parsed;
