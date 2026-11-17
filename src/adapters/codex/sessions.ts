import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Outcome } from '../../core/contracts.js';
import { discoverFiles, fileDiscoveryLimits } from '../../core/discovery.js';
import { copyBinding, parseSessionReference, sessionLimits, validateSessionDiscoveryBounds } from '../../core/sessions.js';
import type { SessionAccess, SessionBinding, SessionDiscovery, SessionDiscoveryBounds, SessionDiscoveryDiagnostic,
  SessionDiscoveryPage, SessionInspection, SessionInspectionResult, SessionOperationError, SessionReference,
  SessionReferenceError } from '../../core/sessions.js';
import type { CodexTransport } from './transport.js';

/**
 * Host-authorized Codex history scope. The host owns the app-server process, its private `sqlite_home` and `log_dir`,
 * shutdown, credentials, and a stable namespace for `home` for the whole call. This module never closes or retries.
 */
export interface CodexSessionScope {
  /** Absolute `$CODEX_HOME` served by the borrowed app-server. It is also `binding.authorizedScope`. */
  readonly home: string;
  /** Borrowed `CodexTransport.request` of an initialized app-server connection. */
  readonly request: CodexTransport['request'];
  /**
   * The host's `initialize` result for that connection. Its typed `codexHome` must equal `home`. The server version is
   * only inside the untyped `userAgent` text, so it is not checked here; `nativeVersion` is pinned by the binding.
   */
  readonly initialize: { readonly codexHome: string };
}
/** The only app-server methods this module sends. Every one is a read; none dispatches, resumes or writes. */
export const codexSessionMethods = Object.freeze(['config/read', 'account/read', 'getConversationSummary', 'thread/read'] as const);
type Method = typeof codexSessionMethods[number];
export type CodexNativeFormat = 'codex-thread/paginated' | 'codex-thread/legacy';
export type CodexResumePreparation =
  | { readonly kind: 'ready'; readonly reference: SessionReference; readonly threadId: string }
  | Exclude<SessionInspectionResult, { readonly kind: 'available' }>;
type Access = SessionAccess<CodexSessionScope>;
type Run = { readonly home: string; readonly request: CodexSessionScope['request']; readonly bounds: SessionDiscoveryBounds;
  readonly signal: AbortSignal; readonly deadline: number };
type Reply = { readonly kind: 'result'; readonly value: unknown } | { readonly kind: 'error'; readonly code: number; readonly message: string };
type Stop = 'cancelled' | 'duration' | 'failed';
type Ending = { readonly kind: 'complete' } | { readonly kind: 'cancelled' }
  | { readonly kind: 'truncated'; readonly reason: 'results' | 'examined' | 'duration' }
  | { readonly kind: 'failed'; readonly code: 'inaccessible' | 'native-failure' };

const engine = 'codex';
const nativeVersion = '0.169.0';
const historyModes: Readonly<Record<string, CodexNativeFormat>> = { paginated: 'codex-thread/paginated', legacy: 'codex-thread/legacy' };
/** Exact resume is qualified only for paginated history (codex-native-api.md Resume; ajqy read Legacy history only). */
const resumable: CodexNativeFormat = 'codex-thread/paginated';
const statuses = new Set(['notLoaded', 'idle', 'active', 'systemError']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const failure = (code: SessionOperationError['code']): Outcome<never, SessionOperationError> =>
  ({ kind: 'error', error: Object.freeze({ code }) });
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > sessionLimits.identifierLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function within(path: string, home: string): boolean {
  return path === home || path.startsWith(home.endsWith(sep) ? home : `${home}${sep}`);
}

/** Copies and checks host input once; getters that throw are invalid input. `home` must be canonical (`resolve`d). */
function admit(options: unknown): Run | undefined {
  try {
    if (!record(options) || !record(options.scope)) return undefined;
    const { scope: { home, request, initialize }, bounds: rawBounds, signal } = options;
    const bounds = validateSessionDiscoveryBounds(rawBounds);
    if (!text(home) || !isAbsolute(home) || home !== resolve(home)
      || !record(initialize) || initialize.codexHome !== home || typeof request !== 'function' || !(signal instanceof AbortSignal) || bounds.kind === 'error') return undefined;
    return { home, request: request as Run['request'], bounds: bounds.value, signal,
      deadline: performance.now() + bounds.value.maxDurationMs };
  } catch { return undefined; }
}
const isFormat = (value: unknown): value is CodexNativeFormat => Object.values(historyModes).includes(value as CodexNativeFormat);
function bound(run: Run, options: unknown): SessionBinding | undefined {
  try {
    const binding = copyBinding(record(options) ? options.binding : undefined);
    return binding?.engine === engine && binding.nativeVersion === nativeVersion && binding.authorizedScope === run.home
      && isFormat(binding.nativeFormat) ? binding : undefined;
  } catch { return undefined; }
}

/**
 * One read-only request under the caller's signal and the remaining call budget. Never retried. The transport's own
 * failure reason separates an abort from a fatal channel failure; only an abort consults which signal fired.
 */
async function call(run: Run, method: Method, params: unknown): Promise<Reply | Stop> {
  const remaining = run.deadline - performance.now();
  if (run.signal.aborted) return 'cancelled';
  if (remaining <= 0) return 'duration';
  try {
    const exchange = await run.request({ method, params }, AbortSignal.any([run.signal, AbortSignal.timeout(Math.ceil(remaining))]));
    if (exchange.kind !== 'reply') {
      if (exchange.reason !== 'aborted') return 'failed';
      return run.signal.aborted ? 'cancelled' : 'duration';
    }
    const reply = exchange.envelope.reply;
    return reply.kind === 'result' ? { kind: 'result', value: reply.value }
      : { kind: 'error', code: reply.error.code, message: reply.error.message };
  } catch { return 'failed'; }
}
const operation = (stop: Stop): SessionOperationError['code'] =>
  stop === 'cancelled' ? 'cancelled' : stop === 'duration' ? 'bounds-exceeded' : 'native-failure';

/**
 * Write-safety and requester precondition. Discovery writes nothing to history only with a private index
 * (codex-discovery.md, Storage and authorization boundary). The requester is the current native login
 * (`chatgpt:<userId>` or `apiKey`); it never attributes a thread's creator. Every API key is the one principal `apiKey`,
 * so a change between API keys has no native signal and is unqualified. Native paths are compared after `resolve`;
 * symlink and case aliasing of the index stay host obligations.
 */
async function requester(run: Run): Promise<Outcome<string, SessionOperationError>> {
  const config = await call(run, 'config/read', { includeLayers: false });
  if (typeof config === 'string') return failure(operation(config));
  const settings = config.kind === 'result' && record(config.value) ? config.value.config : undefined;
  if (!record(settings)) return failure('native-failure');
  for (const key of ['sqlite_home', 'log_dir']) {
    const path = settings[key];
    if (typeof path !== 'string' || !isAbsolute(path) || within(resolve(path), run.home)) return failure('invalid-input');
  }
  const reply = await call(run, 'account/read', { refreshToken: false });
  if (typeof reply === 'string') return failure(operation(reply));
  if (reply.kind === 'error' || !record(reply.value)) return failure('native-failure');
  const { account, userId } = reply.value;
  const principal = !record(account) ? undefined : account.type === 'apiKey' ? 'apiKey'
    : account.type === 'chatgpt' && text(userId) ? `chatgpt:${userId}` : undefined;
  return text(principal) ? { kind: 'ok', value: principal } : failure('inaccessible');
}

type Thread = { readonly format: CodexNativeFormat; readonly loaded: boolean };
function thread(value: unknown, id: string): Thread | undefined {
  const item = record(value) ? value.thread : undefined;
  if (!record(item) || item.id !== id || typeof item.historyMode !== 'string' || !record(item.status)) return undefined;
  const format = Object.hasOwn(historyModes, item.historyMode) ? historyModes[item.historyMode] : undefined;
  const status = item.status.type;
  return format && typeof status === 'string' && statuses.has(status) ? { format, loaded: status !== 'notLoaded' } : undefined;
}
const reference = (binding: SessionBinding, opaque: string): SessionReference =>
  Object.freeze({ kind: 'session', formatVersion: 1, binding, opaque });

async function bind(options: Omit<Access, 'binding'> & { readonly nativeFormat: CodexNativeFormat }):
Promise<Outcome<SessionBinding, SessionOperationError>> {
  const run = admit(options);
  let nativeFormat: unknown;
  try { nativeFormat = options.nativeFormat; } catch { return failure('invalid-input'); }
  if (!run || !isFormat(nativeFormat)) return failure('invalid-input');
  const account = await requester(run);
  if (account.kind === 'error') return account;
  return { kind: 'ok', value: Object.freeze({ engine, nativeVersion, account: account.value, authorizedScope: run.home,
    nativeFormat }) };
}

/**
 * Inventory of admitted regular files under `<home>/sessions` (no file is opened), then public path summary and
 * metadata-only read for each. Archived history, listing filters and private formats are not used.
 */
async function discover(options: Access): Promise<Outcome<SessionDiscoveryPage, SessionOperationError>> {
  const run = admit(options);
  const binding = run && bound(run, options);
  if (!run || !binding) return failure('invalid-input');
  // Host admission of the tree precedes every native request; an absent tree is still an empty authorized history.
  const root = join(run.home, 'sessions');
  let absent = false;
  try { if (!(await lstat(root)).isDirectory()) return failure('inaccessible'); } catch (error) {
    if (!record(error) || error.code !== 'ENOENT') return failure('inaccessible');
    absent = true;
  }
  const account = await requester(run);
  if (account.kind === 'error') return account;
  if (account.value !== binding.account) return failure('inaccessible');
  const names: string[] = [];
  const sessions: SessionReference[] = [];
  const diagnostics: SessionDiscoveryDiagnostic[] = [];
  const seen = new Set<string>();
  const page = (ending: Ending, examined: number, inaccessible: number): Outcome<SessionDiscoveryPage, SessionOperationError> =>
    ({ kind: 'ok', value: Object.freeze({ ...ending, sessions: Object.freeze(sessions), examined,
      skipped: Object.freeze({ corrupt: 0, inaccessible }), diagnostics: Object.freeze(diagnostics) }) });
  if (absent) return page({ kind: 'complete' }, 0, 0);
  const remaining = Math.floor(run.deadline - performance.now());
  if (run.signal.aborted) return failure('cancelled');
  if (remaining < 1) return failure('bounds-exceeded');
  // List-only use of the core walker: selectFile records every regular file and opens none, so no byte is ever read
  // and the byte bounds are only the validator's minimum.
  const files = await discoverFiles<never>({ scope: { binding, root, namespace: 'host-stable' }, expected: binding,
    bounds: { ...run.bounds, maxDurationMs: remaining, maxDepth: fileDiscoveryLimits.maxDepth, maxFileBytes: 1, maxTotalBytes: 1 },
    signal: run.signal, selectFile: (name) => { names.push(name); return false; }, decode: () => ({ kind: 'skip' }) });
  if (files.kind === 'error') return failure(files.error.code === 'inaccessible-root' ? 'inaccessible' : 'native-failure');
  const listed = files.value;
  // Depth or byte stops have no core reason; they are never reported as complete.
  let ending: Ending = listed.kind !== 'truncated' ? { kind: listed.kind }
    : listed.reason === 'depth' || listed.reason === 'bytes' ? { kind: 'failed', code: 'native-failure' }
      : { kind: 'truncated', reason: listed.reason };
  const stopped = (stop: Stop): Ending => stop === 'cancelled' ? { kind: 'cancelled' }
    : stop === 'duration' ? { kind: 'truncated', reason: 'duration' } : { kind: 'failed', code: 'native-failure' };
  const diagnose = () => { diagnostics.push(Object.freeze({ kind: 'file-inspection-failed',
    subject: Object.freeze({ kind: 'discovery-file', token: `file-${diagnostics.length + 1}` }) })); };
  if (ending.kind === 'complete' || (ending.kind === 'truncated' && ending.reason === 'examined')) {
    // Directory order is filesystem-defined (APFS and ext4 differ). Code-unit order makes the native call sequence,
    // which path of a hard-linked pair is read, result order and diagnostic tokens the same for the same admitted set.
    // Which entries an examined-truncated listing admitted still follows directory order.
    names.sort(); // UTF-16 code-unit order
    for (const name of names) {
      if (sessions.length >= run.bounds.maxResults) { ending = { kind: 'truncated', reason: 'results' }; break; }
      const rolloutPath = join(root, name);
      const summary = await call(run, 'getConversationSummary', { rolloutPath });
      if (typeof summary === 'string') { ending = stopped(summary); break; }
      const item = summary.kind === 'result' && record(summary.value) ? summary.value.summary : undefined;
      const id = record(item) && item.path === rolloutPath && typeof item.conversationId === 'string'
        && uuid.test(item.conversationId) ? item.conversationId : undefined;
      if (!id) { diagnose(); continue; }
      if (seen.has(id)) continue;
      const read = await call(run, 'thread/read', { threadId: id, includeTurns: false });
      if (typeof read === 'string') { ending = stopped(read); break; }
      const found = read.kind === 'result' ? thread(read.value, id) : undefined;
      if (!found) { diagnose(); continue; }
      seen.add(id);
      if (found.format === binding.nativeFormat) sessions.push(reference(binding, id));
    }
  }
  return page(ending, listed.examined, listed.skipped.inaccessible);
}

/** Known-target inspection. Every call rereads native state; nothing from discovery is trusted or reserved. */
async function examine(run: Run, value: unknown, binding: SessionBinding, requesterMismatch: 'inaccessible' | 'binding-mismatch'):
Promise<Outcome<SessionInspectionResult, SessionOperationError | SessionReferenceError>> {
  const parsed = parseSessionReference({ value, expected: binding });
  if (parsed.kind === 'error') return parsed;
  const threadId = parsed.value.opaque;
  if (!uuid.test(threadId)) return { kind: 'error', error: Object.freeze({ code: 'invalid-reference' }) };
  const account = await requester(run);
  if (account.kind === 'error') return account;
  if (account.value !== binding.account) return { kind: 'error', error: Object.freeze({ code: requesterMismatch }) };
  const read = await call(run, 'thread/read', { threadId, includeTurns: false });
  if (typeof read === 'string') return failure(operation(read));
  if (read.kind === 'error') {
    // Qualified absent signal only: -32600 with this exact message (codex-discovery.md Known-target read).
    return read.code === -32600 && read.message === `thread not loaded: ${threadId}`
      ? { kind: 'ok', value: Object.freeze({ kind: 'absent' }) } : failure('native-failure');
  }
  const found = thread(read.value, threadId);
  if (!found) return failure('native-failure');
  if (found.format !== binding.nativeFormat) {
    return { kind: 'ok', value: Object.freeze({ kind: 'incompatible', reason: 'native-format' }) };
  }
  // Loaded in this app-server process: a resume would rejoin it rather than open a quiescent session.
  if (found.loaded) return { kind: 'ok', value: Object.freeze({ kind: 'busy' }) };
  return { kind: 'ok', value: Object.freeze({ kind: 'available', reference: parsed.value }) };
}

async function inspect(options: Access & { readonly reference: SessionReference }):
Promise<Outcome<SessionInspectionResult, SessionOperationError>> {
  const run = admit(options);
  const binding = run && bound(run, options);
  if (!run || !binding) return failure('invalid-input');
  const result = await examine(run, options.reference, binding, 'inaccessible');
  if (result.kind === 'ok') return result;
  const { code } = result.error;
  return code === 'invalid-reference' || code === 'unsupported-version' || code === 'binding-mismatch'
    || code === 'session-mismatch' ? failure('invalid-input') : failure(code);
}

/**
 * Resume preparation: revalidates the persisted reference against the access binding, rechecks the native requester,
 * private index and availability immediately before use, and returns only the exact native identity. It dispatches
 * nothing and reserves nothing: enumeration and preparation hold no writer. The execution owner (x9av) must take its
 * writer reservation, keyed by the complete validated reference, before calling; it then sends `thread/resume` with
 * `threadId` only and must reject a reply whose `thread.id` differs, so no new session is ever silently substituted.
 */
async function prepareResume(options: Access & { readonly reference: unknown }):
Promise<Outcome<CodexResumePreparation, SessionOperationError | SessionReferenceError>> {
  const run = admit(options);
  const binding = run && bound(run, options);
  if (!run || !binding) return failure('invalid-input');
  const result = await examine(run, options.reference, binding, 'binding-mismatch');
  if (result.kind === 'error') return result;
  if (result.value.kind !== 'available') return { kind: 'ok', value: result.value };
  if (binding.nativeFormat !== resumable) return { kind: 'ok', value: Object.freeze({ kind: 'incompatible', reason: 'native-format' }) };
  const { reference: ready } = result.value;
  return { kind: 'ok', value: Object.freeze({ kind: 'ready', reference: ready, threadId: ready.opaque }) };
}

export const codexSessions = Object.freeze({ bind, discover, inspect, prepareResume }) satisfies
  SessionDiscovery<CodexSessionScope> & SessionInspection<CodexSessionScope>;
