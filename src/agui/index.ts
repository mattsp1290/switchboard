import { PROTOCOL_VERSION } from '@ag-ui/core';

export { createAguiProjection } from './basic.js';
export type { AguiProjection, BasicEntityFact, BasicFact, ProjectionEvent, ProjectionFact, ProjectionOptions, ProjectionResult, PublicFailure } from './basic.js';
export type { Json, NativeRef, ProjectionBounds, ProjectionError } from './internal.js';

export type { NativeContent } from './payloads.js';

export const aguiProtocol = Object.freeze({
  version: PROTOCOL_VERSION,
  sourceCommit: '0fc064bb2647fc0bce4fc795af33b5551ac03f88',
  typescriptSdk: '1.0.4',
  pythonSdk: '1.0.0',
  mapping: 'basic',
  planned: 'advanced',
});
