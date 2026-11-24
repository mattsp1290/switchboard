import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { admitPiHostTransport } from './route.js';
import type { PiHostTransport } from './route.js';
import type { AdapterIdentity, HostAdapter, HostAdapterError, HostOpenOptions, HostToolDeclaration, Outcome } from '#switchboard';

export const piHostIdentity = Object.freeze({
  engine: 'pi', adapter: 'pi-host', version: '1', contractVersion: 1,
} satisfies AdapterIdentity<'pi'>);

/** One transcript turn the host can read. System turns are the entries `isPiHostSystemEntry` selects. */
export interface PiHostTurn {
  readonly segment: number;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly toolCallId?: string;
  readonly name?: string;
  /** True while the host still owes this call a result. A later export clears it. */
  readonly pending?: boolean;
  /** Failed host tool result; omitted older rows mean false. */
  readonly isError?: boolean;
  readonly toolCalls?: readonly PiHostToolCall[];
}

export interface PiHostToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** Published session state. Turn `segment` is the segment boundary a host can check. */
export interface PiHostSessionState {
  readonly formatVersion: 1;
  readonly sessionId: string;
  readonly turns: readonly PiHostTurn[];
}

export interface PiHostModelRequest {
  readonly instructions: string;
  readonly turns: readonly PiHostTurn[];
  readonly tools: readonly HostToolDeclaration[];
  readonly signal: AbortSignal;
}

export type PiHostModelEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: unknown }
  /** `input` is the total prompt input including any cached tokens, so a stream over Pi's uncached `usage.input` must add `cacheRead` and `cacheWrite`. */
  | { readonly kind: 'usage'; readonly input: number; readonly output: number };

/**
 * Host model stream. The types name no Pi SDK type, so a worker can implement this without that SDK.
 * The adapter calls it for every model request and does not open a socket for it.
 */
export interface PiHostModelStream {
  (request: PiHostModelRequest): AsyncIterable<PiHostModelEvent>;
}

export interface PiHostOpenOptions extends HostOpenOptions {
  readonly stream?: PiHostModelStream;
  /** State mode. Directory resume is a different mode and is refused here. */
  readonly state?: PiHostSessionState;
  /** Receives a detached exported state. Returned promises are awaited; fulfillment values are ignored. */
  readonly onState?: (state: PiHostSessionState) => unknown;
}

export interface PiHostAdapter extends HostAdapter<'pi'> {
  readonly state: () => PiHostSessionState;
}

export const piHostLimits = Object.freeze({
  maxTurns: 128,
  maxPendingPerMessage: 8,
  maxText: 100_000,
  maxTools: 64,
});

/** JSON Schema for `PiHostSessionState`. Hosts can parse and check an export against it. */
export const piHostSessionStateSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'sessionId', 'turns'],
  properties: Object.freeze({
    formatVersion: Object.freeze({ const: 1 }),
    sessionId: Object.freeze({ type: 'string', minLength: 1, maxLength: 1024 }),
    turns: Object.freeze({
      type: 'array',
      maxItems: piHostLimits.maxTurns,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: ['segment', 'role', 'text'],
        properties: Object.freeze({
          segment: Object.freeze({ type: 'integer', minimum: 1 }),
          role: Object.freeze({ enum: ['system', 'user', 'assistant', 'tool'] }),
          text: Object.freeze({ type: 'string', maxLength: piHostLimits.maxText }),
          toolCallId: Object.freeze({ type: 'string' }),
          name: Object.freeze({ type: 'string' }),
          pending: Object.freeze({ type: 'boolean' }),
          isError: Object.freeze({ type: 'boolean' }),
          toolCalls: Object.freeze({ type: 'array' }),
        }),
      }),
    }),
  }),
});

/** True for the session entries the SDK writes for system context, and for system turns in exported state. */
export function isPiHostSystemEntry(entry: { readonly role?: unknown }): boolean {
  return entry.role === 'system';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plainText(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

const stateKeys = new Set(['formatVersion', 'sessionId', 'turns']);
const turnKeys = new Set(['segment', 'role', 'text', 'toolCallId', 'name', 'pending', 'isError', 'toolCalls']);
const callKeys = new Set(['id', 'name', 'arguments']);

function knownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

type PiJsonValue = null | boolean | number | string | PiJsonValue[] | { [key: string]: PiJsonValue };

export function isPiHostJsonObject(value: unknown): value is { [key: string]: PiJsonValue } {
  try {
    if (!record(value)) return false;
    const pending: unknown[] = [value]; const seen = new WeakSet<object>();
    while (pending.length) {
      const node = pending.pop();
      if (node === null || typeof node === 'string' || typeof node === 'boolean' || (typeof node === 'number' && Number.isFinite(node))) continue;
      if (typeof node !== 'object') return false;
      if (seen.has(node)) continue;
      seen.add(node);
      if (!Array.isArray(node) && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) return false;
      for (const child of Array.isArray(node) ? node : Object.values(node)) pending.push(child);
    }
    JSON.stringify(value); // Reject cycles after checking every value, without invoking a toJSON function.
    return true;
  } catch { return false; }
}

export function validatePiHostSessionState(value: unknown): value is PiHostSessionState {
  if (!record(value) || !knownKeys(value, stateKeys) || value.formatVersion !== 1 || !plainText(value.sessionId, 1024)
    || !Array.isArray(value.turns) || value.turns.length > piHostLimits.maxTurns) return false;
  let pendingPlaceholder = false;
  const batch = new Set<string>();
  const calls = new Map<string, { readonly name: string; answered: boolean }>();
  for (const turn of value.turns) {
    if (!record(turn) || !knownKeys(turn, turnKeys) || typeof turn.segment !== 'number' || !Number.isSafeInteger(turn.segment) || turn.segment < 1
      || (turn.role !== 'system' && turn.role !== 'user' && turn.role !== 'assistant' && turn.role !== 'tool')
      || typeof turn.text !== 'string' || turn.text.length > piHostLimits.maxText) return false;
    if (turn.toolCallId !== undefined && !plainText(turn.toolCallId, 1024)) return false;
    if (turn.name !== undefined && !plainText(turn.name, 256)) return false;
    if (turn.pending !== undefined && (turn.role !== 'tool' || typeof turn.pending !== 'boolean')) return false;
    if (turn.isError !== undefined && (turn.role !== 'tool' || typeof turn.isError !== 'boolean')) return false;
    if (turn.role !== 'tool' && (pendingPlaceholder || batch.size > 0)) return false;
    if (turn.role === 'tool' && turn.pending === true) pendingPlaceholder = true;
    if (turn.toolCalls !== undefined) {
      if (turn.role !== 'assistant' || !Array.isArray(turn.toolCalls) || turn.toolCalls.length > piHostLimits.maxPendingPerMessage) return false;
      for (const call of turn.toolCalls) {
        if (!record(call) || !knownKeys(call, callKeys) || !plainText(call.id, 1024) || !plainText(call.name, 256)
          || !isPiHostJsonObject(call.arguments) || calls.has(call.id)) return false;
        calls.set(call.id, { name: call.name, answered: false });
        batch.add(call.id);
      }
    }
    if (turn.role === 'tool') {
      const call = typeof turn.toolCallId === 'string' ? calls.get(turn.toolCallId) : undefined;
      if (!call || call.answered || call.name !== turn.name || typeof turn.toolCallId !== 'string' || !batch.delete(turn.toolCallId)) return false;
      call.answered = true;
    }
  }
  return [...calls.values()].every(call => call.answered);
}

export interface PiHostAdmission {
  readonly instructions: string;
  readonly tools: readonly HostToolDeclaration[];
  readonly state: PiHostSessionState | undefined;
  readonly tempRoot: string;
  readonly onState: PiHostOpenOptions['onState'];
  readonly account: string;
  readonly active: { readonly kind: 'stream'; readonly stream: PiHostModelStream } | Extract<PiHostTransport, { kind: 'route' }>;
}

export function capturePiHostOptions(options: PiHostOpenOptions, signal: AbortSignal): Outcome<PiHostAdmission, HostAdapterError> {
  const refused = (error: HostAdapterError): Outcome<PiHostAdmission, HostAdapterError> => ({ kind: 'error', error });
  try {
    const { launch, environment, subagents, builtInTools, resume, instructions, onState, stream, route,
      tools: suppliedTools, state: suppliedState } = options;
    const tools: readonly HostToolDeclaration[] = structuredClone(suppliedTools ?? []);
    const state = suppliedState === undefined ? undefined : structuredClone(suppliedState);
    if (!(signal instanceof AbortSignal)) return refused({ code: 'invalid-input', message: 'The open signal is not an AbortSignal.' });
    if (launch?.kind !== 'in-process') return refused({ code: 'invalid-input', message: 'The Pi host adapter launches in-process.' });
    if (environment === undefined || typeof environment.variables !== 'object' || environment.variables === null) {
      return refused({ code: 'invalid-input', message: 'The Pi host adapter requires a host environment.' });
    }
    for (const value of Object.values(environment.variables)) {
      if (typeof value !== 'string') return refused({ code: 'invalid-input', message: 'Host environment variables must be strings.' });
    }
    if (subagents !== 'off') return refused({ code: 'invalid-input', message: 'The Pi host adapter runs with subagents off.' });
    if (builtInTools !== undefined && builtInTools.length > 0) {
      return refused({ code: 'unavailable', feature: 'built-in-tools', message: 'Built-in tools are off in the host-owned Pi adapter.' });
    }
    if (resume !== undefined) {
      return refused({ code: 'unsupported', feature: 'directory-resume', message: 'Directory resume is not available. Import session state instead.' });
    }
    if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > piHostLimits.maxText)) {
      return refused({ code: 'invalid-input', message: 'Instructions must be a string within the published limit.' });
    }
    if (onState !== undefined && typeof onState !== 'function') {
      return refused({ code: 'invalid-input', message: 'onState must be a function.' });
    }
    if (tools.length > piHostLimits.maxTools) return refused({ code: 'invalid-input', message: 'Too many host tools.' });
    const names = new Set<string>();
    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(tool.name) || typeof tool.description !== 'string'
        || !isPiHostJsonObject(tool.inputSchema) || names.has(tool.name)) {
        return refused({ code: 'invalid-input', message: 'Host tool declarations are fixed and must be unique JSON-schema tools.' });
      }
      names.add(tool.name);
    }
    if (state !== undefined && !validatePiHostSessionState(state)) {
      return refused({ code: 'invalid-input', message: 'The imported session state does not match the published schema.' });
    }
    const tempRoot = environment.variables.TMPDIR ?? environment.variables.TMP ?? environment.variables.TEMP;
    if (tempRoot === undefined || !isAbsolute(tempRoot)) {
      return refused({ code: 'invalid-input', message: 'The host environment must name an absolute temp directory.' });
    }
    if (stream !== undefined && typeof stream !== 'function') return refused({ code: 'invalid-input', message: 'The host stream must be a function.' });
    const transport = admitPiHostTransport({ stream: stream !== undefined, route, invocationId: randomUUID() });
    if (transport.kind === 'error') return transport;
    const active = stream !== undefined ? { kind: 'stream' as const, stream }
      : transport.value.kind === 'route' ? transport.value : undefined;
    if (active === undefined) return refused({ code: 'invalid-input', message: 'The host stream is missing.' });
    return { kind: 'ok', value: { instructions: instructions ?? '', tools, state, tempRoot,
      onState: onState?.bind(options), account: route?.scope.account ?? 'host', active } };
  } catch { return refused({ code: 'invalid-input', message: 'The Pi host options could not be captured.' }); }
}
