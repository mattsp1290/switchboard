import {
  parseCheckpointReference,
  parseSessionReference,
  validateSessionDiscoveryBounds,
} from '@mattsp1290/switchboard';
import type {
  CheckpointReference,
  Outcome,
  SessionAccess,
  SessionBinding,
  SessionCorrelation,
  SessionDiscovery,
  SessionDiscoveryDiagnostic,
  SessionDiscoveryPage,
  SessionInspection,
  SessionInspectionResult,
  SessionReference,
  SessionReferenceError,
} from '@mattsp1290/switchboard';

export const sessionBinding: SessionBinding = {
  engine: 'acme/native', nativeVersion: '1.2', account: 'account-a',
  authorizedScope: 'workspace-a', nativeFormat: 'acme/session-v3',
};
export const sessionReference: SessionReference = {
  kind: 'session', formatVersion: 1, binding: sessionBinding, opaque: 'native-session-a',
};
export const checkpoint: CheckpointReference = {
  kind: 'checkpoint', formatVersion: 1, binding: sessionBinding,
  sessionOpaque: sessionReference.opaque, opaque: 'native-checkpoint-a',
};
const correlation: SessionCorrelation = { threadId: 'host-thread', runId: 'host-run', requestId: 'host-request' };
export declare const persisted: unknown;
const parsed: Outcome<SessionReference, SessionReferenceError> = parseSessionReference({
  value: persisted, expected: sessionBinding,
});
if (parsed.kind === 'ok') parseCheckpointReference({ value: persisted, session: parsed.value });
const bounds = validateSessionDiscoveryBounds({ maxResults: 2, maxExamined: 10, maxDurationMs: 100 });
interface Scope { readonly authorizedRoots: readonly string[] }
export declare const discovery: SessionDiscovery<Scope>;
export declare const inspection: SessionInspection<Scope>;
if (bounds.kind === 'ok') {
  const access: SessionAccess<Scope> = {
    binding: sessionBinding, scope: { authorizedRoots: ['/host-authorized-root'] },
    bounds: bounds.value, signal: new AbortController().signal,
  };
  void discovery.discover(access);
  void inspection.inspect({ ...access, reference: sessionReference });
}
export function inspectState(result: SessionInspectionResult): string {
  switch (result.kind) {
    case 'available': return result.reference.opaque;
    case 'absent': return 'absent';
    case 'busy': return 'busy';
    case 'incompatible': return result.reason;
    default: { const exhaustive: never = result; return exhaustive; }
  }
}
export function pageState(page: SessionDiscoveryPage): string {
  switch (page.kind) {
    case 'complete': return 'complete';
    case 'truncated': return page.reason;
    case 'cancelled': return 'cancelled';
    case 'failed': return page.code;
    default: { const exhaustive: never = page; return exhaustive; }
  }
}
void checkpoint;
void correlation;

export const inspectionStates: readonly SessionInspectionResult[] = [
  { kind: 'available', reference: sessionReference }, { kind: 'absent' }, { kind: 'busy' },
  { kind: 'incompatible', reason: 'native-version' }, { kind: 'incompatible', reason: 'native-format' },
];
export const discoveryPages: readonly SessionDiscoveryPage[] = [
  { kind: 'complete', sessions: [], examined: 0, skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [] },
  { kind: 'truncated', reason: 'examined', sessions: [], examined: 10, skipped: { corrupt: 4, inaccessible: 6 }, diagnostics: [] },
  { kind: 'cancelled', sessions: [], examined: 0, skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [] },
];

export const fileDiagnostic: SessionDiscoveryDiagnostic = {
  kind: 'file-inspection-failed', subject: { kind: 'discovery-file', token: '1' },
};
export const observedPage: SessionDiscoveryPage = {
  kind: 'complete', sessions: [sessionReference], examined: 3,
  skipped: { corrupt: 0, inaccessible: 0 },
  diagnostics: [fileDiagnostic, { kind: 'file-inspection-failed', subject: { kind: 'discovery-file', token: '2' } }],
};
export const observedPages: readonly SessionDiscoveryPage[] = [
  observedPage,
  { ...observedPage, kind: 'truncated', reason: 'results' },
  { ...observedPage, kind: 'truncated', reason: 'examined' },
  { ...observedPage, kind: 'truncated', reason: 'duration' },
  { ...observedPage, kind: 'cancelled' },
  { ...observedPage, kind: 'failed', code: 'inaccessible' },
  { ...observedPage, kind: 'failed', code: 'native-failure' },
];
for (const page of observedPages) {
  const diagnostics: readonly SessionDiscoveryDiagnostic[] = page.diagnostics;
  for (const diagnostic of diagnostics) {
    const kind: 'file-inspection-failed' = diagnostic.kind;
    const subjectKind: 'discovery-file' = diagnostic.subject.kind;
    const token: string = diagnostic.subject.token;
    void [kind, subjectKind, token];
  }
  pageState(page);
}
