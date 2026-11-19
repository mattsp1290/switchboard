import { createAuthContext } from '#switchboard';
import type { AuthScope, HostAdapterError, HostOpenOptions, HostRouteCredential } from '#switchboard';
import type { PiHostModelEvent, PiHostTurn } from './contract.js';
import type { HostToolDeclaration } from '#switchboard';

export interface PiHostRouteBody {
  readonly model: string;
  readonly protocol: string;
  readonly instructions: string;
  readonly turns: readonly PiHostTurn[];
  readonly tools: readonly HostToolDeclaration[];
}

export type PiHostTransport =
  | { readonly kind: 'stream' }
  | {
      readonly kind: 'route';
      readonly principal: string;
      readonly request: (body: PiHostRouteBody, signal: AbortSignal) => Promise<
        { readonly kind: 'ok'; readonly events: readonly PiHostModelEvent[] }
        | { readonly kind: 'error'; readonly error: HostAdapterError }
      >;
    };

const refused = (message: string): { readonly kind: 'error'; readonly error: HostAdapterError } =>
  ({ kind: 'error', error: { code: 'invalid-input', message } });

function scrub(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  return text;
}

function copyEvents(value: unknown): readonly PiHostModelEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: PiHostModelEvent[] = [];
  for (const event of value) {
    if (typeof event !== 'object' || event === null) return undefined;
    const record = event as Record<string, unknown>;
    if (record.kind === 'text' && typeof record.text === 'string') events.push({ kind: 'text', text: record.text });
    else if (record.kind === 'usage' && typeof record.input === 'number' && typeof record.output === 'number'
      && Number.isFinite(record.input) && Number.isFinite(record.output)) {
      events.push({ kind: 'usage', input: record.input, output: record.output });
    } else if (record.kind === 'tool-call' && typeof record.id === 'string' && typeof record.name === 'string'
      && Object.hasOwn(record, 'arguments')) {
      events.push({ kind: 'tool-call', id: record.id, name: record.name, arguments: record.arguments });
    } else return undefined;
  }
  return events;
}

/**
 * Admit a host-declared route only when the host did not supply a stream.
 * Direct and LiteLLM configurations are refused, and subscription passthrough is not implemented.
 */
export function admitPiHostTransport(options: {
  readonly stream: boolean;
  readonly route: HostOpenOptions['route'] | undefined;
  readonly invocationId: string;
}): { readonly kind: 'ok'; readonly value: PiHostTransport } | { readonly kind: 'error'; readonly error: HostAdapterError } {
  if (options.stream) {
    if (options.route !== undefined) return refused('A host stream and a provider route cannot both be set.');
    return { kind: 'ok', value: { kind: 'stream' } };
  }
  const route = options.route;
  if (route === undefined) return refused('A Pi host adapter needs a host stream or a host-declared route.');
  if (route.config.kind === 'direct' || route.config.kind === 'litellm') {
    return refused('The Pi host adapter does not fall back to a direct provider or a LiteLLM proxy.');
  }
  if (route.config.kind !== 'host-route') return refused('The Pi host adapter admits only a host-declared route.');
  if (route.config.protocol === 'subscription' || route.config.protocol === 'passthrough') {
    return refused('Subscription passthrough is absent.');
  }
  const prepared = createAuthContext({ config: route.config, scope: route.scope });
  if (prepared.kind === 'error') return refused('The host route configuration was rejected.');
  const auth = prepared.value;
  const scope: AuthScope = route.scope;
  let requestNumber = 0;
  return { kind: 'ok', value: {
    kind: 'route',
    principal: route.config.principal,
    request: async (body, signal) => {
      requestNumber += 1;
      const resolved = await auth.resolve({
        boundary: 'request', invocationId: options.invocationId, requestId: `${scope.sessionId}:${requestNumber}`,
      }, signal);
      if (resolved.kind === 'error') {
        if (resolved.error.code === 'aborted') {
          return { kind: 'error', error: { code: 'native-failure', message: 'The host route was aborted.' } };
        }
        return { kind: 'error', error: { code: 'unavailable', feature: 'host-route', message: 'The host route credential is unavailable.' } };
      }
      if (resolved.value.kind !== 'host-route') {
        return { kind: 'error', error: { code: 'native-failure', message: 'The host route did not resolve.' } };
      }
      const material: HostRouteCredential = resolved.value.material;
      const endpoint = resolved.value.endpoint;
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      const base = resolved.value.headers;
      if (base) Object.assign(headers, base);
      const secrets: string[] = [];
      if (material.form === 'bearer') {
        if (material.headers) Object.assign(headers, material.headers);
        headers.authorization = `Bearer ${material.token}`;
        secrets.push(material.token);
      }
      try {
        const response = await fetch(endpoint, {
          method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal,
        });
        if (!response.ok) return { kind: 'error', error: { code: 'native-failure', message: `The host route returned ${response.status}.` } };
        const payload: unknown = await response.json();
        const events = typeof payload === 'object' && payload !== null ? copyEvents((payload as { events?: unknown }).events) : undefined;
        if (events === undefined) return { kind: 'error', error: { code: 'native-failure', message: 'The host route returned an unreadable response.' } };
        return { kind: 'ok', events };
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : 'The host route request failed.', secrets);
        if (signal.aborted) return { kind: 'error', error: { code: 'native-failure', message: 'The host route was aborted.' } };
        return { kind: 'error', error: { code: 'native-failure', message } };
      }
    },
  } };
}
