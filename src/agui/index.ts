import { PROTOCOL_VERSION } from '@ag-ui/core';

import { createProjection, encodeBasic } from './basic.js';
import type { BasicFact, Projection, ProjectionOptions } from './basic.js';
import { encodeTerminals } from './terminals.js';
import { encodeReasoning } from './reasoning.js';
import type { ReasoningFact } from './reasoning.js';
import { encodeMessages } from './messages.js';
import type { MessagesFact } from './messages.js';
import { encodeAdvanced } from './advanced.js';
import type { AdvancedFact } from './advanced.js';
import type { Json } from './internal.js';

export type ProjectionFact = BasicFact | AdvancedFact | MessagesFact | ReasoningFact;
export type AguiProjection = Projection<ProjectionFact>;
export function createAguiProjection(options: ProjectionOptions) {
  return createProjection<ProjectionFact>(options, (fact: Json, scope: ProjectionOptions) => {
    const kind = fact && typeof fact === 'object' && !Array.isArray(fact) && 'kind' in fact ? fact.kind : undefined;
    switch (kind) {
      case 'run-finished': case 'run-failed': return encodeTerminals(fact, scope);
      case 'reasoning-started': case 'reasoning-ended': case 'reasoning-message-started':
      case 'reasoning-message-content': case 'reasoning-message-ended': case 'reasoning-message-complete':
      case 'reasoning-encrypted-value': return encodeReasoning(fact, scope);
      case 'messages-snapshot': return encodeMessages(fact, scope);
      case 'state-snapshot': case 'state-delta': case 'activity-snapshot': case 'activity-delta':
      case 'raw': case 'custom': case 'not-observable':
        return encodeAdvanced(fact, scope);
      default:
        return encodeBasic(fact, scope);
    }
  });
}
export type { ReasoningFact, ReasoningTarget } from './reasoning.js';
export type { NativeMessage, MessagesFact } from './messages.js';
export { describeProjection } from './advanced.js';
export type { AdvancedFact, NativeJsonPatch, ProjectionFamily, NativeAvailability, NativeQualification,
  ProjectionEvidence, ProjectionDescription } from './advanced.js';
export type { BasicEntityFact, BasicFact, ProjectionEvent, ProjectionOptions, ProjectionResult, PublicFailure } from './basic.js';
export type { Json, NativeRef, ProjectionBounds, ProjectionError } from './internal.js';

export type { NativeInterrupt, NativeTokenUsage, TerminalFact } from './terminals.js';
export type { NativeContent } from './payloads.js';

export const aguiProtocol = Object.freeze({
  version: PROTOCOL_VERSION,
  sourceCommit: '0fc064bb2647fc0bce4fc795af33b5551ac03f88',
  typescriptSdk: '1.0.4',
  pythonSdk: '1.0.0',
  mapping: 'basic-values-messages-terminals-and-reasoning',
  planned: 'subagents',
});
