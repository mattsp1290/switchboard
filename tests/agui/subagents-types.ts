import type { SubagentStartedEvent } from '@ag-ui/core';
import type { NativeRef, SubagentFact, SubagentFailure } from '@mattsp1290/switchboard/agui';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type NamePreserved = Assert<Equal<Extract<SubagentFact, { kind: 'subagent-started' }>['name'], SubagentStartedEvent['name']>>;
const subagent: NativeRef = { scope: ['native'], id: '' };
export const failures: readonly SubagentFailure[] = ['native-failure', 'transport-failure'];
export const facts: readonly SubagentFact[] = [
  { kind: 'subagent-started', subagent, name: '', description: '', parentSubagent: subagent, parentTool: subagent, parentMessage: subagent },
  { kind: 'subagent-finished', subagent },
  { kind: 'subagent-finished', subagent, outcome: { type: 'success' }, result: { nested: [null] } },
  { kind: 'subagent-finished', subagent, outcome: { type: 'suspended' } },
  { kind: 'subagent-finished', subagent, outcome: { type: 'suspended', interrupts: [] } },
  { kind: 'subagent-failed', subagent, failure: 'native-failure' },
];
