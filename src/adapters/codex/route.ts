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
type CodexHostRouteBase = {
  readonly kind: 'host-route';
  readonly providerId: string;
  readonly endpoint: string;
  readonly protocol: 'responses';
  readonly principal: string;
  readonly loopbackRelay: boolean;
  readonly model: string;
  readonly scope: { readonly engine: string; readonly account: string };
  readonly sqliteHome: string;
  readonly logDir: string;
};
export type CodexHostRoute = CodexHostRouteBase & (
  | { readonly credentialForm: 'none' }
  | { readonly credentialForm: 'bearer'; readonly envKey: string; readonly headerEnv?: Readonly<Record<string, string>> }
  | { readonly credentialForm: 'helper'; readonly helperCommand: { readonly command: string; readonly args: readonly string[] } }
);
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/u;
const loopbackHost = (hostname: string) => {
  const bare = hostname.length > 2 && hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
};

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
    const base = Object.freeze({ kind, providerId, endpoint, protocol, principal, loopbackRelay, model,
      scope: Object.freeze({ engine, account }), sqliteHome, logDir });
    switch (credentialForm) {
      case 'bearer': {
        if (helperCommand !== undefined) return { problem: 'helperCommand is only admitted on the helper form' };
        if (typeof envKey !== 'string' || !envName.test(envKey)) return { problem: 'bearer envKey must be an environment variable name' };
        let headerEnvCopy: Readonly<Record<string, string>> | undefined;
        if (headerEnv !== undefined) {
          if (!record(headerEnv)) return { problem: 'bearer headerEnv must be an object of header names to variable names' };
          const entries = Object.entries(headerEnv);
          if (!entries.every(([name, variable]) => headerName.test(name) && typeof variable === 'string' && envName.test(variable))) {
            return { problem: 'bearer headerEnv entries must be header names and environment variable names' };
          }
          headerEnvCopy = Object.freeze(Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
        }
        return { route: Object.freeze({ ...base, credentialForm, envKey, ...(headerEnvCopy === undefined ? {} : { headerEnv: headerEnvCopy }) }) };
      }
      case 'helper': {
        if (envKey !== undefined || headerEnv !== undefined) {
          return { problem: 'envKey and headerEnv are only admitted on the bearer form' };
        }
        if (!record(helperCommand) || typeof helperCommand.command !== 'string' || !helperCommand.command.startsWith('/')
          || !Array.isArray(helperCommand.args) || !helperCommand.args.every((arg) => plain(arg))) {
          return { problem: 'helper command must be an absolute path and plain arguments' };
        }
        return { route: Object.freeze({ ...base, credentialForm, helperCommand: Object.freeze({ command: helperCommand.command,
          args: Object.freeze([...helperCommand.args]) }) }) };
      }
      case 'none': {
        if (envKey !== undefined || headerEnv !== undefined || helperCommand !== undefined) {
          return { problem: 'envKey, headerEnv, and helperCommand are not admitted on the none form' };
        }
        return { route: Object.freeze({ ...base, credentialForm: 'none' }) };
      }
      default: {
        const leftover: never = credentialForm;
        void leftover;
        return { problem: 'host route credentialForm must be "none", "bearer" or "helper"' };
      }
    }
  } catch { return { problem: 'host route could not be read' }; }
}
/** One admit for both route kinds. A host route never goes through `checkCodexRoute`. */
export function admitCodexRoute(value: unknown):
{ readonly route: CodexProxyRoute | CodexHostRoute } | { readonly problem: string } {
  if (record(value) && value.kind === 'host-route') return checkCodexHostRoute(value);
  return checkCodexRoute(value);
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

export type CodexProxyValue = string | number | boolean | readonly string[];
export interface CodexProcessConfig {
  /** Dotted native config keys and their values, in the order the args carry them. */
  readonly overrides: Readonly<Record<string, CodexProxyValue>>;
  /** `-c key=<JSON>` pairs the host appends to `codex app-server` (JSON scalars and string arrays are TOML values). */
  readonly args: readonly string[];
}
/** Provider wire keys only. Sandbox, approval, and multi-agent pins are not this function's to set. */
export function responsesProviderWire(providerId: string, endpoint: string, model: string, name: string):
Record<string, CodexProxyValue> {
  const at = `model_providers.${providerId}`;
  return { model_provider: providerId, model, [`${at}.name`]: name, [`${at}.base_url`]: endpoint, [`${at}.wire_api`]: 'responses',
    [`${at}.supports_websockets`]: false, [`${at}.request_max_retries`]: 0, [`${at}.stream_max_retries`]: 0,
    [`${at}.requires_openai_auth`]: false };
}
export function processConfig(overrides: Record<string, CodexProxyValue>): CodexProcessConfig {
  return Object.freeze({ overrides: Object.freeze(overrides),
    args: Object.freeze(Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])) });
}

/**
 * `-c` overrides for a host route. Bearer and no-auth never set `auth.command`, `experimental_bearer_token`, or a
 * secret: `env_key` and `env_http_headers` name variables the host put in the process environment. The helper form
 * sets that command and still refuses headers. Sandbox, approvals, and multi-agent are not pinned here.
 */
export function codexHostRouteConfig(route: CodexHostRoute): CodexProcessConfig {
  const { providerId, endpoint, model, sqliteHome, logDir } = route;
  const at = `model_providers.${providerId}`;
  const overrides: Record<string, CodexProxyValue> = { ...responsesProviderWire(providerId, endpoint, model, 'Host'),
    sqlite_home: sqliteHome, log_dir: logDir };
  switch (route.credentialForm) {
    case 'bearer':
      overrides[`${at}.env_key`] = route.envKey;
      if (route.headerEnv) for (const [name, variable] of Object.entries(route.headerEnv)) overrides[`${at}.env_http_headers.${name}`] = variable;
      break;
    case 'helper':
      overrides[`${at}.auth.command`] = route.helperCommand.command;
      overrides[`${at}.auth.args`] = route.helperCommand.args;
      overrides[`${at}.auth.timeout_ms`] = 5000;
      overrides[`${at}.auth.refresh_interval_ms`] = 300000;
      break;
    case 'none':
      break;
    default: {
      const leftover: never = route;
      throw new Error(`host route credential form is ${String(leftover)}`);
    }
  }
  return processConfig(overrides);
}
