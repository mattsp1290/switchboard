import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import type { Event } from '@ag-ui/core';
import type { Outcome } from '../core/contracts.js';
import { capture, errorResult, failure, readBounds, record, reject } from './internal.js';
import type { Json, ProjectionBounds, ProjectionError } from './internal.js';

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
export type BasicFact = { readonly timestamp?: number } & (
  | { readonly kind: 'run-started' }
  | { readonly kind: 'run-finished'; readonly outcome: 'success'; readonly result?: Json }
  | { readonly kind: 'run-finished'; readonly outcome: 'cancelled' }
  | { readonly kind: 'run-failed'; readonly failure: PublicFailure }
);
export type ProjectionFact = BasicFact;
export type ProjectionResult =
  | { readonly kind: 'mapped'; readonly events: readonly Event[] }
  | { readonly kind: 'error'; readonly error: ProjectionError };
export interface AguiProjection {
  accept(fact: ProjectionFact): ProjectionResult;
  close(): void;
}

type Phase = 'idle' | 'running' | 'finished' | 'errored' | 'faulted' | 'closed';
type Transition = 'start' | 'finish' | 'fail';
interface Encoding {
  readonly events: readonly Event[];
  readonly transition: Transition;
}

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

function encodeBasic(value: Json, options: ProjectionOptions): Encoding {
  const fact = record(value, ['kind', 'timestamp', 'outcome', 'result', 'failure']);
  const timestamp = fact.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) reject();
  const observed = timestamp === undefined ? {} : { timestamp };
  const { threadId, runId } = options;
  switch (fact.kind) {
    case 'run-started':
      record(value, ['kind', 'timestamp']);
      return { transition: 'start', events: [{
        type: EventType.RUN_STARTED, ...observed, threadId, runId,
        protocolVersion: PROTOCOL_VERSION,
        ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      }] };
    case 'run-finished': {
      record(value, fact.outcome === 'success' ? ['kind', 'timestamp', 'outcome', 'result'] : ['kind', 'timestamp', 'outcome']);
      if (fact.outcome !== 'success' && fact.outcome !== 'cancelled') reject();
      return { transition: 'finish', events: [{
        type: EventType.RUN_FINISHED, ...observed, threadId, runId,
        outcome: { type: fact.outcome },
        ...('result' in fact && fact.result !== null ? { result: fact.result } : {}),
      }] };
    }
    case 'run-failed': {
      record(value, ['kind', 'timestamp', 'failure']);
      const code = fact.failure;
      if (code !== 'native-failure' && code !== 'transport-failure') reject();
      return { transition: 'fail', events: [{
        type: EventType.RUN_ERROR, ...observed, code, message: publicFailures[code],
      }] };
    }
    default:
      return reject();
  }
}

export function createAguiProjection(options: ProjectionOptions): Outcome<AguiProjection, ProjectionError> {
  try {
    let context: ProjectionOptions | undefined = readOptions(options);
    let phase: Phase = 'idle';
    let accepting = false;
    const stop = (next: 'faulted' | 'closed') => {
      phase = next;
      context = undefined;
    };
    const projection: AguiProjection = Object.freeze({
      accept(fact: ProjectionFact): ProjectionResult {
        if (accepting) {
          stop('faulted');
          return failure(undefined);
        }
        if (!context) return errorResult('closed');
        accepting = true;
        try {
          const scope = context;
          const plan = encodeBasic(capture(fact, scope.bounds), scope);
          if (!context) reject(phase === 'closed' ? 'closed' : 'invalid-input');
          const permitted = plan.transition === 'start' ? phase === 'idle'
            : plan.transition === 'finish' ? phase === 'running'
              : phase === 'idle' || phase === 'running' || phase === 'finished';
          if (!permitted) reject('invalid-order');
          const events = capture(plan.events, scope.bounds) as unknown as readonly Event[];
          phase = plan.transition === 'start' ? 'running' : plan.transition === 'finish' ? 'finished' : 'errored';
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
