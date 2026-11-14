import { EventType } from '@ag-ui/core';
import type { SubagentStartedEvent, SubagentFinishedEvent, SubagentErrorEvent, SubagentFinishedSuccessOutcome, SubagentFinishedSuspendedOutcome } from '@ag-ui/core';
import type { Encoding, ProjectionOptions } from './basic.js';
import { identity, record, reject, string } from './internal.js';
import type { DeepReadonly, Json, NativeRef } from './internal.js';

type NativeSubagentOutcome = DeepReadonly<SubagentFinishedSuccessOutcome>
  | DeepReadonly<Omit<SubagentFinishedSuspendedOutcome, 'interruptIds'>> & { readonly interrupts?: readonly NativeRef[] };
const childFailures = Object.freeze({
  'native-failure': 'The native subagent failed.',
  'transport-failure': 'The native subagent transport failed.',
});
export type SubagentFailure = keyof typeof childFailures;
export type SubagentFact = { readonly subagent: NativeRef } & (
  | DeepReadonly<Pick<SubagentStartedEvent, 'timestamp' | 'name' | 'description'>> & {
      readonly kind: 'subagent-started'; readonly parentSubagent?: NativeRef;
      readonly parentTool?: NativeRef; readonly parentMessage?: NativeRef }
  | DeepReadonly<Pick<SubagentFinishedEvent, 'timestamp'>> & { readonly kind: 'subagent-finished';
      readonly result?: Json; readonly outcome?: NativeSubagentOutcome }
  | DeepReadonly<Pick<SubagentErrorEvent, 'timestamp'>> & { readonly kind: 'subagent-failed'; readonly failure: SubagentFailure }
);

export function encodeSubagents(value: Json, options: ProjectionOptions): Encoding {
  const fact = record(value, ['kind', 'timestamp', 'subagent', 'name', 'description',
    'parentSubagent', 'parentTool', 'parentMessage', 'result', 'outcome', 'failure']);
  const timestamp = fact.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) reject();
  const id = (kind: string, ref: unknown) => identity(options.sourceKey, kind, ref);
  const subagentRunId = id('subagent', fact.subagent);
  const common = { subagentRunId, ...(timestamp === undefined ? {} : { timestamp }) };
  if (fact.kind === 'subagent-started') {
    record(value, ['kind', 'timestamp', 'subagent', 'name', 'description', 'parentSubagent', 'parentTool', 'parentMessage']);
    const parent = fact.parentSubagent === undefined ? undefined : id('subagent', fact.parentSubagent);
    const tool = fact.parentTool === undefined ? undefined : id('tool', fact.parentTool);
    const message = fact.parentMessage === undefined ? undefined : id('message', fact.parentMessage);
    return { transition: { kind: 'subagent-start', id: subagentRunId, parent,
      correlations: [tool, message].filter((ref): ref is string => ref !== undefined) }, events: [{
      type: EventType.SUBAGENT_STARTED, ...common, name: string(fact.name),
      ...(fact.description === undefined ? {} : { description: string(fact.description) }),
      ...(parent === undefined ? {} : { parentSubagentRunId: parent }),
      ...(tool === undefined ? {} : { parentToolCallId: tool }),
      ...(message === undefined ? {} : { parentMessageId: message }),
    }] };
  }
  if (fact.kind === 'subagent-failed') {
    record(value, ['kind', 'timestamp', 'subagent', 'failure']);
    const code = fact.failure;
    if (code !== 'native-failure' && code !== 'transport-failure') reject();
    return { transition: { kind: 'subagent-end', id: subagentRunId, interrupts: [] }, events: [{
      type: EventType.SUBAGENT_ERROR, ...common, code, message: childFailures[code],
    }] };
  }
  if (fact.kind !== 'subagent-finished') reject();
  record(value, ['kind', 'timestamp', 'subagent', 'result', 'outcome']);
  let outcome: { readonly type: 'success' } | { readonly type: 'suspended'; readonly interruptIds?: string[] } | undefined;
  let interrupts: string[] = [];
  if (fact.outcome !== undefined) {
    const fields = record(fact.outcome, ['type', 'interrupts']);
    if (fields.type === 'success') {
      record(fact.outcome, ['type']);
      outcome = { type: 'success' };
    } else if (fields.type === 'suspended') {
      if (fields.interrupts !== undefined && !Array.isArray(fields.interrupts)) reject();
      interrupts = fields.interrupts === undefined ? [] : fields.interrupts.map((ref: unknown) => id('interrupt', ref));
      outcome = { type: 'suspended', ...(fields.interrupts === undefined ? {} : { interruptIds: interrupts }) };
    } else reject();
  }
  return { transition: { kind: 'subagent-end', id: subagentRunId, interrupts }, events: [{
    type: EventType.SUBAGENT_FINISHED, ...common,
    ...(fact.result === undefined || fact.result === null ? {} : { result: fact.result }),
    ...(outcome === undefined ? {} : { outcome }),
  }] };
}
