import type { HostNativeError } from '../../core/host-adapter.js';

export function boundedCodexMessage(message: string): { readonly message: string; readonly truncated: boolean } {
  if (Buffer.byteLength(message) <= 2048) return { message, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const char of message) {
    bytes += Buffer.byteLength(char);
    if (bytes > 2048) break;
    end += char.length;
  }
  return { message: message.slice(0, end), truncated: true };
}
/** Native text is untrusted host data; never log it automatically. */
export function codexNativeError(source: HostNativeError['source'], raw: unknown): HostNativeError | undefined {
  if (typeof raw !== 'object' || raw === null || !('message' in raw) || typeof raw.message !== 'string') return undefined;
  const bounded = boundedCodexMessage(raw.message);
  let code: number | null = null;
  let info: unknown = null;
  let truncated = bounded.truncated;
  if (source === 'turn/start-reply') {
    if (!('code' in raw) || typeof raw.code !== 'number' || !Number.isSafeInteger(raw.code)) return undefined;
    code = raw.code;
  } else if ('codexErrorInfo' in raw && raw.codexErrorInfo !== null) {
    try {
      const json = JSON.stringify(raw.codexErrorInfo);
      if (json !== undefined && Buffer.byteLength(json) <= 1024) info = JSON.parse(json);
      else truncated = true;
    } catch { truncated = true; }
  }
  return Object.freeze({ source, code, message: bounded.message, info, truncated });
}

type ErrorIntake = { readonly kind: 'idle' }
  | { readonly kind: 'awaiting'; readonly previousId: string | undefined; readonly candidates: Map<string, HostNativeError> }
  | { readonly kind: 'identified'; readonly id: string; error: HostNativeError | undefined };
/** Retains a cause only after native acknowledgement establishes the exact turn identity. */
export function createCodexErrorIntake() {
  let state: ErrorIntake = { kind: 'idle' };
  return {
    begin() {
      state = { kind: 'awaiting', previousId: state.kind === 'identified' ? state.id : undefined, candidates: new Map() };
    },
    accepted(id: string) {
      if (state.kind === 'awaiting') state = { kind: 'identified', id, error: state.candidates.get(id) };
    },
    notification(params: unknown, threadId: string) {
      if (typeof params !== 'object' || params === null || !('threadId' in params) || params.threadId !== threadId
        || !('turnId' in params) || typeof params.turnId !== 'string' || !('willRetry' in params) || params.willRetry !== false
        || !('error' in params)) return;
      const cause = codexNativeError('error-notification', params.error);
      if (!cause) return;
      if (state.kind === 'identified' && state.id === params.turnId) state.error = cause;
      else if (state.kind === 'awaiting' && state.previousId !== params.turnId
        && (state.candidates.has(params.turnId) || state.candidates.size < 8)) state.candidates.set(params.turnId, cause);
    },
    current: () => state.kind === 'identified' ? state.error : undefined,
  };
}
