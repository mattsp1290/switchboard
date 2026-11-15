import { types } from 'node:util';
import { array, record } from './validation.js';
import type { Configuration } from './validation.js';
import type { ContentObservation, InputMessage, OutputMessage, TextPart } from './types.js';

function snapshot(kind: 'input' | 'output', value: unknown, limit: number): ContentObservation | undefined {
  const messages = array(value, limit);
  if (!messages) return;
  const inputs: InputMessage[] = [];
  const outputs: OutputMessage[] = [];
  let traversed = 0;
  for (const message of messages) {
    const input = record(message, kind === 'input' ? ['role', 'parts'] : ['role', 'parts', 'finish_reason']);
    if (!input) return;
    const parts = array(input.parts, limit);
    if (!parts) return;
    const texts: TextPart[] = [];
    for (const part of parts) {
      const text = record(part, ['type', 'content']);
      if (!text || text.type !== 'text' || typeof text.content !== 'string') return;
      traversed += text.content.length + 28;
      if (traversed > limit) return;
      texts.push(Object.freeze({ type: 'text', content: text.content }));
    }
    traversed += 32;
    if (traversed > limit) return;
    Object.freeze(texts);
    if (kind === 'input') {
      if (input.role !== 'system' && input.role !== 'user' && input.role !== 'assistant') return;
      inputs.push(Object.freeze({ role: input.role, parts: texts }));
    } else {
      if (input.role !== 'assistant') return;
      switch (input.finish_reason) {
        case 'stop': case 'length': case 'content_filter': case 'tool_call': case 'error':
          outputs.push(Object.freeze({ role: input.role, parts: texts, finish_reason: input.finish_reason }));
          break;
        default: return;
      }
    }
  }
  const result: ContentObservation = kind === 'input'
    ? { kind, messages: Object.freeze(inputs) } : { kind, messages: Object.freeze(outputs) };
  if (Buffer.byteLength(JSON.stringify(result.messages), 'utf8') > limit) return;
  return Object.freeze(result);
}

export function sanitizedContent(
  kind: 'input' | 'output', value: unknown, config: Configuration, availableBytes: number,
): { readonly kind: 'omitted' | 'dropped' } | { readonly kind: 'content'; readonly json: string; readonly bytes: number } {
  if (config.contentPolicy.kind === 'none' || value === undefined) return { kind: 'omitted' };
  try {
    const input = snapshot(kind, value, config.maxContentBytes);
    if (!input) return { kind: 'dropped' };
    const sanitized = config.contentPolicy.sanitize(input);
    if (types.isPromise(sanitized)) {
      void Promise.prototype.then.call(sanitized, undefined, () => undefined);
      return { kind: 'dropped' };
    }
    const result = record(sanitized, ['kind', 'messages']);
    if (!result || result.kind !== kind) return { kind: 'dropped' };
    const output = snapshot(kind, result.messages, availableBytes);
    if (!output) return { kind: 'dropped' };
    const json = JSON.stringify(output.messages);
    return { kind: 'content', json, bytes: Buffer.byteLength(json, 'utf8') };
  } catch {
    return { kind: 'dropped' };
  }
}
