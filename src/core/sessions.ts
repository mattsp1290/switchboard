import type { Outcome } from './contracts.js';

export interface SessionBinding {
  readonly engine: string;
  readonly nativeVersion: string;
  readonly account: string;
  readonly authorizedScope: string;
  readonly nativeFormat: string;
}

export interface SessionReference {
  readonly kind: 'session';
  readonly formatVersion: 1;
  readonly binding: SessionBinding;
  readonly opaque: string;
}

export interface CheckpointReference {
  readonly kind: 'checkpoint';
  readonly formatVersion: 1;
  readonly binding: SessionBinding;
  readonly sessionOpaque: string;
  readonly opaque: string;
}

export interface SessionCorrelation {
  readonly threadId: string;
  readonly runId?: string;
  readonly requestId?: string;
}

export interface SessionReferenceError {
  readonly code: 'invalid-reference' | 'unsupported-version' | 'binding-mismatch' | 'session-mismatch';
}

export const sessionLimits = Object.freeze({
  identifierLength: 1024,
  opaqueLength: 8192,
  maxResults: 1000,
  maxExamined: 100000,
  maxDurationMs: 60000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function copyBinding(value: unknown): SessionBinding | undefined {
  if (!isRecord(value)) return undefined;
  const { engine, nativeVersion, account, authorizedScope, nativeFormat } = value;
  if (!isText(engine, sessionLimits.identifierLength)
    || !isText(nativeVersion, sessionLimits.identifierLength)
    || !isText(account, sessionLimits.identifierLength)
    || !isText(authorizedScope, sessionLimits.identifierLength)
    || !isText(nativeFormat, sessionLimits.identifierLength)) return undefined;
  return Object.freeze({ engine, nativeVersion, account, authorizedScope, nativeFormat });
}

function sameBinding(left: SessionBinding, right: SessionBinding): boolean {
  return left.engine === right.engine && left.nativeVersion === right.nativeVersion
    && left.account === right.account && left.authorizedScope === right.authorizedScope
    && left.nativeFormat === right.nativeFormat;
}

function checkEnvelope(value: unknown, expected: SessionBinding): Outcome<{
  readonly binding: SessionBinding;
  readonly opaque: string;
  readonly kind: 'session' | 'checkpoint';
}, SessionReferenceError> {
  const expectedBinding = copyBinding(expected);
  if (!isRecord(value) || !expectedBinding) {
    return { kind: 'error', error: { code: 'invalid-reference' } };
  }
  const { kind, formatVersion, binding: rawBinding, opaque } = value;
  const binding = copyBinding(rawBinding);
  if ((kind !== 'session' && kind !== 'checkpoint') || !binding
    || !isText(opaque, sessionLimits.opaqueLength)
    || typeof formatVersion !== 'number' || !Number.isSafeInteger(formatVersion) || formatVersion < 1) {
    return { kind: 'error', error: { code: 'invalid-reference' } };
  }
  if (formatVersion !== 1) return { kind: 'error', error: { code: 'unsupported-version' } };
  if (!sameBinding(binding, expectedBinding)) {
    return { kind: 'error', error: { code: 'binding-mismatch' } };
  }
  return { kind: 'ok', value: { kind, binding, opaque } };
}

export function parseSessionReference(options: {
  readonly value: unknown;
  readonly expected: SessionBinding;
}): Outcome<SessionReference, SessionReferenceError> {
  const checked = checkEnvelope(options.value, options.expected);
  if (checked.kind === 'error') return checked;
  if (checked.value.kind !== 'session') return { kind: 'error', error: { code: 'invalid-reference' } };
  return { kind: 'ok', value: Object.freeze({ ...checked.value, kind: 'session', formatVersion: 1 }) };
}

export function parseCheckpointReference(options: {
  readonly value: unknown;
  readonly session: SessionReference;
}): Outcome<CheckpointReference, SessionReferenceError> {
  const session = parseSessionReference({ value: options.session, expected: options.session.binding });
  if (session.kind === 'error') return session;
  const checked = checkEnvelope(options.value, session.value.binding);
  if (checked.kind === 'error') return checked;
  if (checked.value.kind !== 'checkpoint' || !isRecord(options.value)) {
    return { kind: 'error', error: { code: 'invalid-reference' } };
  }
  const { sessionOpaque } = options.value;
  if (!isText(sessionOpaque, sessionLimits.opaqueLength)) {
    return { kind: 'error', error: { code: 'invalid-reference' } };
  }
  if (sessionOpaque !== session.value.opaque) return { kind: 'error', error: { code: 'session-mismatch' } };
  return {
    kind: 'ok',
    value: Object.freeze({ ...checked.value, kind: 'checkpoint', formatVersion: 1, sessionOpaque }),
  };
}

export interface SessionDiscoveryBounds {
  readonly maxResults: number;
  readonly maxExamined: number;
  readonly maxDurationMs: number;
}

export function validateSessionDiscoveryBounds(value: unknown): Outcome<SessionDiscoveryBounds, {
  readonly code: 'invalid-bounds';
}> {
  if (isRecord(value)) {
    const { maxResults, maxExamined, maxDurationMs } = value;
    const valid = (bound: unknown, ceiling: number): bound is number =>
      typeof bound === 'number' && Number.isSafeInteger(bound) && bound > 0 && bound <= ceiling;
    if (valid(maxResults, sessionLimits.maxResults) && valid(maxExamined, sessionLimits.maxExamined)
      && valid(maxDurationMs, sessionLimits.maxDurationMs) && maxResults <= maxExamined) {
      return { kind: 'ok', value: Object.freeze({ maxResults, maxExamined, maxDurationMs }) };
    }
  }
  return { kind: 'error', error: { code: 'invalid-bounds' } };
}

export interface SessionAccess<Scope> {
  readonly binding: SessionBinding;
  readonly scope: Scope;
  readonly bounds: SessionDiscoveryBounds;
  readonly signal: AbortSignal;
}

export interface SessionDiscoveryDiagnostic {
  readonly kind: 'file-inspection-failed';
  readonly subject: {
    readonly kind: 'discovery-file';
    readonly token: string;
  };
}

export type SessionDiscoveryPage = {
  readonly sessions: readonly SessionReference[];
  readonly examined: number;
  readonly skipped: { readonly corrupt: number; readonly inaccessible: number };
  readonly diagnostics: readonly SessionDiscoveryDiagnostic[];
} & (
  | { readonly kind: 'complete' }
  | { readonly kind: 'truncated'; readonly reason: 'results' | 'examined' | 'duration' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly code: 'inaccessible' | 'native-failure' }
);

export interface SessionOperationError {
  readonly code: 'invalid-input' | 'inaccessible' | 'native-failure' | 'cancelled' | 'bounds-exceeded';
}

export interface SessionDiscovery<Scope> {
  readonly discover: (options: SessionAccess<Scope>) => Promise<Outcome<SessionDiscoveryPage, SessionOperationError>>;
}

export type SessionInspectionResult =
  | { readonly kind: 'available'; readonly reference: SessionReference }
  | { readonly kind: 'absent' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'incompatible'; readonly reason: 'native-version' | 'native-format' };

export interface SessionInspection<Scope> {
  readonly inspect: (options: SessionAccess<Scope> & {
    readonly reference: SessionReference;
  }) => Promise<Outcome<SessionInspectionResult, SessionOperationError>>;
}
