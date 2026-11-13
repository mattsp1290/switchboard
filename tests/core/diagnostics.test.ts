import { createSafeError, normalizeError, serializeDiagnostic, summarizeDiagnostic } from '@mattsp1290/switchboard';
import type { AdapterError, AuthError, DiagnosticCategory, DiagnosticCode, SafeDiagnostic, SafeError } from '@mattsp1290/switchboard';

export const codes: readonly DiagnosticCode[] = [
  'unsupported', 'busy', 'closed', 'invalid-input', 'native-failure',
  'invalid-config', 'invalid-boundary', 'credential-unavailable', 'aborted',
];
export const error: SafeError = createSafeError('busy');
export const diagnostic: SafeDiagnostic = summarizeDiagnostic('error', error);
export const normalized: SafeError = normalizeError({ code: 'busy' });
export const serialized: string = serializeDiagnostic(diagnostic);
export function describe(value: SafeDiagnostic): string {
  switch (value.kind) {
    case 'error': return value.error.code + value.error.message;
    case 'redacted': return value.category;
    default: { const exhaustive: never = value; return exhaustive; }
  }
}
export function fromDomain(value: AdapterError | AuthError): SafeError {
  return createSafeError(value.code);
}
export function project(category: DiagnosticCategory, value: unknown): SafeDiagnostic {
  return summarizeDiagnostic(category, value);
}
