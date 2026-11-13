import { createDispatchOperation } from '@mattsp1290/switchboard';
import type {
  ReconcileNative, ReconcileResult, ReconciliationHandle, RecoveryDispatchOptions, SharedDispatchOptions,
} from '@mattsp1290/switchboard';
import { dispatchEvidence, dispatchHandle, dispatchIdentity } from './dispatch.test.js';

export const lookup: ReconcileNative<{ readonly state: string }> = (previous, _signal) => ({
  kind: 'conclusive', evidence: { ...dispatchEvidence, identity: previous.identity, source: 'authoritative-native-lookup' },
  result: { state: 'rejected' },
});
export const shared: SharedDispatchOptions<{ readonly state: string }> = { identity: dispatchIdentity, reconcileNative: lookup };
export const recoveryOptions: RecoveryDispatchOptions<{ readonly state: string }> = {
  ...shared, mode: 'recovery', previous: { kind: 'accepted', evidence: dispatchEvidence },
};
export const recovery: ReconciliationHandle<{ readonly state: string }> = createDispatchOperation(recoveryOptions);
export const recovered: Promise<ReconcileResult<{ readonly state: string }>> = recovery.reconcile(new AbortController().signal);
export const freshReconciliation = dispatchHandle.reconcile(new AbortController().signal);
export function reconciliationState(value: ReconcileResult<{ readonly state: string }>): string {
  if (value.kind === 'error') return value.error.code;
  const observation = value.value.observation;
  return observation.kind === 'conclusive' ? observation.result.state : observation.kind;
}
