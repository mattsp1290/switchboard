import type { NativeExtension, Outcome } from './contracts.js';
import type { HostSegmentResult } from './host-adapter.js';

/** Every `ProjectionFamily` name, repeated here so adapters do not import `src/agui`. The baseline checks both lists match. */
export const runObservationFamilies = Object.freeze([
  'state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'usage', 'reasoning', 'subagents',
] as const);
export type RunObservationFamily = typeof runObservationFamilies[number];
/** The families no exported runtime can observe today. Each runtime declares them unsupported when its turn starts. */
export const unobservedFamilies = Object.freeze(['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents'] as const);

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
 * `arguments-ended`: arguments are complete. Without `resultJson`, execution was not observed. With `resultJson`, the
 * native side reported a result, which records a successful tool span.
 * `completed` and `failed`: execution was observed.
 * `arguments`: `argumentsJson` is the next delta of the argument JSON text.
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

/**
 * Makes a native usage row acceptable to the AG-UI usage rules without inventing counts. When the cache counts exceed
 * `inputTokens`, the native input excluded cache, so cache is added to it. Reasoning above `outputTokens` is dropped.
 * `totalTokens` is kept only when it equals the final input plus output.
 */
export function normalizeUsage(row: RunObservationUsage): RunObservationUsage {
  const { totalTokens, reasoningTokens, inputTokens, ...rest } = row;
  const cache = (row.cachedInputTokens ?? 0) + (row.cacheWriteInputTokens ?? 0);
  const input = inputTokens !== undefined && cache > inputTokens ? inputTokens + cache : inputTokens;
  const keepReasoning = reasoningTokens !== undefined && (row.outputTokens === undefined || reasoningTokens <= row.outputTokens);
  const keepTotal = totalTokens !== undefined && input !== undefined && row.outputTokens !== undefined
    && totalTokens === input + row.outputTokens;
  return {
    ...rest,
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(keepReasoning ? { reasoningTokens } : {}),
    ...(keepTotal ? { totalTokens } : {}),
  };
}

export type RunObservationListener = (observation: RunObservation) => void;

/** `true` for an absent listener or a function, so `!isObservationListener(value)` is the request check. */
export function isObservationListener(value: unknown): value is RunObservationListener | undefined {
  return value === undefined || typeof value === 'function';
}

/** A non-negative safe integer token count, or `undefined`. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

type UsageCountKey = Exclude<keyof RunObservationUsage, 'provider' | 'model'>;
const usageCountKeys: readonly UsageCountKey[] = [
  'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
];
/** Keeps each count that passes `tokenCount`; `undefined` when none does. Native names are mapped by the caller. */
export function usageFromCounts(raw: { readonly [K in UsageCountKey]?: unknown }): RunObservationUsage | undefined {
  const row: { [K in UsageCountKey]?: number } = {};
  for (const key of usageCountKeys) {
    const count = tokenCount(raw[key]);
    if (count !== undefined) row[key] = count;
  }
  return Object.keys(row).length === 0 ? undefined : row;
}

/** The text runtimes' public outcome as a terminal observation outcome. */
export const runtimeOutcome = Object.freeze({ completed: 'success', failed: 'failed', interrupted: 'cancelled' } as const);

/**
 * A host segment result as its terminal observation. A failure whose write is `outcome-unknown` is always
 * `outcome-unknown`; any other failure is `failedAs`. A pending segment succeeds with its call ids pending.
 */
export function segmentTerminal(result: HostSegmentResult, failedAs: Exclude<RunObservationOutcome, 'success'> = 'failed'): RunObservation {
  switch (result.kind) {
    case 'complete': return { kind: 'terminal', outcome: 'success' };
    case 'pending': return { kind: 'terminal', outcome: 'success',
      pendingTools: result.calls.map((call) => call.pending.target.nativeToolCallId) };
    case 'failed': return { kind: 'terminal', outcome: result.write.kind === 'outcome-unknown' ? 'outcome-unknown' : failedAs };
  }
}

/** Replays one answered host tool call into a continuation segment: started, its arguments, then the observed result. */
export function answeredToolObservations(callId: string, name: string, args: unknown,
  result: Outcome<NativeExtension, NativeExtension>): readonly RunObservation[] {
  const argumentsJson = jsonString(args);
  const resultJson = result.kind === 'ok' ? jsonString(result.value.data) : undefined;
  return [
    { kind: 'tool', callId, name, phase: 'started' },
    { kind: 'tool', callId, name, phase: 'arguments-ended', ...(argumentsJson === undefined ? {} : { argumentsJson }) },
    { kind: 'tool', callId, name, phase: result.kind === 'ok' ? 'completed' : 'failed', ...(resultJson === undefined ? {} : { resultJson }) },
  ];
}

/**
 * Opening phases for adapters that see a tool call several times: `started` once per call, then `arguments` once
 * when JSON-safe arguments first appear. The caller emits the closing phase itself.
 */
export function createToolTracker(): (callId: string, name: string, argumentsJson: string | undefined) => readonly RunObservation[] {
  const calls = new Map<string, { argumentsSent: boolean }>();
  return (callId, name, argumentsJson) => {
    const observations: RunObservation[] = [];
    let call = calls.get(callId);
    if (call === undefined) {
      call = { argumentsSent: false };
      calls.set(callId, call);
      observations.push({ kind: 'tool', callId, name, phase: 'started' });
    }
    if (argumentsJson !== undefined && !call.argumentsSent) {
      call.argumentsSent = true;
      observations.push({ kind: 'tool', callId, name, phase: 'arguments', argumentsJson });
    }
    return observations;
  };
}

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

/** Emits `run-started`, then `unsupported` for every unobserved family plus `extra`. A no-op without a listener. */
export function emitRunStarted(listener: RunObservationListener | undefined, extra: readonly RunObservationFamily[] = []): void {
  if (listener === undefined) return;
  emitObservation(listener, { kind: 'run-started' });
  for (const family of [...unobservedFamilies, ...extra]) emitObservation(listener, { kind: 'unsupported', family });
}
