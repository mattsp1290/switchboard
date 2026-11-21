import type { NativeExtension, Outcome } from './contracts.js';
import type { HostSegmentResult } from './host-adapter.js';

/** Every `ProjectionFamily` name, repeated here so adapters do not import `src/agui`. The baseline checks both lists match. */
export const runObservationFamilies = Object.freeze([
  'state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'usage', 'reasoning', 'subagents',
] as const);
export type RunObservationFamily = typeof runObservationFamilies[number];
/** The families no exported runtime can observe today. Each runtime declares them unsupported when its turn starts. */
export const unobservedFamilies = Object.freeze(['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents'] as const);

/**
 * Native counts already renamed to the AG-UI `TokenUsage` names. A count the native value did not carry is absent.
 * `inputTokens` includes cached input (cache read plus cache write); those counts are also reported separately.
 */
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
  /**
   * Rows are native counts and are never summed. A later row with the same (provider, model) key replaces an earlier
   * one, so the terminal usage is the most recent row per key. Scope differs by runtime: Claude and Codex text report
   * the turn total (Cursor included: its usage message is per-turn); OpenCode reports the prompt-response usage only (its usage_update carries no token counts); Pi and Pi-host
   * report the most recent request only (per-request rows share one key); `./host/codex` reports the thread-cumulative
   * `total`, which includes earlier segments and survives resume.
   */
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

/** `true` for an absent listener or a function, so `!isOptionalObservationListener(value)` is the request check. */
export function isOptionalObservationListener(value: unknown): value is RunObservationListener | undefined {
  return value === undefined || typeof value === 'function';
}

/** A non-negative safe integer token count, or `undefined`. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

type UsageCountKey = Exclude<keyof RunObservationUsage, 'provider' | 'model'>;
/** The token-count fields of a `RunObservationUsage`. Not part of the root barrel. */
export const usageCountKeys: readonly UsageCountKey[] = [
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

/**
 * A usage row from native counts whose `input` excludes the cache buckets: `inputTokens` is the input plus every valid cache
 * count (absent only when none of the three is valid). Each count is validated with `tokenCount`; `output`, `reasoning`, and
 * `total` pass through as given.
 */
export function usageFromUncachedCounts(raw: {
  readonly input?: unknown; readonly output?: unknown; readonly cacheRead?: unknown; readonly cacheWrite?: unknown;
  readonly reasoning?: unknown; readonly total?: unknown;
}): RunObservationUsage | undefined {
  const input = tokenCount(raw.input);
  const read = tokenCount(raw.cacheRead);
  const write = tokenCount(raw.cacheWrite);
  return usageFromCounts({
    inputTokens: input !== undefined || read !== undefined || write !== undefined ? (input ?? 0) + (read ?? 0) + (write ?? 0) : undefined,
    outputTokens: raw.output,
    totalTokens: raw.total,
    reasoningTokens: raw.reasoning,
    cachedInputTokens: read,
    cacheWriteInputTokens: write,
  });
}

/** `usageFromCounts` then `normalizeUsage`: the shared tail of every adapter's native-usage mapping. */
export function normalizedUsageFromCounts(raw: Parameters<typeof usageFromCounts>[0]): RunObservationUsage | undefined {
  const row = usageFromCounts(raw);
  return row === undefined ? undefined : normalizeUsage(row);
}

/** The text runtimes' public outcome as a terminal observation outcome. */
export const runtimeOutcome = Object.freeze({ completed: 'success', failed: 'failed', interrupted: 'cancelled' } as const);

/**
 * A host segment result as its terminal observation. A failure whose write is `outcome-unknown` is always
 * `outcome-unknown`; any other failure is `failedAs`. No result (the segment threw after the run started) is `outcome-unknown`. A pending segment succeeds with its call ids pending.
 */
export function segmentTerminal(result: HostSegmentResult | undefined, failedAs: Exclude<RunObservationOutcome, 'success'> = 'failed'): RunObservation {
  if (result === undefined) return { kind: 'terminal', outcome: 'outcome-unknown' };
  switch (result.kind) {
    case 'complete': return { kind: 'terminal', outcome: 'success' };
    case 'pending': return { kind: 'terminal', outcome: 'success',
      pendingTools: result.calls.map((call) => call.pending.target.nativeToolCallId) };
    case 'failed': return { kind: 'terminal', outcome: result.write.kind === 'outcome-unknown' ? 'outcome-unknown' : failedAs };
  }
}

/** A host tool call's declaration: `started`, then `arguments-ended` (with the JSON-safe arguments when there are any). */
export function declaredToolObservations(callId: string, name: string, args: unknown): readonly RunObservation[] {
  const argumentsJson = jsonString(args);
  return [
    { kind: 'tool', callId, name, phase: 'started' },
    { kind: 'tool', callId, name, phase: 'arguments-ended', ...(argumentsJson === undefined ? {} : { argumentsJson }) },
  ];
}

/** Replays one answered host tool call into a continuation segment: started, its arguments, then the observed result. */
export function answeredToolObservations(callId: string, name: string, args: unknown,
  result: Outcome<NativeExtension, NativeExtension>): readonly RunObservation[] {
  // A failed answer is replayed with its error payload too: natively the model received it as the call's result.
  const resultJson = jsonString(result.kind === 'ok' ? result.value.data : result.error.data);
  return [
    ...declaredToolObservations(callId, name, args),
    { kind: 'tool', callId, name, phase: result.kind === 'ok' ? 'completed' : 'failed', ...(resultJson === undefined ? {} : { resultJson }) },
  ];
}

/** Opens calls (see `createToolTracker`). */
export type ToolTracker = (callId: string, name: string, argumentsJson: string | undefined) => readonly RunObservation[];

/**
 * Opening phases for adapters that see a tool call several times: `started` once per call, then `arguments` once
 * when JSON-safe arguments first appear. A `{}` placeholder is not arguments: it is held back for the first other value. The caller emits the closing phase itself.
 */
export function createToolTracker(): ToolTracker {
  const calls = new Map<string, { argumentsSent: boolean }>();
  const open: ToolTracker = (callId, name, argumentsJson) => {
    const observations: RunObservation[] = [];
    let call = calls.get(callId);
    if (call === undefined) {
      call = { argumentsSent: false };
      calls.set(callId, call);
      observations.push({ kind: 'tool', callId, name, phase: 'started' });
    }
    if (argumentsJson !== undefined && argumentsJson !== '{}' && !call.argumentsSent) {
      call.argumentsSent = true;
      observations.push({ kind: 'tool', callId, name, phase: 'arguments', argumentsJson });
    }
    return observations;
  };
  return open;
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
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Passes a deeply frozen copy of `observation` (the caller's object is never frozen) to `listener`, swallowing any throw. Absent listeners are not called. A listener
 * failure never changes admission, a public callback, or a terminal outcome.
 */
export function emitObservation(listener: RunObservationListener | undefined, observation: RunObservation): void {
  if (listener === undefined) return;
  try {
    listener(freezeDeep(structuredClone(observation)));
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
