import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Outcome } from '../../core/contracts.js';
import { discoverFiles, fileDiscoveryLimits } from '../../core/discovery.js';
import { copyBinding, parseSessionReference, sessionLimits, validateSessionDiscoveryBounds } from '../../core/sessions.js';
import type { SessionAccess, SessionBinding, SessionDiscovery, SessionDiscoveryBounds, SessionDiscoveryDiagnostic,
  SessionDiscoveryPage, SessionInspection, SessionInspectionResult, SessionOperationError, SessionReference,
  SessionReferenceError } from '../../core/sessions.js';
import { codexRoutePrincipal, copyCodexRoute } from './route.js';
import type { CodexProxyRoute } from './route.js';
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
  /**
   * The host-selected LiteLLM proxy route this app-server runs under, if any. Absent: direct mode, the requester is the
   * native login. Present: the requester is the host-asserted route principal (route.ts); an invalid route is
   * `invalid-input` before any native request. A host runs one mode per Codex home: the writer registry keys by the
   * complete reference, so a routed and a direct app-server over one home would not exclude each other's writers.
   */
  readonly route?: CodexProxyRoute;
}
/** The only app-server methods this module sends. Every one is a read; none dispatches, resumes or writes. */
export const codexSessionMethods = Object.freeze(['config/read', 'account/read', 'getConversationSummary', 'thread/read'] as const);
type Method = typeof codexSessionMethods[number];
export type CodexNativeFormat = 'codex-thread/paginated' | 'codex-thread/legacy';
export type CodexResumePreparation =
  /** `provider` is the requester's effective native provider: the resume reply's `thread.modelProvider` must equal it. */
  | { readonly kind: 'ready'; readonly reference: SessionReference; readonly threadId: string; readonly provider: string }
  | Exclude<SessionInspectionResult, { readonly kind: 'available' }>;
type Access = SessionAccess<CodexSessionScope>;
type Run = { readonly home: string; readonly request: CodexSessionScope['request']; readonly bounds: SessionDiscoveryBounds;
  readonly signal: AbortSignal; readonly deadline: number; readonly route: CodexProxyRoute | undefined };
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
    const { scope: { home, request, initialize, route: rawRoute }, bounds: rawBounds, signal } = options;
    const bounds = validateSessionDiscoveryBounds(rawBounds);
    const route = rawRoute === undefined ? undefined : copyCodexRoute(rawRoute);
    if (rawRoute !== undefined && !route) return undefined;
    if (!text(home) || !isAbsolute(home) || home !== resolve(home)
      || !record(initialize) || initialize.codexHome !== home || typeof request !== 'function' || !(signal instanceof AbortSignal) || bounds.kind === 'error') return undefined;
    return { home, request: request as Run['request'], bounds: bounds.value, signal,
      deadline: performance.now() + bounds.value.maxDurationMs, route };
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
 * The native provider entry must be exactly the host route with command auth only (codex-native-api.md, Proxy-routed
 * requester): `config/read` echoes `base_url` verbatim and lists no built-in provider (`ollama`, `openai`), so a
 * built-in id, another endpoint, another wire API, or an env-key or static bearer credential is refused. Native
 * multi-agent must be pinned off as `codexProxyConfig` sets it (`config.features.multi_agent` and `multi_agent_v2`
 * both `false`; native omits an unset feature), since a sub-agent's `spawn_agent` `model` bypasses the route model.
 * The sandbox must be `read-only` (the `codexProxyConfig` pin) or `workspace-write`, never `danger-full-access`, with
 * `network_access` `false` and no `default_permissions`, since a networked shell can take route tokens from the broker.
 */
function routedProvider(settings: Record<string, unknown>, route: CodexProxyRoute): boolean {
  if (!record(settings.features) || settings.features.multi_agent !== false
    || settings.features.multi_agent_v2 !== false) return false;
  if (!['read-only', 'workspace-write'].includes(String(settings.sandbox_mode)) || !record(settings.sandbox_workspace_write)
    || settings.sandbox_workspace_write.network_access !== false || settings.default_permissions != null) return false;
  if (settings.model_provider !== route.providerId || !record(settings.model_providers)
    || !Object.hasOwn(settings.model_providers, route.providerId)) return false;
  const entry = settings.model_providers[route.providerId];
  return record(entry) && entry.base_url === route.endpoint && entry.wire_api === 'responses' && record(entry.auth)
    && typeof entry.auth.command === 'string' && entry.requires_openai_auth === false
    && entry.env_key == null && entry.experimental_bearer_token == null;
}
/**
 * The provider native runs this app-server's threads on: `config/read` `model_provider`, or Codex's default `openai`
 * when it is absent or null (codex-native-api.md, Proxy-routed requester). Anything else is unreadable.
 */
function effectiveProvider(settings: Record<string, unknown>): string | undefined {
  const provider = settings.model_provider;
  return provider == null ? 'openai' : text(provider) ? provider : undefined;
}
/** The binding principal and the effective native provider every admitted thread must run on. */
type Requester = { readonly principal: string; readonly provider: string };
/**
 * Write-safety and requester precondition. Discovery writes nothing to history only with a private index
 * (codex-discovery.md, Storage and authorization boundary). The requester is the current native login
 * (`chatgpt:<userId>` or `apiKey`); it never attributes a thread's creator. Every API key is the one principal `apiKey`,
 * so a change between API keys has no native signal and is unqualified. Native paths are compared after `resolve`;
 * symlink and case aliasing of the index stay host obligations.
 *
 * Routed (`run.route`): native reports no login for provider command auth (codex-native-api.md, Proxy-routed requester),
 * so the requester is the route principal, admitted only while `config/read` names the route's provider with an entry
 * matching the route with multi-agent pinned off (routedProvider) and `account/read` reports no account and
 * `requiresOpenaiAuth: false`. A native login under a route is refused, never used as a fallback: the prefix keeps
 * routed and direct principals disjoint.
 *
 * Both modes also yield the effective provider. Native resumes and runs a thread on its own `Thread.modelProvider`
 * whatever the app-server's default, with that provider's credentials, so every caller admits only threads on it: a
 * direct requester never reaches a routed thread, nor a routed requester a direct one.
 */
async function requester(run: Run): Promise<Outcome<Requester, SessionOperationError>> {
  const config = await call(run, 'config/read', { includeLayers: false });
  if (typeof config === 'string') return failure(operation(config));
  const settings = config.kind === 'result' && record(config.value) ? config.value.config : undefined;
  if (!record(settings)) return failure('native-failure');
  for (const key of ['sqlite_home', 'log_dir']) {
    const path = settings[key];
    if (typeof path !== 'string' || !isAbsolute(path) || within(resolve(path), run.home)) return failure('invalid-input');
  }
  if (run.route && !routedProvider(settings, run.route)) return failure('inaccessible');
  const provider = effectiveProvider(settings);
  if (!provider) return failure('native-failure');
  const reply = await call(run, 'account/read', { refreshToken: false });
  if (typeof reply === 'string') return failure(operation(reply));
  if (reply.kind === 'error' || !record(reply.value)) return failure('native-failure');
  const { account, userId, requiresOpenaiAuth } = reply.value;
  if (run.route) {
    return account === null && requiresOpenaiAuth === false
      ? { kind: 'ok', value: { principal: codexRoutePrincipal(run.route), provider } } : failure('inaccessible');
  }
  const principal = !record(account) ? undefined : account.type === 'apiKey' ? 'apiKey'
    : account.type === 'chatgpt' && text(userId) ? `chatgpt:${userId}` : undefined;
  return text(principal) ? { kind: 'ok', value: { principal, provider } } : failure('inaccessible');
}

type Thread = { readonly format: CodexNativeFormat; readonly loaded: boolean; readonly provider: unknown };
function thread(value: unknown, id: string): Thread | undefined {
  const item = record(value) ? value.thread : undefined;
  if (!record(item) || item.id !== id || typeof item.historyMode !== 'string' || !record(item.status)) return undefined;
  const format = Object.hasOwn(historyModes, item.historyMode) ? historyModes[item.historyMode] : undefined;
  const status = item.status.type;
  return format && typeof status === 'string' && statuses.has(status) ? { format, loaded: status !== 'notLoaded', provider: item.modelProvider }
    : undefined;
}
const reference = (binding: SessionBinding, opaque: string): SessionReference =>
  Object.freeze({ kind: 'session', formatVersion: 1, binding, opaque });

type BindOptions = Omit<Access, 'binding'> & { readonly nativeFormat: CodexNativeFormat };
/**
 * `bind` plus the requester's effective provider, for the execution owner (x9av): a `thread/start` reply whose
 * `thread.modelProvider` differs runs off the bound requester and must never become a session.
 */
export async function bindCodexRequester(options: BindOptions):
Promise<Outcome<{ readonly binding: SessionBinding; readonly provider: string }, SessionOperationError>> {
  const run = admit(options);
  let nativeFormat: unknown;
  try { nativeFormat = options.nativeFormat; } catch { return failure('invalid-input'); }
  if (!run || !isFormat(nativeFormat)) return failure('invalid-input');
  const account = await requester(run);
  if (account.kind === 'error') return account;
  return { kind: 'ok', value: { provider: account.value.provider, binding: Object.freeze({ engine, nativeVersion,
    account: account.value.principal, authorizedScope: run.home, nativeFormat }) } };
}
async function bind(options: BindOptions): Promise<Outcome<SessionBinding, SessionOperationError>> {
  const bound = await bindCodexRequester(options);
  return bound.kind === 'ok' ? { kind: 'ok', value: bound.value.binding } : bound;
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
  if (account.value.principal !== binding.account) return failure('inaccessible');
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
      // Only threads on the requester's provider: a routed thread is not listed to a direct requester, nor the reverse.
      if (found.format === binding.nativeFormat && found.provider === account.value.provider) {
        sessions.push(reference(binding, id));
      }
    }
  }
  return page(ending, listed.examined, listed.skipped.inaccessible);
}

/** Known-target inspection. Every call rereads native state; nothing from discovery is trusted or reserved. */
async function examine(run: Run, value: unknown, binding: SessionBinding, requesterMismatch: 'inaccessible' | 'binding-mismatch'):
Promise<Outcome<{ readonly result: SessionInspectionResult; readonly provider: string },
  SessionOperationError | SessionReferenceError>> {
  const parsed = parseSessionReference({ value, expected: binding });
  if (parsed.kind === 'error') return parsed;
  const threadId = parsed.value.opaque;
  if (!uuid.test(threadId)) return { kind: 'error', error: Object.freeze({ code: 'invalid-reference' }) };
  const account = await requester(run);
  if (account.kind === 'error') return account;
  if (account.value.principal !== binding.account) return { kind: 'error', error: Object.freeze({ code: requesterMismatch }) };
  const { provider } = account.value;
  const ok = (result: SessionInspectionResult) => ({ kind: 'ok', value: { result: Object.freeze(result), provider } }) as const;
  const read = await call(run, 'thread/read', { threadId, includeTurns: false });
  if (typeof read === 'string') return failure(operation(read));
  if (read.kind === 'error') {
    // Qualified absent signal only: -32600 with this exact message (codex-discovery.md Known-target read).
    return read.code === -32600 && read.message === `thread not loaded: ${threadId}`
      ? ok({ kind: 'absent' }) : failure('native-failure');
  }
  const found = thread(read.value, threadId);
  if (!found) return failure('native-failure');
  // A thread native created on another provider would resume there (Thread.modelProvider) with that provider's
  // credentials, off this requester; a missing provider is refused the same way.
  if (found.provider !== provider) return failure('inaccessible');
  if (found.format !== binding.nativeFormat) return ok({ kind: 'incompatible', reason: 'native-format' });
  // Loaded in this app-server process: a resume would rejoin it rather than open a quiescent session.
  if (found.loaded) return ok({ kind: 'busy' });
  return ok({ kind: 'available', reference: parsed.value });
}

async function inspect(options: Access & { readonly reference: SessionReference }):
Promise<Outcome<SessionInspectionResult, SessionOperationError>> {
  const run = admit(options);
  const binding = run && bound(run, options);
  if (!run || !binding) return failure('invalid-input');
  const result = await examine(run, options.reference, binding, 'inaccessible');
  if (result.kind === 'ok') return { kind: 'ok', value: result.value.result };
  const { code } = result.error;
  return code === 'invalid-reference' || code === 'unsupported-version' || code === 'binding-mismatch'
    || code === 'session-mismatch' ? failure('invalid-input') : failure(code);
}

/**
 * Resume preparation: revalidates the persisted reference against the access binding, rechecks the native requester,
 * private index and availability immediately before use, and returns only the exact native identity. It dispatches
 * nothing and reserves nothing: enumeration and preparation hold no writer. The execution owner (x9av) must take its
 * writer reservation, keyed by the complete validated reference, before calling; it then sends `thread/resume` with
 * `threadId` only and must reject a reply whose `thread.id` differs, so no new session is ever silently substituted,
 * or whose `thread.modelProvider` is not the returned `provider`, so the thread never runs off the bound requester.
 */
async function prepareResume(options: Access & { readonly reference: unknown }):
Promise<Outcome<CodexResumePreparation, SessionOperationError | SessionReferenceError>> {
  const run = admit(options);
  const binding = run && bound(run, options);
  if (!run || !binding) return failure('invalid-input');
  const result = await examine(run, options.reference, binding, 'binding-mismatch');
  if (result.kind === 'error') return result;
  const { result: inspected, provider } = result.value;
  if (inspected.kind !== 'available') return { kind: 'ok', value: inspected };
  if (binding.nativeFormat !== resumable) return { kind: 'ok', value: Object.freeze({ kind: 'incompatible', reason: 'native-format' }) };
  const { reference: ready } = inspected;
  return { kind: 'ok', value: Object.freeze({ kind: 'ready', reference: ready, threadId: ready.opaque, provider }) };
}

export const codexSessions = Object.freeze({ bind, discover, inspect, prepareResume }) satisfies
  SessionDiscovery<CodexSessionScope> & SessionInspection<CodexSessionScope>;
