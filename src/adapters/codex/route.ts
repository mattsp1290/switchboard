import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { endpointValid } from '../../core/auth.js';
import { sessionLimits } from '../../core/sessions.js';

/**
 * Host-selected LiteLLM proxy route for a Codex app-server. The host configured `model_providers.<providerId>` with
 * this `base_url` and provider command auth; Switchboard never reads or writes native configuration. The route is a
 * host assertion, not proof: Switchboard does not verify the proxy's identity (as `ProxyCredential` purpose).
 */
export interface CodexProxyRoute {
  readonly kind: 'litellm-proxy';
  /** Native `model_providers` key; `config/read` must report it as `model_provider`. */
  readonly providerId: string;
  /**
   * Proxy base URL: the `endpointValid` rules of core auth, a path ending in `/v1`, and canonical WHATWG spelling
   * (`new URL(endpoint).href === endpoint`), so one route never has two principals through case or `..` aliases. The
   * host generates the native `base_url` verbatim from this string: `config/read` echoes it unnormalized.
   */
  readonly endpoint: string;
  readonly credentialPurpose: 'litellm-proxy';
  /**
   * Host-selected LiteLLM model name, sent verbatim (`plain`, at most 256). The only model a routed session may use:
   * execution.ts refuses any other `model` or `collaborationMode` unsent. Not part of the principal (codexRoutePrincipal).
   */
  readonly model: string;
  /** Stable host auth scope (`AuthScope.engine` and `.account`); session and adapter instance ids are not stable. */
  readonly scope: { readonly engine: string; readonly account: string };
}

/** Conservative native provider key: Codex config keys under `model_providers` (`openai`, `ollama`, `litellm`). */
const providerKey = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Trimmed, non-blank, at most `limit`, no control characters or lone surrogates (JSON-escaped into invalid TOML). */
export function plain(value: unknown, limit = 4096): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > limit || /\p{Cs}/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function text(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > sessionLimits.identifierLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

/**
 * Copies and validates a host route once. `problem` names the first failing rule for the host; a getter that throws
 * and every malformed field are refused.
 */
export function checkCodexRoute(value: unknown): { readonly route: CodexProxyRoute } | { readonly problem: string } {
  try {
    if (!record(value) || !record(value.scope)) return { problem: 'route must be an object with a scope object' };
    const { kind, providerId, endpoint, credentialPurpose, model, scope: { engine, account } } = value;
    if (kind !== 'litellm-proxy' || credentialPurpose !== 'litellm-proxy') {
      return { problem: 'route kind and credentialPurpose must be "litellm-proxy"' };
    }
    if (typeof providerId !== 'string' || !providerKey.test(providerId)) {
      return { problem: 'route providerId must be a model_providers key of 1-64 letters, digits, "_" or "-"' };
    }
    if (!endpointValid(endpoint) || new URL(endpoint).href !== endpoint || !/\/v1$/u.test(new URL(endpoint).pathname)) {
      return { problem: 'route endpoint must be a canonical http(s) URL ending in /v1, with no credentials, query or fragment' };
    }
    if (!plain(model, 256)) {
      return { problem: 'route model must be a non-blank LiteLLM model name of at most 256 characters without control characters' };
    }
    if (!text(engine) || !text(account)) {
      return { problem: 'route scope engine and account must be non-blank identifiers without control characters' };
    }
    return { route: Object.freeze({ kind, providerId, endpoint, credentialPurpose, model, scope: Object.freeze({ engine, account }) }) };
  } catch { return { problem: 'route could not be read' }; }
}
/** `checkCodexRoute` without the reason: `undefined` for any invalid route. */
export function copyCodexRoute(value: unknown): CodexProxyRoute | undefined {
  const checked = checkCodexRoute(value);
  return 'route' in checked ? checked.route : undefined;
}

/**
 * Session principal of a routed app-server: the `litellm-proxy:sha256:` prefix can never equal a direct requester
 * (`apiKey`, `chatgpt:<userId>`), and the hash bounds the length and keeps the endpoint out of references. Any change
 * of provider, endpoint, purpose or host scope is a different principal. Field order is explicit and versioned. `model`
 * is deliberately excluded: one route principal serves sessions on different models, each app-server enforcing its own
 * (execution.ts), and ai7m principals stay unchanged.
 */
export function codexRoutePrincipal(route: CodexProxyRoute): string {
  const material = JSON.stringify([1, route.providerId, route.endpoint, route.credentialPurpose, route.scope.engine,
    route.scope.account]);
  return `litellm-proxy:sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/**
 * Host-declared provider route (S1 `host-route`). `principal` is the host's stable route identity. `loopbackRelay`
 * marks an endpoint whose host and port the host replaces every turn; they are then left out of the session principal.
 * `sqliteHome` and `logDir` are the host's paths, absolute and outside `CODEX_HOME`. The helper form is the existing
 * command auth; `bearer` names environment variables and never carries a secret; `none` is an unauthenticated loopback.
 */
export interface CodexHostRoute {
  readonly kind: 'host-route';
  readonly providerId: string;
  readonly endpoint: string;
  readonly protocol: 'responses';
  readonly credentialForm: 'none' | 'helper' | 'bearer';
  readonly principal: string;
  readonly loopbackRelay: boolean;
  readonly model: string;
  readonly scope: { readonly engine: string; readonly account: string };
  readonly sqliteHome: string;
  readonly logDir: string;
  /** Bearer only: the environment variable name Codex reads. Never the secret. */
  readonly envKey?: string;
  /** Header name to environment variable name. Values stay in the host environment. */
  readonly headerEnv?: Readonly<Record<string, string>>;
  /** Helper only: the native command the host configured. */
  readonly helperCommand?: { readonly command: string; readonly args: readonly string[] };
}
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/u;
const loopbackHost = (hostname: string) => hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';

/** Canonical http(s) URL: `new URL(endpoint).href === endpoint`, so an origin-only URL keeps its trailing slash. */
export function canonicalEndpoint(value: unknown): value is string {
  if (!endpointValid(value)) return false;
  try { return new URL(value).href === value; } catch { return false; }
}

export function checkCodexHostRoute(value: unknown): { readonly route: CodexHostRoute } | { readonly problem: string } {
  try {
    if (!record(value) || !record(value.scope)) return { problem: 'host route must be an object with a scope object' };
    const { kind, providerId, endpoint, protocol, credentialForm, principal, loopbackRelay, model, scope, sqliteHome, logDir,
      envKey, headerEnv, helperCommand } = value;
    const { engine, account } = scope;
    if (kind !== 'host-route') return { problem: 'host route kind must be "host-route"' };
    if (typeof providerId !== 'string' || !providerKey.test(providerId)) {
      return { problem: 'host route providerId must be a model_providers key of 1-64 letters, digits, "_" or "-"' };
    }
    if (protocol !== 'responses') return { problem: 'host route protocol must be "responses"' };
    if (!canonicalEndpoint(endpoint)) {
      return { problem: 'host route endpoint must be a canonical http(s) URL with no credentials, query or fragment' };
    }
    if (credentialForm !== 'none' && credentialForm !== 'bearer' && credentialForm !== 'helper') {
      return { problem: 'host route credentialForm must be "none", "bearer" or "helper"' };
    }
    if (!plain(principal, 256) || !plain(model, 256) || !text(engine) || !text(account)) {
      return { problem: 'host route principal, model and scope must be plain non-blank strings' };
    }
    if (typeof loopbackRelay !== 'boolean') return { problem: 'host route loopbackRelay must be a boolean' };
    if (typeof sqliteHome !== 'string' || typeof logDir !== 'string' || !sqliteHome.startsWith('/') || !logDir.startsWith('/')) {
      return { problem: 'host route sqliteHome and logDir must be absolute paths' };
    }
    const url = new URL(endpoint);
    if (loopbackRelay && !loopbackHost(url.hostname)) return { problem: 'loopbackRelay is only a loopback endpoint' };
    if (credentialForm === 'helper' && !/\/v1$/u.test(url.pathname)) {
      return { problem: 'helper endpoint must be a canonical URL ending in /v1' };
    }
    if (credentialForm === 'none' && !(loopbackRelay && loopbackHost(url.hostname))) {
      return { problem: 'no-auth is only a loopback relay the host marked' };
    }
    let copiedEnv: string | undefined;
    let copiedHeaders: Readonly<Record<string, string>> | undefined;
    let copiedHelper: CodexHostRoute['helperCommand'];
    if (credentialForm === 'bearer') {
      if (typeof envKey !== 'string' || !envName.test(envKey)) return { problem: 'bearer envKey must be an environment variable name' };
      copiedEnv = envKey;
      if (headerEnv !== undefined) {
        if (!record(headerEnv)) return { problem: 'bearer headerEnv must be an object of header names to variable names' };
        const entries = Object.entries(headerEnv);
        if (!entries.every(([name, variable]) => headerName.test(name) && typeof variable === 'string' && envName.test(variable))) {
          return { problem: 'bearer headerEnv entries must be header names and environment variable names' };
        }
        copiedHeaders = Object.freeze(Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
      }
    } else if (envKey !== undefined || headerEnv !== undefined) {
      return { problem: 'envKey and headerEnv are only admitted on the bearer form' };
    }
    if (credentialForm === 'helper') {
      if (!record(helperCommand) || typeof helperCommand.command !== 'string' || !helperCommand.command.startsWith('/')
        || !Array.isArray(helperCommand.args) || !helperCommand.args.every((arg) => plain(arg))) {
        return { problem: 'helper command must be an absolute path and plain arguments' };
      }
      copiedHelper = Object.freeze({ command: helperCommand.command, args: Object.freeze([...helperCommand.args]) });
    } else if (helperCommand !== undefined) {
      return { problem: 'helperCommand is only admitted on the helper form' };
    }
    return { route: Object.freeze({ kind, providerId, endpoint, protocol, credentialForm, principal, loopbackRelay, model,
      scope: Object.freeze({ engine, account }), sqliteHome, logDir,
      ...(copiedEnv === undefined ? {} : { envKey: copiedEnv }),
      ...(copiedHeaders === undefined ? {} : { headerEnv: copiedHeaders }),
      ...(copiedHelper === undefined ? {} : { helperCommand: copiedHelper }) }) };
  } catch { return { problem: 'host route could not be read' }; }
}
export function copyCodexHostRoute(value: unknown): CodexHostRoute | undefined {
  const checked = checkCodexHostRoute(value);
  return 'route' in checked ? checked.route : undefined;
}

/**
 * Session principal of a host route. The prefix cannot equal a direct login or a `litellm-proxy:` principal. When the
 * host marks `loopbackRelay`, the endpoint's host and port are omitted so a per-turn port keeps one principal; the
 * scheme and path stay. Otherwise the canonical endpoint is hashed in full.
 */
export function codexHostRoutePrincipal(route: CodexHostRoute): string {
  const url = new URL(route.endpoint);
  const endpoint = route.loopbackRelay ? `${url.protocol}//${url.pathname}` : route.endpoint;
  const material = JSON.stringify([1, route.principal, route.credentialForm, route.protocol, endpoint, route.providerId,
    route.scope.engine, route.scope.account]);
  return `host-route:sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}
