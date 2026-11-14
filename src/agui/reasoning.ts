import { EventType } from '@ag-ui/core';
import type { Event, ReasoningMessageStartEvent } from '@ag-ui/core';
import type { Encoding, ProjectionOptions } from './basic.js';
import { identity, record, reject, string } from './internal.js';
import type { Json, NativeRef } from './internal.js';

export type ReasoningTarget =
  | { readonly kind: 'message'; readonly message: NativeRef }
  | { readonly kind: 'tool'; readonly tool: NativeRef };
export type ReasoningFact = { readonly timestamp?: number; readonly owner?: NativeRef } & (
  | { readonly kind: 'reasoning-started' | 'reasoning-ended'; readonly span: NativeRef }
  | { readonly kind: 'reasoning-message-started'; readonly message: NativeRef; readonly role: ReasoningMessageStartEvent['role'] }
  | { readonly kind: 'reasoning-message-content'; readonly message: NativeRef; readonly delta: string }
  | { readonly kind: 'reasoning-message-ended'; readonly message: NativeRef }
  | { readonly kind: 'reasoning-message-complete'; readonly message: NativeRef;
      readonly role: ReasoningMessageStartEvent['role']; readonly text: string }
  | { readonly kind: 'reasoning-encrypted-value'; readonly target: ReasoningTarget; readonly encryptedValue: string }
);

export function encodeReasoning(value: Json, options: ProjectionOptions): Encoding {
  const fact = record(value, ['kind', 'timestamp', 'owner', 'span', 'message', 'role', 'delta', 'text', 'target', 'encryptedValue']);
  const id = (kind: string, ref: unknown) => identity(options.sourceKey, kind, ref);
  const timestamp = fact.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) reject();
  const owner = fact.owner === undefined ? undefined : id('subagent', fact.owner);
  const common = { ...(timestamp === undefined ? {} : { timestamp }), ...(owner === undefined ? {} : { subagentRunId: owner }) };
  const allowed = (keys: readonly string[]) => record(value, ['kind', 'timestamp', 'owner', ...keys]);
  switch (fact.kind) {
    case 'reasoning-encrypted-value': {
      allowed(['target', 'encryptedValue']);
      const target = record(fact.target, ['kind', 'message', 'tool']);
      if (target.kind !== 'message' && target.kind !== 'tool') reject();
      record(fact.target, ['kind', target.kind]);
      const entityId = id(target.kind, target[target.kind]);
      return { transition: { kind: 'encrypted', id: entityId, owner }, events: [{
        type: EventType.REASONING_ENCRYPTED_VALUE, ...common, subtype: target.kind === 'tool' ? 'tool-call' : 'message', entityId,
        encryptedValue: string(fact.encryptedValue),
      }] };
    }
    case 'reasoning-started':
    case 'reasoning-ended': {
      allowed(['span']);
      const messageId = id('reasoning-span', fact.span);
      return fact.kind === 'reasoning-started'
        ? { transition: { kind: 'open', id: messageId, stream: { kind: 'reasoning-span', owner, open: true } },
          events: [{ type: EventType.REASONING_START, ...common, messageId }] }
        : { transition: { kind: 'end', id: messageId, entityKind: 'reasoning-span', owner },
          events: [{ type: EventType.REASONING_END, ...common, messageId }] };
    }
    case 'reasoning-message-started':
    case 'reasoning-message-complete': {
      const complete = fact.kind === 'reasoning-message-complete';
      allowed(complete ? ['message', 'role', 'text'] : ['message', 'role']);
      if (fact.role !== 'reasoning') reject();
      const messageId = id('message', fact.message);
      const events: Event[] = [{ type: EventType.REASONING_MESSAGE_START, ...common, messageId, role: fact.role }];
      if (complete) events.push(
        { type: EventType.REASONING_MESSAGE_CONTENT, ...common, messageId, delta: string(fact.text) },
        { type: EventType.REASONING_MESSAGE_END, ...common, messageId },
      );
      return { transition: { kind: 'open', id: messageId, stream: { kind: 'reasoning-message', owner, open: !complete } }, events };
    }
    case 'reasoning-message-content':
    case 'reasoning-message-ended': {
      const delta = fact.kind === 'reasoning-message-content';
      allowed(delta ? ['message', 'delta'] : ['message']);
      const messageId = id('message', fact.message);
      return { transition: { kind: delta ? 'content' : 'end', id: messageId, entityKind: 'reasoning-message', owner }, events: [delta
        ? { type: EventType.REASONING_MESSAGE_CONTENT, ...common, messageId, delta: string(fact.delta) }
        : { type: EventType.REASONING_MESSAGE_END, ...common, messageId }] };
    }
    default:
      return reject();
  }
}
