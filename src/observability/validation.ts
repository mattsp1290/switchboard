import { types } from 'node:util';
import type { Attributes } from '@opentelemetry/api';
import type { ContentObservation, ObserverOptions, TerminalOutcome } from './types.js';

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return;
    result[key] = descriptor.value;
  }
  return result;
}

export function array(value: unknown, limit: number): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null || types.isProxy(value) || !Array.isArray(value)) return;
  if (value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) return;
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return;
    result.push(descriptor.value);
  }
  return result;
}

export function identifier(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export interface Configuration {
  readonly tracer: ObserverOptions['tracer'];
  readonly contentPolicy: { readonly kind: 'none' } | { readonly kind: 'sanitized'; readonly sanitize: (content: ContentObservation) => unknown };
  readonly maxActiveSpans: number;
  readonly maxIdentifierLength: number;
  readonly maxContentBytes: number;
  readonly allowedTools: ReadonlySet<string>;
  readonly admitObservedToolNames: boolean;
  readonly includeConversationId: boolean;
}

export function configuration(options: ObserverOptions): Configuration {
  const input = record(options, ['tracer', 'contentPolicy', 'bounds', 'allowedToolNames', 'admitObservedToolNames', 'includeConversationId']);
  const policy = input && record(input.contentPolicy, ['kind', 'sanitize']);
  if (!input || !policy || (policy.kind !== 'none' && policy.kind !== 'sanitized') ||
      (policy.kind === 'none' && 'sanitize' in policy) ||
      (policy.kind === 'sanitized' && typeof policy.sanitize !== 'function') ||
      (input.includeConversationId !== undefined && typeof input.includeConversationId !== 'boolean') ||
      (input.admitObservedToolNames !== undefined && typeof input.admitObservedToolNames !== 'boolean')) {
    throw new TypeError('Invalid observability configuration');
  }
  const bounds = input.bounds === undefined ? {} : record(input.bounds, ['maxActiveSpans', 'maxIdentifierLength', 'maxContentBytes']);
  if (!bounds) throw new TypeError('Invalid observability configuration');
  const positive = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid observability bounds');
    return value;
  };
  const maxActiveSpans = positive(bounds.maxActiveSpans, 256);
  const maxIdentifierLength = positive(bounds.maxIdentifierLength, 256);
  const maxContentBytes = positive(bounds.maxContentBytes, 16 * 1024);
  const tools = array(input.allowedToolNames, 1024);
  if (!tools || !tools.every(name => identifier(name, maxIdentifierLength))) throw new TypeError('Invalid observability configuration');
  const tracer = options.tracer;
  try {
    if (!input.tracer || typeof tracer.startSpan !== 'function') throw new Error();
  } catch {
    throw new TypeError('Invalid observability configuration');
  }
  const sanitizer = policy.sanitize;
  const contentPolicy: Configuration['contentPolicy'] = typeof sanitizer === 'function'
    ? { kind: 'sanitized', sanitize: content => sanitizer(content) } : { kind: 'none' };
  return {
    tracer, contentPolicy, maxActiveSpans, maxIdentifierLength, maxContentBytes,
    allowedTools: new Set(tools), admitObservedToolNames: input.admitObservedToolNames === true,
    includeConversationId: input.includeConversationId === true,
  };
}

export interface StartObservation {
  readonly kind: 'agent' | 'model' | 'tool';
  readonly name: string;
  readonly attributes: Attributes;
  readonly content: unknown;
}

export function startObservation(operation: unknown, correlation: unknown, config: Configuration): StartObservation | undefined {
  const input = record(operation, ['kind', 'provider', 'name', 'operation', 'requestModel', 'inputMessages', 'callId']);
  const ids = correlation === undefined ? {} : record(correlation, ['runId', 'requestId', 'conversationId']);
  if (!input || !ids) return;
  const attributes: Attributes = {};
  for (const [field, attribute] of [['runId', 'switchboard.run_id'], ['requestId', 'switchboard.request_id'], ['conversationId', 'gen_ai.conversation.id']] as const) {
    const value = ids[field];
    if (value === undefined) continue;
    if (!identifier(value, config.maxIdentifierLength)) return;
    if (field !== 'conversationId' || config.includeConversationId) attributes[attribute] = value;
  }
  const optional = (field: string, attribute: string): boolean => {
    const value = input[field];
    if (value === undefined) return true;
    if (!identifier(value, config.maxIdentifierLength)) return false;
    attributes[attribute] = value;
    return true;
  };
  const exact = (keys: readonly string[]): boolean => Object.keys(input).every(key => keys.includes(key));
  if (input.kind === 'tool') {
    if (!exact(['kind', 'name', 'callId']) || !identifier(input.name, config.maxIdentifierLength) || (!config.admitObservedToolNames && !config.allowedTools.has(input.name)) || !optional('callId', 'gen_ai.tool.call.id')) return;
    attributes['gen_ai.operation.name'] = 'execute_tool';
    attributes['gen_ai.tool.name'] = input.name;
    return { kind: 'tool', name: `execute_tool ${input.name}`, attributes, content: undefined };
  }
  if (!identifier(input.provider, config.maxIdentifierLength)) return;
  attributes['gen_ai.provider.name'] = input.provider;
  if (input.kind === 'agent') {
    if (!exact(['kind', 'provider', 'name']) || !optional('name', 'gen_ai.agent.name')) return;
    attributes['gen_ai.operation.name'] = 'invoke_agent';
    return { kind: 'agent', name: input.name === undefined ? 'invoke_agent' : `invoke_agent ${input.name}`, attributes, content: undefined };
  }
  if (input.kind !== 'model' || !exact(['kind', 'provider', 'operation', 'requestModel', 'inputMessages']) ||
      typeof input.operation !== 'string' || !['chat', 'generate_content', 'text_completion'].includes(input.operation) ||
      !optional('requestModel', 'gen_ai.request.model')) return;
  attributes['gen_ai.operation.name'] = input.operation;
  return { kind: 'model', name: input.requestModel === undefined ? input.operation : `${input.operation} ${input.requestModel}`, attributes, content: input.inputMessages };
}

export function modelObservation(value: unknown, limit: number): { attributes: Attributes; content: unknown } | undefined {
  const input = record(value, ['responseModel', 'usage', 'outputMessages']);
  if (!input) return;
  const attributes: Attributes = {};
  if (input.responseModel !== undefined) {
    if (!identifier(input.responseModel, limit)) return;
    attributes['gen_ai.response.model'] = input.responseModel;
  }
  if (input.usage !== undefined) {
    const usage = record(input.usage, ['inputTokens', 'outputTokens']);
    if (!usage) return;
    for (const [field, attribute] of [['inputTokens', 'gen_ai.usage.input_tokens'], ['outputTokens', 'gen_ai.usage.output_tokens']] as const) {
      const count = usage[field];
      if (count === undefined) continue;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return;
      attributes[attribute] = count;
    }
  }
  return { attributes, content: input.outputMessages };
}

export function terminal(value: unknown): TerminalOutcome | undefined {
  const input = record(value, ['kind', 'category']);
  if (!input) return;
  if (input.kind === 'error') {
    switch (input.category) {
      case 'provider-error': case 'rate-limit': case 'timeout': case 'authentication': case 'tool-error': case 'unknown-error':
        return { kind: 'error', category: input.category };
      default: return;
    }
  }
  if ('category' in input) return;
  switch (input.kind) {
    case 'success': case 'cancelled': case 'outcome-unknown': return { kind: input.kind };
    default: return;
  }
}
