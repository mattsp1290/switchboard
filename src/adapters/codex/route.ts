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
   * (`new URL(endpoint).href === endpoint`), so one route never has two principals through case or `..` aliases.
   */
  readonly endpoint: string;
  readonly credentialPurpose: 'litellm-proxy';
  /** Stable host auth scope (`AuthScope.engine` and `.account`); session and adapter instance ids are not stable. */
  readonly scope: { readonly engine: string; readonly account: string };
}

/** Conservative native provider key: Codex config keys under `model_providers` (`openai`, `ollama`, `litellm`). */
const providerKey = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
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

/** Copies and validates a host route once; getters that throw and every malformed field are `undefined`. */
export function copyCodexRoute(value: unknown): CodexProxyRoute | undefined {
  try {
    if (!record(value) || !record(value.scope)) return undefined;
    const { kind, providerId, endpoint, credentialPurpose, scope: { engine, account } } = value;
    if (kind !== 'litellm-proxy' || credentialPurpose !== 'litellm-proxy' || typeof providerId !== 'string'
      || !providerKey.test(providerId) || !endpointValid(endpoint) || new URL(endpoint).href !== endpoint
      || !/\/v1$/u.test(new URL(endpoint).pathname)
      || !text(engine) || !text(account)) return undefined;
    return Object.freeze({ kind, providerId, endpoint, credentialPurpose, scope: Object.freeze({ engine, account }) });
  } catch { return undefined; }
}

/**
 * Session principal of a routed app-server: the `litellm-proxy:sha256:` prefix can never equal a direct requester
 * (`apiKey`, `chatgpt:<userId>`), and the hash bounds the length and keeps the endpoint out of references. Any change
 * of provider, endpoint, purpose or host scope is a different principal. Field order is explicit and versioned.
 */
export function codexRoutePrincipal(route: CodexProxyRoute): string {
  const material = JSON.stringify([1, route.providerId, route.endpoint, route.credentialPurpose, route.scope.engine,
    route.scope.account]);
  return `litellm-proxy:sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}
