import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { tokenCount, usageFromCounts } from '#switchboard';
import type { RunObservation, RunObservationUsage } from '#switchboard';

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];

/** `inputTokens` includes the cache fields that are present. `totalTokens` is left to the consumer. */
function usageRow(raw: Readonly<Record<string, unknown>>): RunObservationUsage | undefined {
  const input = tokenCount(raw.input_tokens);
  const read = tokenCount(raw.cache_read_input_tokens);
  const write = tokenCount(raw.cache_creation_input_tokens);
  return usageFromCounts({
    inputTokens: input !== undefined || read !== undefined || write !== undefined ? (input ?? 0) + (read ?? 0) + (write ?? 0) : undefined,
    outputTokens: raw.output_tokens,
    cachedInputTokens: raw.cache_read_input_tokens,
    cacheWriteInputTokens: raw.cache_creation_input_tokens,
  });
}

/** The observation-only state for one Claude turn: block kinds, accumulated usage, and the request model. */
export function createStreamObserver(observe: (observation: RunObservation) => void, requestModel: string) {
  const kinds = new Map<number, { readonly kind: 'thinking' | 'tool'; readonly id: string; readonly name: string }>();
  let usage: Record<string, unknown> = {};
  let model: string | undefined;
  return {
    messageStart(message: { readonly model: string; readonly usage: unknown }): void {
      kinds.clear();
      model = message.model;
      usage = { ...(message.usage as object) };
    },
    /** Every stream event other than message_start and text blocks. */
    event(streamId: string, event: StreamEvent): void {
      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        kinds.set(event.index, { kind: 'thinking', id: `${streamId}:${event.index}`, name: '' });
        if (event.content_block.thinking) observe({ kind: 'reasoning', messageId: `${streamId}:${event.index}`, mode: 'delta', text: event.content_block.thinking });
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        kinds.set(event.index, { kind: 'tool', id: event.content_block.id, name: event.content_block.name });
        observe({ kind: 'tool', callId: event.content_block.id, name: event.content_block.name, phase: 'started' });
      } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
        const block = kinds.get(event.index);
        if (block?.kind === 'thinking') observe({ kind: 'reasoning', messageId: block.id, mode: 'delta', text: event.delta.thinking });
      } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        const block = kinds.get(event.index);
        if (block?.kind === 'tool') observe({ kind: 'tool', callId: block.id, name: block.name, phase: 'arguments', argumentsJson: event.delta.partial_json });
      } else if (event.type === 'content_block_stop') {
        const block = kinds.get(event.index);
        if (block?.kind === 'tool') observe({ kind: 'tool', callId: block.id, name: block.name, phase: 'arguments-ended' });
        kinds.delete(event.index);
      } else if (event.type === 'message_delta') {
        for (const [key, value] of Object.entries(event.usage)) if (tokenCount(value) !== undefined) usage[key] = value;
      } else if (event.type === 'message_stop') {
        // The model boundary is emitted only here: a request interrupted before message_stop records no model span.
        const row = usageRow(usage);
        observe({ kind: 'model-boundary', requestModel, ...(model === undefined ? {} : { responseModel: model }),
          ...(row ? { usage: row } : {}) });
      }
    },
    resultUsage(raw: unknown): RunObservationUsage | undefined {
      return usageRow({ ...(raw as object) });
    },
  };
}
