import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthError, AuthRoute, ScopedAuth } from '../../core/auth.js';
import type { Outcome } from '../../core/contracts.js';
import { checkCodexRoute } from './route.js';

/** The provider `auth.command` Codex runs for a token: never a secret, only the helper and its broker socket. */
export interface CodexHelperCommand {
  readonly command: string;
  readonly args: readonly string[];
}
export interface CodexProxyOptions {
  /**
   * The host's LiteLLM `AuthRoute`: `model` is the host-selected LiteLLM model name, sent verbatim. `headers` must be
   * absent or empty: no native Codex provider header key is qualified, and static header values would sit in config.
   */
  readonly auth: Pick<AuthRoute, 'model' | 'headers'>;
  /** `CodexCredentialBroker.helper` of the broker that serves this app-server. */
  readonly helper: CodexHelperCommand;
  /** Native `auth.timeout_ms`, 1-60000; default 5000. */
  readonly timeoutMs?: number;
  /** Native `auth.refresh_interval_ms`: proactive renewal, 1000-86400000; default 300000. A 401 always renews once. */
  readonly refreshIntervalMs?: number;
}
export type CodexProxyValue = string | number | boolean | readonly string[];
export interface CodexProxyConfig {
  /** Dotted native config keys and their values, in the order the args carry them. */
  readonly overrides: Readonly<Record<string, CodexProxyValue>>;
  /** `-c key=<JSON>` pairs the host appends to `codex app-server` (JSON scalars and string arrays are TOML values). */
  readonly args: readonly string[];
}

function clean(value: unknown, limit = 4096): value is string {
  // Lone surrogates would be JSON-escaped into invalid TOML.
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > limit || /\p{Cs}/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
const whole = (value: unknown, min: number, max: number, fallback: number): number | undefined =>
  value === undefined ? fallback : Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? value as number : undefined;

/**
 * The `-c` overrides that put a Codex app-server on `route` with host-resolved command auth (codex-native-api.md,
 * LiteLLM route). Exactly what sessions.ts `routedProvider` admits: no `env_key`, bearer token, ChatGPT or forced
 * login, or `openai_base_url`, so no subscription or stored-key passthrough; no retries, so a 401 renews once and fails.
 */
export function codexProxyConfig(route: unknown, options: CodexProxyOptions):
{ readonly config: CodexProxyConfig } | { readonly problem: string } {
  try {
    const checked = checkCodexRoute(route);
    if ('problem' in checked) return checked;
    const { providerId, endpoint } = checked.route;
    const { auth, helper } = options;
    const model = auth.model;
    const headers = auth.headers;
    if (!clean(model, 256)) return { problem: 'model must be a non-blank LiteLLM model name of at most 256 characters without control characters' };
    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Object.keys(headers).length > 0)) {
      return { problem: 'auth headers are refused: no native Codex provider header key is qualified for a LiteLLM route' };
    }
    const command = helper.command;
    const args = Array.isArray(helper.args) ? [...helper.args as readonly unknown[]] : undefined;
    if (!clean(command) || !isAbsolute(command) || !args || args.length > 8 || !args.every((arg) => clean(arg))) {
      return { problem: 'helper must be an absolute command with at most 8 plain arguments' };
    }
    const timeout = whole(options.timeoutMs, 1, 60000, 5000);
    const refresh = whole(options.refreshIntervalMs, 1000, 86400000, 300000);
    if (timeout === undefined || refresh === undefined) return { problem: 'timeoutMs or refreshIntervalMs is out of range' };
    const at = `model_providers.${providerId}`;
    const overrides: Record<string, CodexProxyValue> = { model_provider: providerId, model,
      [`${at}.name`]: 'LiteLLM', [`${at}.base_url`]: endpoint, [`${at}.wire_api`]: 'responses',
      [`${at}.supports_websockets`]: false, [`${at}.request_max_retries`]: 0, [`${at}.stream_max_retries`]: 0,
      [`${at}.requires_openai_auth`]: false, [`${at}.auth.command`]: command, [`${at}.auth.args`]: Object.freeze(args as string[]),
      [`${at}.auth.timeout_ms`]: timeout, [`${at}.auth.refresh_interval_ms`]: refresh };
    return { config: Object.freeze({ overrides: Object.freeze(overrides),
      args: Object.freeze(Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])) }) };
  } catch { return { problem: 'proxy options could not be read' }; }
}

/** Fixed bounds: concurrent helper connections, token bytes, and one connection's lifetime. */
export const codexBrokerLimits = Object.freeze({ maxConnections: 4, maxTokenBytes: 65536, connectionTimeoutMs: 10000 });
export interface CodexCredentialBroker {
  readonly helper: CodexHelperCommand;
  /** Stops serving, aborts pending resolutions and removes the socket and its directory. Idempotent. */
  close(): Promise<void>;
}
const helperPath = fileURLToPath(new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? 'proxy-helper.ts' : 'proxy-helper.js', import.meta.url));
const refused = (code: AuthError['code']): Outcome<never, AuthError> =>
  ({ kind: 'error', error: Object.freeze({ code, message: 'The credential broker could not start.' }) });

/**
 * Serves one host-resolved LiteLLM token per helper connection on a unix socket in a fresh 0700 directory. Each
 * connection is one native request boundary: `resolve` runs with a new `requestId`, never cached. A failed, aborted,
 * header-carrying or oversized resolution, or one for another endpoint or model than the app-server's (the `route.endpoint`
 * and model given to `codexProxyConfig`), writes nothing, so the helper fails. One broker per app-server: brokers share
 * nothing. Same-user processes that can reach the directory can ask for tokens; the host owns that boundary.
 */
export async function startCodexCredentialBroker(auth: ScopedAuth<unknown>,
  options: { readonly invocationId: string; readonly endpoint: string; readonly model: string; readonly signal: AbortSignal }):
Promise<Outcome<CodexCredentialBroker, AuthError>> {
  let invocationId: string; let endpoint: string; let model: string; let signal: AbortSignal; let resolve: ScopedAuth<unknown>['resolve'];
  try {
    ({ invocationId, endpoint, model, signal } = options);
    resolve = auth.resolve;
    if (!clean(invocationId, 1024) || !clean(endpoint, 8192) || !clean(model, 256) || !(signal instanceof AbortSignal)
      || typeof resolve !== 'function') return refused('invalid-config');
  } catch { return refused('invalid-config'); }
  if (signal.aborted) return refused('aborted');
  let dir: string;
  try { dir = await mkdtemp(join(tmpdir(), 'sb-codex-broker-')); } catch { return refused('credential-unavailable'); }
  const socketPath = join(dir, 's');
  const stop = new AbortController();
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const ended = new AbortController();
    socket.setTimeout(codexBrokerLimits.connectionTimeoutMs, () => socket.destroy());
    socket.on('data', () => socket.destroy()).on('error', () => {}).on('close', () => { sockets.delete(socket); ended.abort(); });
    const requestSignal = AbortSignal.any([signal, stop.signal, ended.signal]);
    // The request is an empty half-close: any payload byte drops the connection unserved.
    socket.once('end', () => void (async () => {
      let token = '';
      try {
        const resolved = await resolve.call(auth, { boundary: 'request', invocationId, requestId: randomUUID() }, requestSignal);
        const value = resolved.kind === 'ok' ? resolved.value : undefined;
        if (value?.kind === 'litellm' && value.endpoint === endpoint && value.model === model && (value.headers === undefined || Object.keys(value.headers).length === 0)
          && Buffer.byteLength(value.material.token) <= codexBrokerLimits.maxTokenBytes) token = value.material.token;
      } catch { /* nothing is written */ }
      if (!socket.destroyed && !requestSignal.aborted) socket.end(token);
    })());
  });
  server.maxConnections = codexBrokerLimits.maxConnections;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    stop.abort();
    signal.removeEventListener('abort', onAbort);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  })();
  const onAbort = () => { void close(); };
  try {
    await chmod(dir, 0o700);
    await new Promise<void>((done, fail) => server.once('error', fail).listen(socketPath, () => done()));
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return refused('credential-unavailable');
  }
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) { await close(); return refused('aborted'); }
  return { kind: 'ok', value: Object.freeze({ close,
    helper: Object.freeze({ command: process.execPath, args: Object.freeze([helperPath, socketPath]) }) }) };
}
