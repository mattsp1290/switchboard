import type { Context, Tracer } from '@opentelemetry/api';
import type { Outcome } from '../core/contracts.js';
import { runObservationFamilies } from '../core/run-observation.js';
import type { RunObservation, RunObservationFamily, RunObservationUsage } from '../core/run-observation.js';
import { createAguiProjection, describeProjection } from '../agui/index.js';
import type {
  AguiProjection, NativeRef, NativeTokenUsage, ProjectionBounds, ProjectionDescription, ProjectionError, ProjectionEvent,
  ProjectionFact, ProjectionFamily, ProjectionResult,
} from '../agui/index.js';
import { usageRowsValid } from '../agui/terminals.js';
import { createGenAiObserver } from '../observability/index.js';
import type { AgentHandle, ContentPolicy, ModelHandle, ObservationErrorCode, TerminalOutcome } from '../observability/index.js';
import { identifier } from '../observability/validation.js';

export interface RunBaselineOptions {
  readonly projection: {
    readonly threadId: string;
    readonly runId: string;
    readonly parentRunId?: string;
    readonly sourceKey: string;
    readonly bounds: ProjectionBounds;
  };
  readonly tracer: Tracer;
  readonly parentContext: Context;
  readonly contentPolicy: ContentPolicy;
  readonly allowedToolNames: readonly string[];
  readonly admitObservedToolNames?: boolean;
  /** The agent span's `gen_ai.provider.name`, and the model span's provider. */
  readonly provider: string;
  readonly agentName?: string;
}

export type RunBaselineDiagnosticCode =
  | 'duplicate-run-started'
  | 'snapshot-not-extension'
  | 'usage-row-dropped'
  | 'after-terminal'
  | 'tool-result-repeated'
  | 'tool-span-unrecorded'
  | 'not-running'
  | 'pending-tool-unknown';

export interface RunBaselineDiagnostic {
  readonly code: RunBaselineDiagnosticCode;
}

export interface RunBaselineAccept {
  /** Every AG-UI event this observation produced, or the first projector error. */
  readonly projection: ProjectionResult;
  readonly diagnostics: readonly RunBaselineDiagnostic[];
  /** An observer failure beside the projector result. It never changes the projector batch. */
  readonly observer?: { readonly code: ObservationErrorCode };
}

export type BaselineFamily = 'text' | 'tools' | 'steps';
export interface BaselineDescription {
  readonly family: BaselineFamily;
  readonly availability: 'supported' | 'unsupported';
  readonly qualification: 'unqualified';
}

export interface RunBaselineReport {
  /** One row for each of the nine `ProjectionFamily` values. */
  readonly families: readonly ProjectionDescription[];
  readonly baseline: readonly BaselineDescription[];
  /** The first projector error any `accept` returned, if one did. */
  readonly error?: ProjectionError;
}

export interface RunBaseline {
  accept(observation: RunObservation): RunBaselineAccept;
  /** Closes the observer and the projector. It never calls `accept`. */
  close(): RunBaselineReport;
}

const projectionFamilies: readonly ProjectionFamily[] = runObservationFamilies;
// The core family list must stay identical to the AG-UI `ProjectionFamily` in both directions.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const familiesMatch: Same<RunObservationFamily, ProjectionFamily> = true;
void familiesMatch;

const textScope = Object.freeze(['text']);
const reasoningScope = Object.freeze(['reasoning']);
const toolScope = Object.freeze(['tool']);
const resultScope = Object.freeze(['tool-result']);
const ref = (scope: readonly string[], id: string): NativeRef => ({ scope, id });

interface MessageState {
  readonly kind: 'text' | 'reasoning';
  open: boolean;
  text: string;
}
interface ToolState {
  readonly name: string;
  argumentsOpen: boolean;
  argumentsSent: boolean;
  result: boolean;
  /** At most one `execute_tool` span per call, however many execution observations arrive. */
  spanRecorded: boolean;
}
type OpenEntry = { readonly kind: 'text' | 'reasoning' | 'tool'; readonly id: string };

const maxIdentifierLength = 256;

function usageKey(row: RunObservationUsage): string {
  return JSON.stringify([row.provider ?? null, row.model ?? null]);
}

function usageRow(row: RunObservationUsage): NativeTokenUsage {
  const result: Record<string, string | number> = {};
  for (const key of ['provider', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens',
    'cachedInputTokens', 'cacheWriteInputTokens'] as const) {
    const value = row[key];
    if (value !== undefined) result[key] = value;
  }
  return result as NativeTokenUsage;
}

/**
 * Maps `RunObservation` values from one segment into AG-UI events and GenAI spans. The host calls `accept`; adapters
 * never do. One baseline is one segment: a continuation uses a new baseline.
 *
 * Model and tool spans are recorded when their observation arrives and end immediately: they mark an observed
 * boundary and its outcome, not its latency. `projection.runId` is also the correlation on every span.
 */
export function createRunBaseline(options: RunBaselineOptions): Outcome<RunBaseline, ProjectionError> {
  const observer = createGenAiObserver({
    tracer: options.tracer, contentPolicy: options.contentPolicy, allowedToolNames: options.allowedToolNames,
    ...(options.admitObservedToolNames === undefined ? {} : { admitObservedToolNames: options.admitObservedToolNames }),
  });
  const created = createAguiProjection(options.projection);
  if (created.kind === 'error') {
    observer.close();
    return created;
  }
  const projector: AguiProjection = created.value;
  const { provider, agentName, parentContext } = options;
  const correlation = Object.freeze({ runId: options.projection.runId });

  let phase: 'idle' | 'running' | 'terminated' = 'idle';
  let agent: AgentHandle | undefined;
  let firstError: ProjectionError | undefined;
  const messages = new Map<string, MessageState>();
  const tools = new Map<string, ToolState>();
  const toolOrder: string[] = [];
  const opened: OpenEntry[] = [];
  const filled = new Set<ProjectionFamily>();
  const usageRows = new Map<string, NativeTokenUsage>();
  const openModels: ModelHandle[] = [];
  let sawText = false;
  let sawTool = false;

  /** What one `accept` call produced. The helpers below write here; `accept` resets it per observation. */
  interface Batch {
    readonly events: ProjectionEvent[];
    readonly diagnostics: RunBaselineDiagnostic[];
    error?: ProjectionError;
    observerError?: { readonly code: ObservationErrorCode };
  }
  let batch: Batch = { events: [], diagnostics: [] };

  const note = (code: RunBaselineDiagnosticCode) => batch.diagnostics.push(Object.freeze({ code }));
  const noteObserver = (result: { readonly kind: string; readonly error?: { readonly code: ObservationErrorCode } }) => {
    if (result.kind === 'error' && result.error && batch.observerError === undefined) batch.observerError = Object.freeze({ code: result.error.code });
  };
  const project = (fact: ProjectionFact): boolean => {
    if (batch.error) return false;
    const result = projector.accept(fact);
    if (result.kind === 'error') {
      batch.error = result.error;
      firstError ??= result.error;
      return false;
    }
    batch.events.push(...result.events);
    return true;
  };
  const parent = (): Context => agent?.context ?? parentContext;

  const message = (kind: 'text' | 'reasoning', id: string, mode: 'snapshot' | 'delta', text: string) => {
    const key = `${kind}:${id}`;
    const current = messages.get(key);
    let suffix: string;
    if (mode === 'delta') suffix = text;
    else {
      const previous = current?.text ?? '';
      if (!text.startsWith(previous)) {
        note('snapshot-not-extension');
        return;
      }
      suffix = text.slice(previous.length);
    }
    if (suffix === '') return;
    const target = ref(kind === 'text' ? textScope : reasoningScope, id);
    if (!current) {
      const started = kind === 'text'
        ? project({ kind: 'text-started', message: target, role: 'assistant' })
        : project({ kind: 'reasoning-message-started', message: target, role: 'reasoning' });
      if (!started) return;
      messages.set(key, { kind, open: true, text: '' });
      opened.push({ kind, id: key });
    }
    const state = messages.get(key)!;
    const sent = kind === 'text'
      ? project({ kind: 'text-content', message: target, delta: suffix })
      : project({ kind: 'reasoning-message-content', message: target, delta: suffix });
    if (!sent) return;
    state.text += suffix;
    if (kind === 'reasoning') filled.add('reasoning');
    else sawText = true;
  };

  /** `append`: the phase is `arguments`, whose JSON is the next delta. Other phases send arguments at most once. */
  const ensureTool = (callId: string, name: string, argumentsJson: string | undefined, append: boolean): ToolState | undefined => {
    let state = tools.get(callId);
    if (!state) {
      if (!project({ kind: 'tool-started', tool: ref(toolScope, callId), name })) return;
      state = { name, argumentsOpen: true, argumentsSent: false, result: false, spanRecorded: false };
      tools.set(callId, state);
      toolOrder.push(callId);
      opened.push({ kind: 'tool', id: callId });
    }
    if (argumentsJson !== undefined && argumentsJson !== '' && state.argumentsOpen && (append || !state.argumentsSent)) {
      if (!project({ kind: 'tool-arguments', tool: ref(toolScope, callId), delta: argumentsJson })) return;
      state.argumentsSent = true;
    }
    return state;
  };
  const endArguments = (callId: string, state: ToolState): boolean => {
    if (!state.argumentsOpen) return true;
    if (!project({ kind: 'tool-arguments-ended', tool: ref(toolScope, callId) })) return false;
    state.argumentsOpen = false;
    return true;
  };
  const toolResult = (callId: string, state: ToolState, resultJson: string): void => {
    if (state.result) {
      note('tool-result-repeated');
      return;
    }
    if (project({ kind: 'tool-result', tool: ref(toolScope, callId), resultMessage: ref(resultScope, `${callId}:result`),
      content: resultJson })) state.result = true;
  };
  const toolSpan = (callId: string, state: ToolState, outcome: TerminalOutcome) => {
    if (state.spanRecorded) return;
    state.spanRecorded = true;
    const { name } = state;
    if (!identifier(name, maxIdentifierLength)) {
      note('tool-span-unrecorded');
      return;
    }
    const started = observer.start({ kind: 'tool', name, ...(identifier(callId, maxIdentifierLength) ? { callId } : {}) },
      parent(), correlation);
    if (started.kind === 'error') {
      noteObserver(started);
      note('tool-span-unrecorded');
      return;
    }
    noteObserver(started.value.finish(outcome));
  };

  const finishRun = (outcome: Extract<RunObservation, { kind: 'terminal' }>) => {
    for (const entry of opened) {
      if (entry.kind === 'tool') {
        const state = tools.get(entry.id);
        if (state && !endArguments(entry.id, state)) break;
        continue;
      }
      const state = messages.get(entry.id);
      if (!state || !state.open) continue;
      const id = entry.id.slice(entry.kind.length + 1);
      const ended = entry.kind === 'text'
        ? project({ kind: 'text-ended', message: ref(textScope, id) })
        : project({ kind: 'reasoning-message-ended', message: ref(reasoningScope, id) });
      if (!ended) break;
      state.open = false;
    }
    opened.length = 0;
    const rows = [...usageRows.values()];
    // Usage is filled only when a terminal fact will carry the rows; `outcome-unknown` emits no terminal fact.
    if (rows.length > 0 && outcome.outcome !== 'outcome-unknown') filled.add('usage');
    for (const family of projectionFamilies) {
      if (!filled.has(family)) project({ kind: 'not-observable', family });
    }
    const attached = rows.length > 0 ? { usage: rows } : {};
    let agentOutcome: TerminalOutcome;
    switch (outcome.outcome) {
      case 'success': {
        const pending = outcome.pendingTools;
        if (pending?.some(id => !tools.has(id))) note('pending-tool-unknown');
        const ordered = pending === undefined ? undefined
          : toolOrder.filter(id => pending.includes(id)).map(id => ref(toolScope, id));
        project({ kind: 'run-finished', outcome: 'success', ...attached, ...(ordered === undefined ? {} : { pendingTools: ordered }) });
        agentOutcome = { kind: 'success' };
        break;
      }
      case 'failed':
        project({ kind: 'run-failed', failure: 'native-failure', ...attached });
        agentOutcome = { kind: 'error', category: 'unknown-error' };
        break;
      case 'cancelled':
        project({ kind: 'run-finished', outcome: 'cancelled', ...attached });
        agentOutcome = { kind: 'cancelled' };
        break;
      default:
        agentOutcome = { kind: 'outcome-unknown' };
    }
    for (const model of openModels.splice(0)) noteObserver(model.finish({ kind: 'outcome-unknown' }));
    if (agent) noteObserver(agent.finish(agentOutcome));
    phase = 'terminated';
  };

  function accept(observation: RunObservation): RunBaselineAccept {
    batch = { events: [], diagnostics: [] };
    if (phase === 'terminated') {
      note('after-terminal');
    } else {
      switch (observation.kind) {
        case 'run-started': {
          if (phase !== 'idle') {
            note('duplicate-run-started');
            batch.error = Object.freeze({ code: 'invalid-order' });
            firstError ??= batch.error;
            break;
          }
          if (!project({ kind: 'run-started' })) break;
          phase = 'running';
          const started = observer.start({ kind: 'agent', provider, ...(agentName === undefined ? {} : { name: agentName }) },
            parentContext, correlation);
          if (started.kind === 'ok') agent = started.value;
          else noteObserver(started);
          break;
        }
        case 'text':
        case 'reasoning':
          message(observation.kind, observation.messageId, observation.mode, observation.text);
          break;
        case 'tool': {
          if (phase !== 'running') {
            note('not-running');
            break;
          }
          sawTool = true;
          const { callId, name, phase: toolPhase, argumentsJson, resultJson } = observation;
          const state = ensureTool(callId, name, toolPhase === 'started' ? undefined : argumentsJson, toolPhase === 'arguments');
          if (!state) break;
          if (toolPhase === 'started' || toolPhase === 'arguments') break;
          if (!endArguments(callId, state)) break;
          if (resultJson !== undefined) toolResult(callId, state, resultJson);
          if (toolPhase === 'completed' || (toolPhase === 'arguments-ended' && resultJson !== undefined)) {
            toolSpan(callId, state, { kind: 'success' });
          } else if (toolPhase === 'failed') {
            toolSpan(callId, state, { kind: 'error', category: 'tool-error' });
          }
          break;
        }
        case 'usage': {
          for (const row of observation.rows) {
            const candidate = usageRow(row);
            const key = usageKey(row);
            if (usageRowsValid([...new Map(usageRows).set(key, candidate).values()])) usageRows.set(key, candidate);
            else note('usage-row-dropped');
          }
          break;
        }
        case 'model-boundary': {
          if (phase !== 'running') {
            note('not-running');
            break;
          }
          const started = observer.start({ kind: 'model', provider, operation: 'chat',
            ...(observation.requestModel === undefined ? {} : { requestModel: observation.requestModel }) }, parent(), correlation);
          if (started.kind === 'error') {
            noteObserver(started);
            break;
          }
          const model = started.value;
          const tokens = observation.usage === undefined ? {} : {
            ...(observation.usage.inputTokens === undefined ? {} : { inputTokens: observation.usage.inputTokens }),
            ...(observation.usage.outputTokens === undefined ? {} : { outputTokens: observation.usage.outputTokens }),
          };
          const hasTokens = Object.keys(tokens).length > 0;
          let settled = false;
          if (observation.responseModel !== undefined || hasTokens) {
            const updated = model.update({
              ...(observation.responseModel === undefined ? {} : { responseModel: observation.responseModel }),
              ...(hasTokens ? { usage: tokens } : {}),
            });
            noteObserver(updated);
            settled = updated.kind === 'ok';
          }
          if (settled) noteObserver(model.finish({ kind: 'success' }));
          else openModels.push(model);
          break;
        }
        case 'interrupt':
          break;
        case 'unsupported':
          // Every unfilled family is reported as a gap at the terminal, declared or not.
          break;
        case 'terminal':
          finishRun(observation);
          break;
      }
    }
    const { events, diagnostics, error, observerError } = batch;
    const projection: ProjectionResult = error
      ? Object.freeze({ kind: 'error', error })
      : Object.freeze({ kind: 'mapped', events: Object.freeze(events) });
    return Object.freeze({
      projection,
      diagnostics: Object.freeze(diagnostics),
      ...(observerError === undefined ? {} : { observer: observerError }),
    });
  }

  let report: RunBaselineReport | undefined;
  function close(): RunBaselineReport {
    if (report) return report;
    observer.close();
    projector.close();
    const families = projectionFamilies.map(family => {
      const described = describeProjection(family, {
        availability: filled.has(family) ? 'supported' : 'unsupported', qualification: 'unqualified',
      });
      if (described.kind === 'error') throw new Error('unreachable projection family');
      return described.value;
    });
    const baseline: BaselineDescription[] = (['text', 'tools', 'steps'] as const).map(family => Object.freeze({
      family,
      availability: (family === 'text' ? sawText : family === 'tools' ? sawTool : false) ? 'supported' : 'unsupported',
      qualification: 'unqualified',
    }));
    report = Object.freeze({
      families: Object.freeze(families),
      baseline: Object.freeze(baseline),
      ...(firstError === undefined ? {} : { error: firstError }),
    });
    return report;
  }

  return Object.freeze({ kind: 'ok', value: Object.freeze({ accept, close }) });
}
