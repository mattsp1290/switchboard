import { EventType } from '@ag-ui/core';
import type { Message, ToolCall } from '@ag-ui/core';
import type { Encoding, MessageKnowledge, ProjectionOptions } from './basic.js';
import { identity, record, reject, string } from './internal.js';
import type { DeepReadonly, Json, NativeRef } from './internal.js';
import { content } from './payloads.js';
import type { NativeContent } from './payloads.js';

type NativeToolCall = DeepReadonly<Omit<ToolCall, 'id'>> & { readonly id: NativeRef };
type NativeMessageMember<M extends Message> = {
  readonly [K in keyof M]:
    K extends 'id' | 'subagentRunId' | 'toolCallId' ? NativeRef
    : K extends 'toolCalls' ? readonly NativeToolCall[]
    : K extends 'content'
      ? M extends { role: 'user' | 'tool' } ? NativeContent : DeepReadonly<M[K]>
      : DeepReadonly<M[K]>;
};
export type NativeMessage<M = Message> = M extends Message ? NativeMessageMember<M> : never;
export type MessagesFact = { readonly kind: 'messages-snapshot'; readonly messages: readonly NativeMessage[]; readonly timestamp?: number };

function object(value: unknown): Record<string, Json> {
  const fields = record(value, value && typeof value === 'object' ? Object.keys(value) : []);
  return fields as Record<string, Json>;
}

export function encodeMessages(value: Json, options: ProjectionOptions): Encoding {
  const fact = record(value, ['kind', 'messages', 'timestamp']);
  if (!Array.isArray(fact.messages)) reject();
  const timestamp = fact.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) reject();
  const id = (kind: string, ref: unknown) => identity(options.sourceKey, kind, ref);
  const knowledge = new Map<string, MessageKnowledge>();
  const owners = new Set<string>();
  const calls = new Set<string>();
  const optional = (fields: Record<string, unknown>) => ({
    ...(fields.encryptedValue === undefined ? {} : { encryptedValue: string(fields.encryptedValue) }),
    ...(fields.metadata === undefined ? {} : { metadata: object(fields.metadata) }),
  });
  const toolCall = (value: unknown): ToolCall => {
    const fields = record(value, ['id', 'type', 'function', 'encryptedValue', 'metadata']);
    const toolId = id('tool', fields.id);
    if (calls.has(toolId)) reject('identity-conflict');
    calls.add(toolId);
    if (fields.type !== 'function') reject();
    const fn = record(fields.function, ['name', 'arguments']);
    return { id: toolId, type: 'function', function: { name: string(fn.name), arguments: string(fn.arguments) }, ...optional(fields) };
  };
  const messages = fact.messages.map((value: unknown): Message => {
    const fields = record(value, ['id', 'role', 'subagentRunId', 'name', 'content', 'toolCalls', 'toolCallId',
      'activityType', 'encryptedValue', 'metadata', 'error']);
    const messageId = id('message', fields.id);
    if (knowledge.has(messageId)) reject('identity-conflict');
    const owner = fields.subagentRunId === undefined ? undefined : id('subagent', fields.subagentRunId);
    if (owner !== undefined) owners.add(owner);
    const common = { id: messageId, ...(owner === undefined ? {} : { subagentRunId: owner }), ...optional(fields) };
    const allowed = (keys: readonly string[]) => record(value, ['id', 'role', 'subagentRunId', 'metadata', ...keys]);
    const named = () => fields.name === undefined ? {} : { name: string(fields.name) };
    switch (fields.role) {
      case 'assistant': {
        allowed(['content', 'name', 'toolCalls', 'encryptedValue']);
        if (fields.toolCalls !== undefined && !Array.isArray(fields.toolCalls)) reject();
        knowledge.set(messageId, { role: 'assistant', owner, constrained: false });
        return { ...common, role: 'assistant', ...named(),
          ...(fields.content === undefined ? {} : { content: string(fields.content) }),
          ...(fields.toolCalls === undefined ? {} : { toolCalls: fields.toolCalls.map(toolCall) }) };
      }
      case 'developer': case 'system': case 'user':
        allowed(['content', 'name', 'encryptedValue']);
        knowledge.set(messageId, { role: 'other' });
        return fields.role === 'user'
          ? { ...common, role: 'user', ...named(), content: content(fields.content, options.sourceKey) }
          : { ...common, role: fields.role, ...named(), content: string(fields.content) };
      case 'tool':
        allowed(['content', 'toolCallId', 'error', 'encryptedValue']);
        knowledge.set(messageId, { role: 'other' });
        return { ...common, role: 'tool', toolCallId: id('tool', fields.toolCallId), content: content(fields.content, options.sourceKey),
          ...(fields.error === undefined ? {} : { error: string(fields.error) }) };
      case 'activity': {
        allowed(['content', 'activityType']);
        const activityType = string(fields.activityType);
        knowledge.set(messageId, { role: 'activity', owner });
        return { ...common, role: 'activity', activityType, content: object(fields.content) };
      }
      case 'reasoning':
        allowed(['content', 'encryptedValue']);
        knowledge.set(messageId, { role: 'reasoning' });
        return { ...common, role: 'reasoning', content: string(fields.content) };
      default:
        return reject();
    }
  });
  return { transition: { kind: 'messages', knowledge: [...knowledge], owners: [...owners] }, events: [{
    type: EventType.MESSAGES_SNAPSHOT, messages, ...(timestamp === undefined ? {} : { timestamp }),
  }] };
}
