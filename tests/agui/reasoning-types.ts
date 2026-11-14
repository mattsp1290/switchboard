import type { ReasoningMessageStartEvent } from '@ag-ui/core';
import type { NativeRef, ReasoningFact, ReasoningTarget } from '@mattsp1290/switchboard/agui';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type RolePreserved = Assert<Equal<Extract<ReasoningFact, { kind: 'reasoning-message-started' }>['role'], ReasoningMessageStartEvent['role']>>;
const reference: NativeRef = { scope: ['native'], id: 'id' };
export const messageTarget: ReasoningTarget = { kind: 'message', message: reference };
export const toolTarget: ReasoningTarget = { kind: 'tool', tool: reference };
export const reasoning: readonly ReasoningFact[] = [
  { kind: 'reasoning-started', span: reference },
  { kind: 'reasoning-message-started', message: reference, role: 'reasoning' },
  { kind: 'reasoning-message-content', message: reference, delta: '' },
  { kind: 'reasoning-message-ended', message: reference },
  { kind: 'reasoning-message-complete', message: reference, role: 'reasoning', text: '' },
  { kind: 'reasoning-ended', span: reference },
  { kind: 'reasoning-encrypted-value', target: toolTarget, encryptedValue: '', owner: reference },
];
