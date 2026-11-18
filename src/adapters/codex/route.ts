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
