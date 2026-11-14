import type { Interrupt, TokenUsage } from '@ag-ui/core';
import type { NativeInterrupt, NativeTokenUsage, TerminalFact } from '@mattsp1290/switchboard/agui';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type UsageKeys = Assert<Equal<keyof NativeTokenUsage, keyof TokenUsage>>;
export type UsageShape = Assert<Equal<NativeTokenUsage, Readonly<TokenUsage>>>;
export type InterruptFields = Assert<Equal<keyof NativeInterrupt,
  Exclude<keyof Interrupt, 'id' | 'toolCallId' | 'subagentRunId'> | 'interrupt' | 'tool' | 'owner'>>;
export type InterruptNonempty = Assert<Equal<Extract<TerminalFact, { outcome: 'interrupt' }>['interrupts'],
  readonly [NativeInterrupt, ...NativeInterrupt[]]>>;
const ref = { scope: ['native'], id: 'native' };
export const valid: TerminalFact = { kind: 'run-finished', outcome: 'interrupt',
  interrupts: [{ interrupt: ref, reason: '', owner: ref, metadata: { nested: [null] }, responseSchema: {} }], usage: [{}, { provider: '' }] };
