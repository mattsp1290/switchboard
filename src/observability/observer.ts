import { createTraceState, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Context, Span, SpanContext } from '@opentelemetry/api';
import { sanitizedContent } from './content.js';
import { configuration, modelObservation, record, startObservation, terminal } from './validation.js';
import type {
  AgentHandle, AgentOperation, Correlation, GenAiHandle, GenAiObserver, GenAiOperation,
  ModelHandle, ModelOperation, ModelUpdate, ObservationErrorCode, ObservationResult,
  ObserverOptions, TerminalOutcome, ToolHandle, ToolOperation,
} from './types.js';

interface Reservation {
  phase: 'starting' | 'open' | 'finished';
  span: Span | undefined;
  inputBytes: number;
  outputBytes: number;
}

function safeSpanContext(span: Span): SpanContext | undefined {
  const raw = span.spanContext();
  const value = record(raw, ['traceId', 'spanId', 'traceFlags', 'isRemote', 'traceState']);
  if (!value || typeof value.traceId !== 'string' || !/^[0-9a-f]{32}$/u.test(value.traceId) ||
      typeof value.spanId !== 'string' || !/^[0-9a-f]{16}$/u.test(value.spanId) ||
      typeof value.traceFlags !== 'number' || !Number.isInteger(value.traceFlags) || value.traceFlags < 0 || value.traceFlags > 255) return;
  const traceState = raw.traceState === undefined ? undefined : createTraceState(raw.traceState.serialize());
  return Object.freeze({ traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags,
    ...(traceState === undefined ? {} : { traceState }),
  });
}

export function createGenAiObserver(options: ObserverOptions): GenAiObserver {
  const config = configuration(options);
  const owned = new Set<Reservation>();
  let closed = false;
  const counts = {
    started: 0, finished: 0, invalidInputs: 0, capacityRejected: 0, closedRejected: 0,
    finishedRejected: 0, telemetryFailures: 0, contentDropped: 0,
  };
  const ok = (): ObservationResult => ({ kind: 'ok', value: undefined });
  function failure<T>(code: ObservationErrorCode): ObservationResult<T> {
    const counter = {
      'invalid-input': 'invalidInputs', capacity: 'capacityRejected', closed: 'closedRejected',
      finished: 'finishedRejected', 'telemetry-failure': 'telemetryFailures',
    } as const;
    counts[counter[code]]++;
    return { kind: 'error', error: { code } };
  }
  function endOwned(entry: Reservation): boolean {
    const span = entry.span;
    entry.span = undefined;
    try {
      if (span) {
        counts.finished++;
        span.end();
      }
      return true;
    } catch {
      return false;
    } finally {
      owned.delete(entry);
    }
  }
  function finish(entry: Reservation, value: TerminalOutcome): ObservationResult {
    if (entry.phase === 'finished') return ok();
    const outcome = terminal(value);
    if (!outcome) return failure('invalid-input');
    entry.phase = 'finished';
    let failed = false;
    try {
      if (entry.span) {
        entry.span.setAttribute('switchboard.outcome', outcome.kind);
        if (outcome.kind === 'error') {
          entry.span.setAttribute('error.type', outcome.category);
          entry.span.setStatus({ code: SpanStatusCode.ERROR });
        }
      }
    } catch {
      failed = true;
    } finally {
      if (!endOwned(entry)) failed = true;
    }
    return failed ? failure('telemetry-failure') : ok();
  }
  function content(entry: Reservation, kind: 'input' | 'output', value: unknown, attributes: Attributes): void {
    const available = config.maxContentBytes - (kind === 'input' ? entry.outputBytes : entry.inputBytes);
    const result = sanitizedContent(kind, value, config, available);
    if (result.kind === 'dropped') counts.contentDropped++;
    if (result.kind !== 'content' || entry.phase === 'finished') return;
    attributes[`gen_ai.${kind}.messages`] = result.json;
    if (kind === 'input') entry.inputBytes = result.bytes;
    else entry.outputBytes = result.bytes;
  }
  function update(entry: Reservation, value: ModelUpdate): ObservationResult {
    if (entry.phase !== 'open') return failure('finished');
    const observation = modelObservation(value, config.maxIdentifierLength);
    if (!observation) return failure('invalid-input');
    content(entry, 'output', observation.content, observation.attributes);
    if (entry.phase !== 'open') return failure('finished');
    try {
      entry.span?.setAttributes(observation.attributes);
      return ok();
    } catch {
      return failure('telemetry-failure');
    }
  }
  function revoked(entry: Reservation): boolean { return entry.phase === 'finished'; }
  function start(operation: AgentOperation, parent: Context, correlation?: Correlation): ObservationResult<AgentHandle>;
  function start(operation: ModelOperation, parent: Context, correlation?: Correlation): ObservationResult<ModelHandle>;
  function start(operation: ToolOperation, parent: Context, correlation?: Correlation): ObservationResult<ToolHandle>;
  function start(operation: GenAiOperation, parent: Context, correlation?: Correlation): ObservationResult<GenAiHandle>;
  function start(operation: GenAiOperation, parent: Context, correlation?: Correlation): ObservationResult<GenAiHandle> {
    if (closed) return failure('closed');
    const observation = startObservation(operation, correlation, config);
    if (!observation || !parent) return failure('invalid-input');
    if (owned.size >= config.maxActiveSpans) return failure('capacity');
    const entry: Reservation = { phase: 'starting', span: undefined, inputBytes: 0, outputBytes: 0 };
    owned.add(entry);
    content(entry, 'input', observation.content, observation.attributes);
    if (revoked(entry)) return failure('closed');
    try {
      entry.span = config.tracer.startSpan(observation.name, {
        kind: observation.kind === 'tool' ? SpanKind.INTERNAL : SpanKind.CLIENT,
        attributes: observation.attributes,
      }, parent);
      counts.started++;
      if (revoked(entry)) {
        let failed = false;
        try {
          entry.span.setAttribute('switchboard.outcome', 'outcome-unknown');
        } catch {
          failed = true;
        } finally {
          if (!endOwned(entry)) failed = true;
        }
        return failure(failed ? 'telemetry-failure' : 'closed');
      }
      const spanContext = safeSpanContext(entry.span);
      if (!spanContext) throw new Error();
      if (revoked(entry)) return failure('closed');
      const context = trace.setSpanContext(parent, spanContext);
      if (revoked(entry)) return failure('closed');
      const common = { spanContext, context, finish: (outcome: TerminalOutcome) => finish(entry, outcome) };
      entry.phase = 'open';
      switch (observation.kind) {
        case 'agent': return { kind: 'ok', value: Object.freeze({ ...common, kind: 'agent' }) };
        case 'tool': return { kind: 'ok', value: Object.freeze({ ...common, kind: 'tool' }) };
        case 'model': return { kind: 'ok', value: Object.freeze({ ...common, kind: 'model', update: (value: ModelUpdate) => update(entry, value) }) };
      }
    } catch {
      entry.phase = 'finished';
      endOwned(entry);
      return failure('telemetry-failure');
    }
  }
  return Object.freeze({
    start,
    diagnostics: () => Object.freeze({ ...counts, activeSpans: owned.size }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of owned) finish(entry, { kind: 'outcome-unknown' });
    },
  });
}
