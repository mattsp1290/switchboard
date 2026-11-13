import { URL } from 'node:url';
import type { Outcome } from './contracts.js';

/** Nonsecret correlation identifiers. The host owns authorization of this scope. */
export interface AuthScope {
  readonly engine: string;
  readonly account: string;
  readonly adapterInstanceId: string;
  readonly sessionId: string;
}

export type AuthBoundary =
  | { readonly boundary: 'invocation'; readonly invocationId: string }
  | { readonly boundary: 'request'; readonly invocationId: string; readonly requestId: string };

export type AuthResolutionContext = Readonly<{ scope: AuthScope } & AuthBoundary>;
export type CredentialResolver<Material> = (
  context: AuthResolutionContext,
  signal: AbortSignal,
) => Material | PromiseLike<Material>;

/** Declared purpose is a host assertion, not proof of the token's issuer. */
export interface ProxyCredential {
  readonly purpose: 'litellm-proxy';
  readonly token: string;
}

/** Adapters validate protocol, headers, and native options against their native family. */
export interface AuthRoute<NativeOptions = unknown> {
  readonly model: string;
  readonly endpoint?: string;
  readonly protocol?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Opaque options keep their identity. The adapter owns their immutable value contract. */
  readonly nativeOptions?: NativeOptions;
}

export type AuthConfiguration<DirectMaterial, NativeOptions = unknown> =
  | (AuthRoute<NativeOptions> & {
      readonly kind: 'direct';
      readonly resolve: CredentialResolver<DirectMaterial>;
    })
  | (AuthRoute<NativeOptions> & {
      readonly kind: 'litellm';
      readonly endpoint: string;
      readonly protocol: string;
      readonly credentialPurpose: 'litellm-proxy';
      readonly resolve: CredentialResolver<ProxyCredential>;
    });

export type ResolvedAuthentication<DirectMaterial, NativeOptions = unknown> =
  | (AuthRoute<NativeOptions> & { readonly kind: 'direct'; readonly material: DirectMaterial })
  | (AuthRoute<NativeOptions> & {
      readonly kind: 'litellm';
      readonly endpoint: string;
      readonly protocol: string;
      readonly credentialPurpose: 'litellm-proxy';
      readonly material: ProxyCredential;
    });

export interface AuthError {
  readonly code: 'invalid-config' | 'invalid-boundary' | 'credential-unavailable' | 'aborted';
  readonly message: string;
}

export interface ScopedAuth<DirectMaterial, NativeOptions = unknown> {
  /**
   * Call at every supported native boundary, including resumed work. No credentials are cached.
   * Cancellation is checked before and after resolution. The resolver must cooperate while pending.
   */
  readonly resolve: (
    boundary: AuthBoundary,
    signal: AbortSignal,
  ) => Promise<Outcome<ResolvedAuthentication<DirectMaterial, NativeOptions>, AuthError>>;
}

function failure(code: AuthError['code']): Outcome<never, AuthError> {
  return { kind: 'error', error: { code, message: 'Authentication could not be resolved.' } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControls(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function text(value: unknown, limit = 1024): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
    && !hasControls(value);
}

function keys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function endpointValid(value: unknown): value is string {
  if (!text(value, 8192) || value.trim() !== value
    || !/^https?:\/\/[^/?#\\@]+(?:[/?#]|$)/iu.test(value) || value.includes('\\')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
      && url.username === '' && url.password === '' && !value.includes('?') && !value.includes('#');
  } catch {
    return false;
  }
}

function copyHeaders(value: unknown): Readonly<Record<string, string>> | undefined | false {
  if (value === undefined) return undefined;
  if (!record(value)) return false;
  const entries: [string, string][] = [];
  for (const [name, content] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || name.length > 256
      || typeof content !== 'string' || content.length > 8192
      || hasControls(content)) return false;
    entries.push([name, content]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function scopeValid(value: AuthScope): boolean {
  return record(value) && text(value.engine) && text(value.account)
    && text(value.adapterInstanceId) && text(value.sessionId);
}

function copyScope(value: AuthScope): AuthScope {
  return Object.freeze({ engine: value.engine, account: value.account,
    adapterInstanceId: value.adapterInstanceId, sessionId: value.sessionId });
}

function copyBoundary(value: AuthBoundary): AuthBoundary | undefined {
  if (!record(value)) return undefined;
  const { boundary, invocationId } = value;
  if (!text(invocationId)) return undefined;
  if (boundary === 'invocation' && keys(value, ['boundary', 'invocationId'])) {
    return Object.freeze({ boundary, invocationId });
  }
  if (boundary === 'request') {
    const requestId = value.requestId;
    if (text(requestId) && keys(value, ['boundary', 'invocationId', 'requestId'])) {
      return Object.freeze({ boundary, invocationId, requestId });
    }
  }
  return undefined;
}

function copyProxy(value: unknown): ProxyCredential | undefined {
  if (!record(value) || !keys(value, ['purpose', 'token'])) return undefined;
  const { purpose, token } = value;
  if (purpose !== 'litellm-proxy' || !text(token, 16384)) return undefined;
  return Object.freeze({ purpose, token });
}

/**
 * Endpoint checks establish syntax only. The host authorizes endpoints, including private HTTP proxies.
 * This helper never dispatches native work. Adapters wire resolve to the boundaries their SDK supports.
 * Direct material validation and native sign-in remain with the adapter. No universal token mapping is applied.
 */
export function createAuthContext<DirectMaterial, NativeOptions = unknown>(options: {
  readonly config: AuthConfiguration<DirectMaterial, NativeOptions>;
  readonly scope: AuthScope;
}): Outcome<ScopedAuth<DirectMaterial, NativeOptions>, AuthError> {
  try {
    return prepare(options);
  } catch {
    return failure('invalid-config');
  }
}

function prepare<DirectMaterial, NativeOptions>(options: {
  readonly config: AuthConfiguration<DirectMaterial, NativeOptions>;
  readonly scope: AuthScope;
}): Outcome<ScopedAuth<DirectMaterial, NativeOptions>, AuthError> {
  const { config, scope } = options;
  if (!record(config) || !record(scope)) return failure('invalid-config');
  const fixedScope = copyScope(scope);
  if (!scopeValid(fixedScope)) return failure('invalid-config');
  const { kind, model, endpoint, protocol, nativeOptions, resolve } = config;
  const credentialPurpose = 'credentialPurpose' in config ? config.credentialPurpose : undefined;
  const headers = copyHeaders(config.headers);
  const allowed = ['kind', 'model', 'endpoint', 'protocol', 'headers', 'nativeOptions', 'resolve'];
  if (kind === 'litellm') allowed.push('credentialPurpose');
  if ((kind !== 'direct' && kind !== 'litellm') || !keys(config, allowed)
    || !text(model) || typeof resolve !== 'function' || headers === false
    || (endpoint !== undefined && !endpointValid(endpoint))
    || (protocol !== undefined && !text(protocol))) return failure('invalid-config');
  const route = Object.freeze({ model,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(headers === undefined ? {} : { headers }),
    ...(nativeOptions === undefined ? {} : { nativeOptions }),
  });
  let selected: AuthConfiguration<DirectMaterial, NativeOptions>;
  if (kind === 'direct') {
    selected = Object.freeze({ ...route, kind, resolve });
  } else {
    if (credentialPurpose !== 'litellm-proxy' || !endpointValid(endpoint) || !text(protocol)) {
      return failure('invalid-config');
    }
    selected = Object.freeze({ ...route, kind, endpoint, protocol, credentialPurpose, resolve });
  }
  return { kind: 'ok', value: Object.freeze({
    resolve: async (boundary: AuthBoundary, signal: AbortSignal): Promise<
      Outcome<ResolvedAuthentication<DirectMaterial, NativeOptions>, AuthError>
    > => {
      let context: AuthResolutionContext;
      try {
        const copied = copyBoundary(boundary);
        if (copied === undefined) return failure('invalid-boundary');
        context = Object.freeze({ ...copied, scope: copyScope(fixedScope) });
      } catch {
        return failure('invalid-boundary');
      }
      if (signal.aborted) return failure('aborted');
      try {
        if (selected.kind === 'direct') {
          const material = await selected.resolve(context, signal);
          if (signal.aborted) return failure('aborted');
          return { kind: 'ok', value: Object.freeze({ ...route, kind: 'direct', material }) };
        }
        const material = copyProxy(await selected.resolve(context, signal));
        if (signal.aborted) return failure('aborted');
        if (material === undefined) return failure('credential-unavailable');
        return { kind: 'ok', value: Object.freeze({ ...route, kind: 'litellm',
          endpoint: selected.endpoint, protocol: selected.protocol,
          credentialPurpose: 'litellm-proxy', material }) };
      } catch {
        return failure(signal.aborted ? 'aborted' : 'credential-unavailable');
      }
    },
  }) };
}
