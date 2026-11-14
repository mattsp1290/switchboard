import { EventType } from '@ag-ui/core';
import type { Interrupt, TokenUsage } from '@ag-ui/core';
import type { Encoding, ProjectionOptions } from './basic.js';
import { identity, record, reject, string } from './internal.js';
import type { DeepReadonly, Json, NativeRef } from './internal.js';

export type NativeInterrupt = DeepReadonly<Omit<Interrupt, 'id' | 'toolCallId' | 'subagentRunId' | 'responseSchema' | 'metadata'>> & {
  readonly interrupt: NativeRef;
  readonly tool?: NativeRef;
  readonly owner?: NativeRef;
  readonly responseSchema?: { readonly [key: string]: Json };
  readonly metadata?: { readonly [key: string]: Json };
};
export type NativeTokenUsage = DeepReadonly<TokenUsage>;
const publicFailures = Object.freeze({
  'native-failure': 'The native run failed.',
  'transport-failure': 'The native run transport failed.',
});
export type PublicFailure = keyof typeof publicFailures;
export type TerminalFact = { readonly timestamp?: number; readonly usage?: readonly NativeTokenUsage[] } & (
  | { readonly kind: 'run-finished'; readonly outcome: 'success'; readonly result?: Json; readonly pendingTools?: readonly NativeRef[] }
  | { readonly kind: 'run-finished'; readonly outcome: 'cancelled' }
  | { readonly kind: 'run-finished'; readonly outcome: 'interrupt'; readonly interrupts: readonly [NativeInterrupt, ...NativeInterrupt[]] }
  | { readonly kind: 'run-failed'; readonly failure: PublicFailure }
);

const counts = [
  'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
] as const satisfies readonly (keyof TokenUsage)[];
function usage(value: unknown): TokenUsage[] {
  if (!Array.isArray(value)) reject();
  const identified = new Set<string>();
  return value.map((item: unknown) => {
    const row = record(item, ['provider', 'model', ...counts]);
    for (const key of ['provider', 'model']) if (row[key] !== undefined) string(row[key]);
    for (const key of counts) {
      const count = row[key];
      if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) reject();
    }
    const parsed = row as TokenUsage;
    const count = (key: typeof counts[number]) => BigInt(parsed[key] ?? 0);
    const input = count('inputTokens');
    const output = count('outputTokens');
    const total = count('totalTokens');
    const cache = count('cachedInputTokens') + count('cacheWriteInputTokens');
    const reasoning = count('reasoningTokens');
    const minimum = (parsed.inputTokens === undefined ? cache : input) + (parsed.outputTokens === undefined ? reasoning : output);
    if (cache > BigInt(Number.MAX_SAFE_INTEGER) || minimum > BigInt(Number.MAX_SAFE_INTEGER)) reject();
    if (parsed.inputTokens !== undefined && cache > input) reject();
    if (parsed.outputTokens !== undefined && reasoning > output) reject();
    if (parsed.totalTokens !== undefined && (total < minimum ||
      (parsed.inputTokens !== undefined && parsed.outputTokens !== undefined && total !== input + output))) reject();
    if (parsed.provider !== undefined && parsed.model !== undefined) {
      const pair = JSON.stringify([parsed.provider, parsed.model]);
      if (identified.has(pair)) reject();
      identified.add(pair);
    }
    return parsed;
  });
}

function interrupt(value: unknown, sourceKey: string): Interrupt {
  const fields = record(value, ['interrupt', 'reason', 'message', 'tool', 'owner', 'responseSchema', 'expiresAt', 'metadata']);
  const strings = Object.fromEntries(['message', 'expiresAt']
    .filter(key => fields[key] !== undefined).map(key => [key, string(fields[key])]));
  const objects = Object.fromEntries(['responseSchema', 'metadata'].filter(key => fields[key] !== undefined).map(key => {
    const value = fields[key];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
    return [key, value];
  }));
  return { id: identity(sourceKey, 'interrupt', fields.interrupt), reason: string(fields.reason), ...strings, ...objects,
    ...(fields.tool === undefined ? {} : { toolCallId: identity(sourceKey, 'tool', fields.tool) }),
    ...(fields.owner === undefined ? {} : { subagentRunId: identity(sourceKey, 'subagent', fields.owner) }),
  };
}

export function encodeTerminals(value: Json, options: ProjectionOptions): Encoding {
  const fact = record(value, ['kind', 'timestamp', 'usage', 'outcome', 'result', 'pendingTools', 'interrupts', 'failure']);
  const timestamp = fact.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) reject();
  const common = {
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(fact.usage === undefined ? {} : { usage: usage(fact.usage) }),
  };
  if (fact.kind === 'run-failed') {
    record(value, ['kind', 'timestamp', 'usage', 'failure']);
    const code = fact.failure;
    if (code !== 'native-failure' && code !== 'transport-failure') reject();
    return { transition: { kind: 'fail' }, events: [{ type: EventType.RUN_ERROR, ...common, code, message: publicFailures[code] }] };
  }
  if (fact.kind !== 'run-finished') reject();
  const base = { type: EventType.RUN_FINISHED, ...common, threadId: options.threadId, runId: options.runId } as const;
  switch (fact.outcome) {
    case 'success': {
      record(value, ['kind', 'timestamp', 'usage', 'outcome', 'result', 'pendingTools']);
      if (fact.pendingTools !== undefined && !Array.isArray(fact.pendingTools)) reject();
      const pending = fact.pendingTools === undefined ? undefined : fact.pendingTools.map((ref: unknown) => identity(options.sourceKey, 'tool', ref));
      return { transition: { kind: 'finish', ...(pending === undefined ? {} : { pending }) }, events: [{ ...base,
        outcome: { type: 'success', ...(pending === undefined ? {} : { pendingToolCallIds: pending }) },
        ...('result' in fact && fact.result !== null ? { result: fact.result } : {}),
      }] };
    }
    case 'cancelled':
      record(value, ['kind', 'timestamp', 'usage', 'outcome']);
      return { transition: { kind: 'finish' }, events: [{ ...base, outcome: { type: 'cancelled' } }] };
    case 'interrupt': {
      record(value, ['kind', 'timestamp', 'usage', 'outcome', 'interrupts']);
      if (!Array.isArray(fact.interrupts) || fact.interrupts.length === 0) reject();
      const interrupts = fact.interrupts.map((value: unknown) => interrupt(value, options.sourceKey));
      return { transition: { kind: 'finish', interrupts: interrupts.map(item => ({ id: item.id,
        ...(item.toolCallId === undefined ? {} : { tool: item.toolCallId }),
        ...(item.subagentRunId === undefined ? {} : { owner: item.subagentRunId }),
      })) }, events: [{ ...base, outcome: { type: 'interrupt', interrupts } }] };
    }
    default:
      return reject();
  }
}
