/** The JSON value set the AG-UI projector accepts. Defined here so the core entry stays free of `src/agui`. */
export type Json = null | boolean | number | string | readonly Json[]
  | { readonly [key: string]: Json };

/** One `ProjectionFamily` name, repeated here so adapters do not import `src/agui`. */
export type RunObservationFamily =
  | 'state' | 'activity' | 'raw' | 'custom' | 'messages' | 'interrupts' | 'usage' | 'reasoning' | 'subagents';

/** Native counts already renamed to the AG-UI `TokenUsage` names. A count the native value did not carry is absent. */
export interface RunObservationUsage {
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

/**
 * `arguments-ended`: arguments are complete and execution was not observed.
 * `completed` and `failed`: execution was observed.
 */
export type RunObservationToolPhase = 'started' | 'arguments' | 'arguments-ended' | 'completed' | 'failed';

export type RunObservationOutcome = 'success' | 'failed' | 'cancelled' | 'outcome-unknown';

/**
 * A fact an adapter observed at the native branch it already classifies. Every member is a frozen plain object holding
 * copied strings and JSON-safe values, never the native object.
 */
export type RunObservation =
  | { readonly kind: 'run-started' }
  | { readonly kind: 'text'; readonly messageId: string; readonly mode: 'snapshot' | 'delta'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly messageId: string; readonly mode: 'snapshot' | 'delta'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly callId: string;
      readonly name: string;
      readonly phase: RunObservationToolPhase;
      readonly argumentsJson?: string;
      readonly resultJson?: string;
    }
  | { readonly kind: 'usage'; readonly rows: readonly RunObservationUsage[] }
  /** A permission request the adapter has already refused. It is never an AG-UI interrupt outcome. */
  | { readonly kind: 'interrupt'; readonly id: string; readonly reason: string; readonly message?: string }
  | { readonly kind: 'terminal'; readonly outcome: RunObservationOutcome; readonly pendingTools?: readonly string[] }
  | { readonly kind: 'unsupported'; readonly family: RunObservationFamily }
  /** One provider request that is not the agent turn. */
  | {
      readonly kind: 'model-boundary';
      readonly requestModel?: string;
      readonly responseModel?: string;
      readonly usage?: RunObservationUsage;
    };

export type RunObservationListener = (observation: RunObservation) => void;

/**
 * `JSON.stringify` of a JSON value, or `undefined` for `undefined`, functions, symbols, bigint, cycles and any other
 * value that does not serialize. Never throws.
 */
export function jsonString(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return;
  try {
    const result: unknown = JSON.stringify(value);
    return typeof result === 'string' ? result : undefined;
  } catch {
    return undefined;
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Freezes `observation` and passes it to `listener`, swallowing any throw. Absent listeners are not called. A listener
 * failure never changes admission, a public callback, or a terminal outcome.
 */
export function emitObservation(listener: RunObservationListener | undefined, observation: RunObservation): void {
  if (listener === undefined) return;
  try {
    listener(freezeDeep(observation));
  } catch {
    // A listener exception does not change native work.
  }
}
