import type { AuthError } from './auth.js';
import type { AdapterError } from './contracts.js';

export type DiagnosticCode = AdapterError['code'] | AuthError['code'];
export type DiagnosticCategory =
  | 'error' | 'endpoint' | 'headers' | 'credentials' | 'checkpoint' | 'native-data';

export interface SafeError {
  readonly code: DiagnosticCode;
  readonly message: string;
}

export type SafeDiagnostic =
  | { readonly kind: 'error'; readonly error: SafeError }
  | { readonly kind: 'redacted'; readonly category: Exclude<DiagnosticCategory, 'error'> };

const messages = {
  unsupported: 'The operation is unsupported.',
  busy: 'The adapter is busy.',
  closed: 'The adapter is closed.',
  'invalid-input': 'The input is invalid.',
  'native-failure': 'The native operation failed.',
  'invalid-config': 'The authentication configuration is invalid.',
  'invalid-boundary': 'The authentication boundary is invalid.',
  'credential-unavailable': 'The credential is unavailable.',
  aborted: 'The operation was aborted.',
} satisfies Record<DiagnosticCode, string>;

const errors = new WeakMap<object, SafeError>();
const serialized = new WeakMap<object, string>();

function ownError(code: DiagnosticCode): SafeError {
  const error = Object.freeze({ code, message: messages[code] });
  errors.set(error, error);
  serialized.set(error, JSON.stringify({ kind: 'error', error }));
  return error;
}

function redacted(category: Exclude<DiagnosticCategory, 'error'>): SafeDiagnostic {
  const diagnostic = Object.freeze({ kind: 'redacted', category });
  serialized.set(diagnostic, JSON.stringify(diagnostic));
  return diagnostic;
}

const nativeFailure = ownError('native-failure');
const nativeData = redacted('native-data');
const hidden = {
  endpoint: redacted('endpoint'),
  headers: redacted('headers'),
  credentials: redacted('credentials'),
  checkpoint: redacted('checkpoint'),
  'native-data': nativeData,
};
const nativeDataJSON = '{"kind":"redacted","category":"native-data"}';

function isKey(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** Adapters assert a qualified domain condition here. Raw native codes are not evidence. */
export function createSafeError(code: DiagnosticCode): SafeError {
  if (typeof code !== 'string' || !Object.hasOwn(messages, code)) return nativeFailure;
  return ownError(code);
}

/** Only this module's exact error records retain provenance. Raw inputs are never inspected. */
export function normalizeError(value: unknown): SafeError {
  return (isKey(value) ? errors.get(value) : undefined) ?? nativeFailure;
}

export function summarizeDiagnostic(category: DiagnosticCategory, value: unknown): SafeDiagnostic {
  switch (category) {
    case 'error': {
      const error = normalizeError(value);
      const diagnostic = Object.freeze({ kind: 'error', error });
      serialized.set(diagnostic, serializeDiagnostic(error));
      return diagnostic;
    }
    case 'endpoint':
    case 'headers':
    case 'credentials':
    case 'checkpoint':
    case 'native-data': return hidden[category];
    default: return nativeData;
  }
}

/** Serializes owned projections only. It does not sanitize arbitrary host events. */
export function serializeDiagnostic(value: unknown): string {
  return (isKey(value) ? serialized.get(value) : undefined) ?? nativeDataJSON;
}
