import { isAbsolute, resolve } from 'node:path';
import { validateSessionDiscoveryBounds } from '#switchboard';
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

function plain(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function bindingOf(value: SessionBinding): SessionBinding | undefined {
  if (!plain(value.engine) || !plain(value.nativeVersion) || !plain(value.account)
    || !plain(value.authorizedScope) || !plain(value.nativeFormat)) return undefined;
  return Object.freeze({
    engine: value.engine, nativeVersion: value.nativeVersion, account: value.account,
    authorizedScope: value.authorizedScope, nativeFormat: value.nativeFormat,
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
  let ending: SessionDiscoveryPage = overflow
    ? { kind: 'truncated', reason: 'examined', sessions, examined, skipped: { corrupt, inaccessible: 0 }, diagnostics: [] }
    : { kind: 'complete', sessions, examined, skipped: { corrupt, inaccessible: 0 }, diagnostics: [] };
  for (const record of records) {
    if (input.signal.aborted) return failure('cancelled');
    if (performance.now() - started >= bounds.value.maxDurationMs) {
      ending = { kind: 'truncated', reason: 'duration', sessions, examined, skipped: { corrupt, inaccessible: 0 }, diagnostics: [] };
      break;
    }
    if (sessions.length >= bounds.value.maxResults) {
      ending = { kind: 'truncated', reason: 'results', sessions, examined, skipped: { corrupt, inaccessible: 0 }, diagnostics: [] };
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
