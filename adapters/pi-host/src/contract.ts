import type { AdapterIdentity, HostAdapter, HostOpenOptions, HostToolDeclaration } from '#switchboard';

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
  /** Receives the exported state after a segment that was not aborted. */
  readonly onState?: (state: PiHostSessionState) => void;
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
const turnKeys = new Set(['segment', 'role', 'text', 'toolCallId', 'name', 'pending', 'toolCalls']);
const callKeys = new Set(['id', 'name', 'arguments']);

function knownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function validatePiHostSessionState(value: unknown): value is PiHostSessionState {
  if (!record(value) || !knownKeys(value, stateKeys) || value.formatVersion !== 1 || !plainText(value.sessionId, 1024)
    || !Array.isArray(value.turns) || value.turns.length > piHostLimits.maxTurns) return false;
  for (const turn of value.turns) {
    if (!record(turn) || !knownKeys(turn, turnKeys) || typeof turn.segment !== 'number' || !Number.isSafeInteger(turn.segment) || turn.segment < 1
      || (turn.role !== 'system' && turn.role !== 'user' && turn.role !== 'assistant' && turn.role !== 'tool')
      || typeof turn.text !== 'string' || turn.text.length > piHostLimits.maxText) return false;
    if (turn.toolCallId !== undefined && !plainText(turn.toolCallId, 1024)) return false;
    if (turn.name !== undefined && !plainText(turn.name, 256)) return false;
    if (turn.pending !== undefined && typeof turn.pending !== 'boolean') return false;
    if (turn.toolCalls !== undefined) {
      if (!Array.isArray(turn.toolCalls) || turn.toolCalls.length > piHostLimits.maxPendingPerMessage) return false;
      for (const call of turn.toolCalls) {
        if (!record(call) || !knownKeys(call, callKeys) || !plainText(call.id, 1024) || !plainText(call.name, 256)
          || !record(call.arguments)) return false;
      }
    }
  }
  return true;
}
