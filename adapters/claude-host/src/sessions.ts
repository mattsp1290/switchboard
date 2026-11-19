import { isAbsolute, resolve } from 'node:path';
import { sessionLimits, validateSessionDiscoveryBounds } from '#switchboard';
import type {
  Outcome, SessionBinding, SessionDiscoveryBounds, SessionDiscoveryPage, SessionOperationError, SessionReference,
} from '#switchboard';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One session row already read for a single directory. This type names no SDK package. */
export interface ClaudeListedSession {
  readonly sessionId: string;
  readonly summary: string;
  readonly lastModified: number;
}

export type ClaudeSessionRead =
  | { readonly kind: 'ok'; readonly sessions: readonly ClaudeListedSession[] }
  | { readonly kind: 'error'; readonly code: 'inaccessible' | 'native-failure' };

const failure = (code: SessionOperationError['code']): Outcome<SessionDiscoveryPage, SessionOperationError> =>
  ({ kind: 'error', error: { code } });

function plain(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0
    || value.length > sessionLimits.identifierLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function bindingOf(value: unknown): SessionBinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    engine?: unknown; nativeVersion?: unknown; account?: unknown;
    authorizedScope?: unknown; nativeFormat?: unknown;
  };
  if (!plain(candidate.engine) || !plain(candidate.nativeVersion) || !plain(candidate.account)
    || !plain(candidate.authorizedScope) || !plain(candidate.nativeFormat)) return undefined;
  return Object.freeze({
    engine: candidate.engine, nativeVersion: candidate.nativeVersion, account: candidate.account,
    authorizedScope: candidate.authorizedScope, nativeFormat: candidate.nativeFormat,
  });
}

/**
 * Lists sessions for one absolute directory. An empty page means the reader returned no rows. It does not prove that
 * a transcript is absent: the SDK omits a session that has no summary. `read` is asked for one more row than
 * `maxExamined` so a full page can be told from a longer directory.
 */
export async function discoverClaudeHostSessions(input: {
  readonly dir: string;
  readonly binding: SessionBinding;
  readonly bounds: SessionDiscoveryBounds;
  readonly signal: AbortSignal;
  readonly read: (dir: string, limit: number, signal: AbortSignal) => Promise<ClaudeSessionRead>;
}): Promise<Outcome<SessionDiscoveryPage, SessionOperationError>> {
  const bounds = validateSessionDiscoveryBounds(input.bounds);
  const binding = bindingOf(input.binding);
  if (bounds.kind === 'error' || !binding || !isAbsolute(input.dir) || resolve(input.dir) !== input.dir) return failure('invalid-input');
  if (input.signal.aborted) return failure('cancelled');
  const started = performance.now();
  let read: ClaudeSessionRead;
  try {
    read = await input.read(input.dir, bounds.value.maxExamined + 1, input.signal);
  } catch {
    return failure('native-failure');
  }
  if (read.kind === 'error') return failure(read.code);
  if (!Array.isArray(read.sessions)) return failure('native-failure');
  if (input.signal.aborted) return failure('cancelled');
  const overflow = read.sessions.length > bounds.value.maxExamined;
  const records = read.sessions.slice(0, bounds.value.maxExamined);
  const sessions: SessionReference[] = [];
  const seen = new Set<string>();
  let examined = 0;
  let corrupt = 0;
  type Ending = { readonly kind: 'complete' } | { readonly kind: 'truncated'; readonly reason: 'examined' | 'duration' | 'results' };
  let ending: Ending = overflow ? { kind: 'truncated', reason: 'examined' } : { kind: 'complete' };
  for (const record of records) {
    if (input.signal.aborted) return failure('cancelled');
    if (performance.now() - started >= bounds.value.maxDurationMs) {
      ending = { kind: 'truncated', reason: 'duration' };
      break;
    }
    if (sessions.length >= bounds.value.maxResults) {
      ending = { kind: 'truncated', reason: 'results' };
      break;
    }
    examined += 1;
    const id = typeof record?.sessionId === 'string' && uuid.test(record.sessionId) ? record.sessionId : undefined;
    const summary = typeof record?.summary === 'string' && record.summary.length > 0;
    const modified = typeof record?.lastModified === 'number' && Number.isSafeInteger(record.lastModified) && record.lastModified >= 0;
    if (!id || !summary || !modified) {
      corrupt += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    sessions.push(Object.freeze({ kind: 'session', formatVersion: 1, binding, opaque: id }));
  }
  return { kind: 'ok', value: Object.freeze({
    ...ending,
    sessions: Object.freeze(sessions),
    examined,
    skipped: Object.freeze({ corrupt, inaccessible: 0 }),
    diagnostics: Object.freeze([]),
  }) };
}
