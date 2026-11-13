import { PROTOCOL_VERSION } from '@ag-ui/core';

export { createAguiProjection } from './basic.js';
export type { AguiProjection, BasicFact, ProjectionFact, ProjectionOptions, ProjectionResult, PublicFailure } from './basic.js';
export type { Json, ProjectionBounds, ProjectionError } from './internal.js';

export const aguiProtocol = Object.freeze({
  version: PROTOCOL_VERSION,
  sourceCommit: '0fc064bb2647fc0bce4fc795af33b5551ac03f88',
  typescriptSdk: '1.0.4',
  pythonSdk: '1.0.0',
  mapping: 'lifecycle',
  planned: 'entities-and-advanced',
});
