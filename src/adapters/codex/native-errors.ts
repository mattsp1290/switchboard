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
