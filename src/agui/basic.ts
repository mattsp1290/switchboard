import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import type { Event, TextMessageRole } from '@ag-ui/core';
import type { Outcome } from '../core/contracts.js';
import { capture, errorResult, failure, identity, readBounds, record, reject, string } from './internal.js';
import { content } from './payloads.js';
import type { NativeContent } from './payloads.js';
import type { DeepReadonly, Json, NativeRef, ProjectionBounds, ProjectionError } from './internal.js';

export interface ProjectionOptions {
  readonly threadId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly sourceKey: string;
  readonly bounds: ProjectionBounds;
}

const publicFailures = Object.freeze({
  'native-failure': 'The native run failed.',
  'transport-failure': 'The native run transport failed.',
});
export type PublicFailure = keyof typeof publicFailures;
export type BasicEntityFact = { readonly owner?: NativeRef } & (
  | { readonly kind: 'text-started'; readonly message: NativeRef; readonly role: TextMessageRole; readonly name?: string }
  | { readonly kind: 'text-content'; readonly message: NativeRef; readonly delta: string }
  | { readonly kind: 'text-ended'; readonly message: NativeRef }
  | { readonly kind: 'text-complete'; readonly message: NativeRef; readonly role: TextMessageRole;
      readonly name?: string; readonly text: string }
  | { readonly kind: 'tool-started'; readonly tool: NativeRef; readonly name: string; readonly parentMessage?: NativeRef }
  | { readonly kind: 'tool-arguments'; readonly tool: NativeRef; readonly delta: string }
  | { readonly kind: 'tool-arguments-ended'; readonly tool: NativeRef }
  | { readonly kind: 'tool-result'; readonly tool: NativeRef; readonly resultMessage: NativeRef; readonly content: NativeContent }
  | { readonly kind: 'step-started'; readonly step: NativeRef; readonly name?: string }
  | { readonly kind: 'step-finished'; readonly step: NativeRef }
);
export type BasicFact = { readonly timestamp?: number } & (
  | { readonly kind: 'run-started' }
  | { readonly kind: 'run-finished'; readonly outcome: 'success';
      readonly result?: Json; readonly pendingTools?: readonly NativeRef[] }
  | { readonly kind: 'run-finished'; readonly outcome: 'cancelled' }
  | { readonly kind: 'run-failed'; readonly failure: PublicFailure }
  | BasicEntityFact
);
export type ProjectionEvent = DeepReadonly<Event>;
export type ProjectionResult =
  | { readonly kind: 'mapped'; readonly events: readonly ProjectionEvent[] }
  | { readonly kind: 'error'; readonly error: ProjectionError };
export interface Projection<F> {
  accept(fact: F): ProjectionResult;
  close(): void;
}

type Phase = 'idle' | 'running' | 'finished' | 'errored' | 'faulted' | 'closed';
type StreamKind = 'text' | 'tool' | 'step';
type Opener =
  | { readonly kind: 'text'; readonly role: TextMessageRole; readonly name?: string }
  | { readonly kind: 'tool'; readonly name: string; readonly parentMessageId?: string }
  | { readonly kind: 'step' };
type Stream = Opener & {
  readonly owner: string | undefined;
  readonly open: boolean;
} & ({ readonly kind: 'tool'; readonly result?: string } | { readonly kind: 'text' | 'step' });
type Entity = Stream
  | { readonly kind: 'result'; readonly owner: string | undefined; readonly tool: string; readonly open: false }
  | { readonly kind: 'owner'; readonly open: false }
  | { readonly kind: 'observation'; readonly open: false }
  | { readonly kind: 'activity'; readonly owner: string | undefined; readonly open: false };
export type MessageKnowledge =
  | { readonly role: 'assistant'; readonly owner: string | undefined; readonly constrained: boolean }
  | { readonly role: 'activity'; readonly owner: string | undefined }
  | { readonly role: 'reasoning' | 'other' };
type Transition =
  | { readonly kind: 'messages'; readonly knowledge: readonly (readonly [string, MessageKnowledge])[]; readonly owners: readonly string[] }
  | { readonly kind: 'observe'; readonly owner: string | undefined }
  | { readonly kind: 'activity'; readonly id: string; readonly owner: string | undefined;
      readonly mode: 'replace' | 'preserve' | 'delta' }
  | { readonly kind: 'start' }
  | { readonly kind: 'fail' }
  | { readonly kind: 'finish'; readonly pending?: readonly string[] }
  | { readonly kind: 'open'; readonly id: string; readonly stream: Stream }
  | { readonly kind: 'content' | 'end'; readonly id: string; readonly entityKind: StreamKind; readonly owner: string | undefined }
  | { readonly kind: 'result'; readonly id: string; readonly messageId: string; readonly owner: string | undefined };
export interface Encoding {
  readonly events: readonly Event[];
  readonly transition: Transition;
}

export type Encode = (fact: Json, options: ProjectionOptions) => Encoding;

function readOptions(value: unknown): ProjectionOptions {
  const fields = record(value, ['threadId', 'runId', 'parentRunId', 'sourceKey', 'bounds']);
  const bounds = readBounds(fields.bounds);
  const snapshot = record(capture({ ...fields, bounds }, bounds), Object.keys(fields));
  const { threadId, runId, parentRunId, sourceKey } = snapshot;
  if (typeof threadId !== 'string' || typeof runId !== 'string' || typeof sourceKey !== 'string') reject();
  if (parentRunId !== undefined && typeof parentRunId !== 'string') reject();
  return Object.freeze({ threadId, runId, sourceKey, bounds,
    ...(parentRunId === undefined ? {} : { parentRunId }),
  });
}

export function encodeBasic(value: Json, options: ProjectionOptions): Encoding {
  const fact = record(value, ['kind', 'timestamp', 'outcome', 'result', 'failure', 'pendingTools',
    'owner', 'message', 'role', 'name', 'text', 'delta', 'tool', 'parentMessage', 'resultMessage', 'content', 'step']);
  const timestamp = fact.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) reject();
  const observed = timestamp === undefined ? {} : { timestamp };
  const { threadId, runId } = options;
  switch (fact.kind) {
    case 'run-started':
      record(value, ['kind', 'timestamp']);
      return { transition: { kind: 'start' }, events: [{
        type: EventType.RUN_STARTED, ...observed, threadId, runId,
        protocolVersion: PROTOCOL_VERSION,
        ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      }] };
    case 'run-finished': {
      record(value, fact.outcome === 'success' ? ['kind', 'timestamp', 'outcome', 'result', 'pendingTools'] : ['kind', 'timestamp', 'outcome']);
      if (fact.outcome !== 'success' && fact.outcome !== 'cancelled') reject();
      const pending = fact.pendingTools;
      if (pending !== undefined && !Array.isArray(pending)) reject();
      const ids = pending === undefined ? undefined : pending.map((ref: unknown) => identity(options.sourceKey, 'tool', ref));
      return { transition: { kind: 'finish', ...(ids === undefined ? {} : { pending: ids }) }, events: [{
        type: EventType.RUN_FINISHED, ...observed, threadId, runId,
        outcome: { type: fact.outcome, ...(ids === undefined ? {} : { pendingToolCallIds: ids }) },
        ...('result' in fact && fact.result !== null ? { result: fact.result } : {}),
      }] };
    }
    case 'run-failed': {
      record(value, ['kind', 'timestamp', 'failure']);
      const code = fact.failure;
      if (code !== 'native-failure' && code !== 'transport-failure') reject();
      return { transition: { kind: 'fail' }, events: [{
        type: EventType.RUN_ERROR, ...observed, code, message: publicFailures[code],
      }] };
    }
    default:
      return encodeEntity(fact, options, observed);
  }
}

function encodeEntity(fact: Record<string, unknown>, options: ProjectionOptions, observed: { readonly timestamp?: number }): Encoding {
  const id = (kind: string, ref: unknown) => identity(options.sourceKey, kind, ref);
  const owner = fact.owner === undefined ? undefined : id('subagent', fact.owner);
  const common = { ...observed, ...(owner === undefined ? {} : { subagentRunId: owner }) };
  const fields = (keys: readonly string[]) => record(fact, ['kind', 'timestamp', 'owner', ...keys]);
  const open = (key: string, opener: Opener, events: Event[], closed = false): Encoding => ({
    events, transition: { kind: 'open', id: key, stream: { ...opener, owner, open: !closed } },
  });
  switch (fact.kind) {
    case 'text-started':
    case 'text-complete': {
      fields(fact.kind === 'text-started' ? ['message', 'role', 'name'] : ['message', 'role', 'name', 'text']);
      const messageId = id('message', fact.message);
      const role = fact.role;
      if (role !== 'assistant' && role !== 'user' && role !== 'system' && role !== 'developer') reject();
      const name = fact.name === undefined ? {} : { name: string(fact.name) };
      const events: Event[] = [{ type: EventType.TEXT_MESSAGE_START, ...common, messageId, role, ...name }];
      if (fact.kind === 'text-complete') events.push(
        { type: EventType.TEXT_MESSAGE_CONTENT, ...common, messageId, delta: string(fact.text) },
        { type: EventType.TEXT_MESSAGE_END, ...common, messageId },
      );
      return open(messageId, { kind: 'text', role, ...name }, events, fact.kind === 'text-complete');
    }
    case 'tool-started': {
      fields(['tool', 'name', 'parentMessage']);
      const toolCallId = id('tool', fact.tool);
      const toolCallName = string(fact.name);
      const parent = fact.parentMessage === undefined ? {} : { parentMessageId: id('message', fact.parentMessage) };
      return open(toolCallId, { kind: 'tool', name: toolCallName, ...parent }, [{
        type: EventType.TOOL_CALL_START, ...common, toolCallId, toolCallName, ...parent,
      }]);
    }
    case 'step-started': {
      fields(['step', 'name']);
      const stepName = id('step', fact.step);
      const name = fact.name === undefined ? {} : { name: string(fact.name) };
      return open(stepName, { kind: 'step' }, [{ type: EventType.STEP_STARTED, ...common, stepName,
        ...(fact.name === undefined ? {} : { metadata: { switchboard: name } }),
      }]);
    }
    case 'tool-result': {
      fields(['tool', 'resultMessage', 'content']);
      const toolCallId = id('tool', fact.tool);
      const messageId = id('message', fact.resultMessage);
      return { transition: { kind: 'result', id: toolCallId, messageId, owner }, events: [{
        type: EventType.TOOL_CALL_RESULT, ...common, toolCallId, messageId, content: content(fact.content, options.sourceKey),
      }] };
    }
    case 'text-content':
    case 'text-ended':
    case 'tool-arguments':
    case 'tool-arguments-ended':
    case 'step-finished': {
      const entityKind = fact.kind === 'step-finished' ? 'step' : fact.kind.startsWith('text-') ? 'text' : 'tool';
      const refField = entityKind === 'text' ? 'message' : entityKind;
      const hasDelta = fact.kind === 'text-content' || fact.kind === 'tool-arguments';
      fields(hasDelta ? [refField, 'delta'] : [refField]);
      const key = id(entityKind === 'text' ? 'message' : entityKind, fact[refField]);
      const transition: Transition = { kind: hasDelta ? 'content' : 'end', id: key, entityKind, owner };
      const event: Event = entityKind === 'step' ? { type: EventType.STEP_FINISHED, ...common, stepName: key }
        : entityKind === 'text' ? hasDelta
          ? { type: EventType.TEXT_MESSAGE_CONTENT, ...common, messageId: key, delta: string(fact.delta) }
          : { type: EventType.TEXT_MESSAGE_END, ...common, messageId: key }
          : hasDelta ? { type: EventType.TOOL_CALL_ARGS, ...common, toolCallId: key, delta: string(fact.delta) }
            : { type: EventType.TOOL_CALL_END, ...common, toolCallId: key };
      return { transition, events: [event] };
    }
    default:
      return reject();
  }
}

function validate(transition: Transition, ledger: ReadonlyMap<string, Entity>, knowledge: Map<string, MessageKnowledge>): readonly (readonly [string, Entity])[] {
  const constrained = (id: string) => {
    const known = knowledge.get(id);
    return known?.role === 'assistant' && known.constrained ? known : undefined;
  };
  if (transition.kind === 'messages') {
    const incoming = new Map(transition.knowledge);
    const roles = new Set([...incoming.values()].map(message => message.role));
    for (const [id, message] of knowledge) {
      if (!incoming.has(id) && (message.role === 'activity' || message.role === 'reasoning') && !roles.has(message.role)) incoming.set(id, message);
    }
    knowledge.clear();
    for (const [id, message] of incoming) knowledge.set(id, message);
    return [...transition.knowledge.map(([id]): readonly [string, Entity] => [id, ledger.get(id) ?? { kind: 'observation', open: false }]),
      ...transition.owners.map((id): readonly [string, Entity] => [id, ledger.get(id) ?? { kind: 'owner', open: false }])];
  }
  if (transition.kind === 'start' || transition.kind === 'fail') return [];
  if (transition.kind === 'finish') {
    if ([...ledger.values()].some(entity => entity.open)) reject('invalid-order');
    const pending = [...ledger].filter(([, entity]) => entity.kind === 'tool' && entity.result === undefined).map(([id]) => id);
    if (transition.pending !== undefined && JSON.stringify(transition.pending) !== JSON.stringify(pending)) reject('identity-conflict');
    return [];
  }
  if (transition.kind === 'observe') return transition.owner !== undefined && !ledger.has(transition.owner)
    ? [[transition.owner, { kind: 'owner', open: false }]] : [];
  if (transition.kind === 'activity') {
    const current = knowledge.get(transition.id);
    if (current && current.role !== 'activity') reject('identity-conflict');
    if (!current && transition.mode === 'delta') reject('invalid-order');
    const historical = ledger.get(transition.id);
    if (!current && transition.mode !== 'delta' && historical && historical.kind !== 'activity' && historical.kind !== 'observation') reject('identity-conflict');
    if (current?.role === 'activity' && transition.mode !== 'replace' && current.owner !== transition.owner) reject('identity-conflict');
    const updates: [string, Entity][] = [];
    if (transition.owner !== undefined && !ledger.has(transition.owner)) {
      updates.push([transition.owner, { kind: 'owner', open: false }]);
    }
    knowledge.set(transition.id, { role: 'activity', owner: transition.owner });
    updates.push([transition.id, ledger.get(transition.id) ?? { kind: 'activity', owner: transition.owner, open: false }]);
    return updates;
  }
  const current = ledger.get(transition.id);
  const owner = transition.kind === 'open' ? transition.stream.owner : transition.owner;
  const updates: [string, Entity][] = [];
  if (owner !== undefined && !ledger.has(owner)) updates.push([owner, { kind: 'owner', open: false }]);
  if (transition.kind === 'open') {
    const incoming = transition.stream;
    if (incoming.kind === 'tool' && incoming.parentMessageId !== undefined && current?.kind !== 'tool') {
      const parent = knowledge.get(incoming.parentMessageId);
      if (parent && (parent.role !== 'assistant' || parent.owner !== owner)) reject('identity-conflict');
      knowledge.set(incoming.parentMessageId, { role: 'assistant', owner, constrained: true });
      if (!ledger.has(incoming.parentMessageId)) updates.push([incoming.parentMessageId, { kind: 'observation', open: false }]);
    }
    if (incoming.kind === 'text' && current?.kind !== 'text') {
      const parent = constrained(transition.id);
      if (parent && (incoming.role !== 'assistant' || parent.owner !== owner)) reject('identity-conflict');
    }
    if (current !== undefined && current.kind !== 'observation') {
      const identical = current.kind === 'text' && incoming.kind === 'text'
        ? current.role === incoming.role && current.name === incoming.name
        : current.kind === 'tool' && incoming.kind === 'tool'
          ? current.name === incoming.name && current.parentMessageId === incoming.parentMessageId
          : current.kind === 'step' && incoming.kind === 'step';
      if (!identical || !('owner' in current) || current.owner !== owner) reject('identity-conflict');
      if (current.open) reject('invalid-order');
    }
    if (incoming.kind === 'text') knowledge.set(transition.id, incoming.role === 'assistant'
      ? { role: 'assistant', owner, constrained: constrained(transition.id) !== undefined } : { role: 'other' });
    updates.push([transition.id, { ...transition.stream,
      ...(current?.kind === 'tool' && current.result !== undefined ? { result: current.result } : {}),
    }]);
  } else {
    if (!current || current.kind === 'result' || current.kind === 'owner' || current.kind === 'observation' || current.kind === 'activity') reject('invalid-order');
    if (current.owner !== owner) reject('identity-conflict');
    if (transition.kind === 'result') {
      if (current.kind !== 'tool' || current.open || current.result !== undefined) reject('invalid-order');
      const previous = ledger.get(transition.messageId);
      if ((previous && previous.kind !== 'observation') || constrained(transition.messageId)) reject('identity-conflict');
      knowledge.set(transition.messageId, { role: 'other' });
      updates.push([transition.messageId, { kind: 'result', owner, tool: transition.id, open: false }],
        [transition.id, { ...current, result: transition.messageId }]);
    } else {
      if (current.kind !== transition.entityKind) reject('identity-conflict');
      if (!current.open) reject('invalid-order');
      if (transition.kind === 'end') updates.push([transition.id, { ...current, open: false }]);
    }
  }
  return updates;
}

export function createProjection<F>(options: ProjectionOptions, encode: Encode): Outcome<Projection<F>, ProjectionError> {
  try {
    let context: ProjectionOptions | undefined = readOptions(options);
    let phase: Phase = 'idle';
    let accepting = false;
    const ledger = new Map<string, Entity>();
    let knowledge = new Map<string, MessageKnowledge>();
    const stop = (next: 'faulted' | 'closed') => {
      phase = next;
      context = undefined;
      ledger.clear();
      knowledge.clear();
    };
    const projection: Projection<F> = Object.freeze({
      accept(fact: F): ProjectionResult {
        if (accepting) {
          stop('faulted');
          return failure(undefined);
        }
        if (!context) return errorResult('closed');
        accepting = true;
        try {
          const scope = context;
          const plan = encode(capture(fact, scope.bounds), scope);
          if (!context) reject(phase === 'closed' ? 'closed' : 'invalid-input');
          const action = plan.transition.kind;
          const permitted = action === 'start' ? phase === 'idle'
            : action === 'fail' ? phase === 'idle' || phase === 'running' || phase === 'finished' : phase === 'running';
          if (!permitted) reject('invalid-order');
          const nextKnowledge = new Map(knowledge);
          const updates = new Map(validate(plan.transition, ledger, nextKnowledge));
          const added = [...updates.keys()].filter(id => !ledger.has(id)).length;
          if (ledger.size + added > scope.bounds.maxEntities) reject('bounds-exceeded');
          const events = capture(plan.events, scope.bounds) as unknown as readonly ProjectionEvent[];
          for (const [id, entity] of updates) ledger.set(id, entity);
          knowledge = nextKnowledge;
          if (action === 'start') phase = 'running';
          if (action === 'finish') phase = 'finished';
          if (action === 'fail') {
            phase = 'errored';
            ledger.clear();
            knowledge.clear();
          }
          return Object.freeze({ kind: 'mapped', events });
        } catch (error) {
          if (phase !== 'closed') stop('faulted');
          return failure(error);
        } finally {
          accepting = false;
        }
      },
      close(): void {
        stop('closed');
      },
    });
    return Object.freeze({ kind: 'ok', value: projection });
  } catch (error) {
    return failure(error);
  }
}
