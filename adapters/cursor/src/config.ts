import { callerModelId } from '#switchboard';
import { isAbsolute, resolve } from 'node:path';

export interface CursorRuntimeOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly model: string;
}

/** Fixed refusal details, including the stack, never include native or caller data. */
export class CursorTextPolicyUnsupportedError extends Error {
  readonly code = 'cursor_policy_unsupported';
  constructor() {
    super('Cursor text policy is unsupported.');
    this.name = 'CursorTextPolicyUnsupportedError';
    this.stack = 'CursorTextPolicyUnsupportedError: Cursor text policy is unsupported.';
    Object.freeze(this);
  }
}

export interface CursorLocalOptions {
  readonly cwd: string;
  readonly settingSources: ['project'];
  readonly sandboxOptions: { readonly enabled: true };
  readonly enableAgentRetries: false;
  readonly storeDirectory: string;
}

/** Agent ids and joined tool-call ids. The character class stays narrower than the model id. */
export function callerAgentId(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256) return false;
  return textWithoutControls(value);
}

/** Rejects C0 controls. Tool names use the same loop with their own length rule. */
export function textWithoutControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) <= 31) return false;
  return true;
}


function apiKeyText(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 512) return false;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) <= 31) return false;
  return true;
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value);
}

/** Copies a validated options object. Later edits to the caller's object are not observed. */
export function readCursorOptions(value: unknown): CursorRuntimeOptions | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { cwd, sessionDirectory, apiKey, model } = value as Record<string, unknown>;
  if (!callerModelId(model) || !apiKeyText(apiKey) || !absolutePath(cwd) || !absolutePath(sessionDirectory)) return undefined;
  return { cwd: resolve(cwd), sessionDirectory: resolve(sessionDirectory), apiKey, model };
}

/** Local-agent fields shared by create and resume. `storeDirectory` is the store root, not a field on `local`. */
export function cursorLocalOptions(cwd: string, sessionDirectory: string): CursorLocalOptions {
  return {
    cwd: resolve(cwd),
    settingSources: ['project'],
    sandboxOptions: { enabled: true },
    enableAgentRetries: false,
    storeDirectory: resolve(sessionDirectory),
  };
}
