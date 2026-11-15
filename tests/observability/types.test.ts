import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { createGenAiObserver, type ContentObservation, type GenAiOperation, type TerminalOutcome } from '@mattsp1290/switchboard/observability';

export const observer = createGenAiObserver({ tracer: trace.getTracer('consumer'), contentPolicy: { kind: 'none' }, allowedToolNames: ['add'] });
export const model = observer.start({ kind: 'model', provider: 'openai', operation: 'chat' }, ROOT_CONTEXT);
if (model.kind === 'ok') {
  model.value.update({ responseModel: 'actual', usage: { inputTokens: 0, outputTokens: 1 } });
  model.value.finish({ kind: 'error', category: 'provider-error' });
}
export const agent = observer.start({ kind: 'agent', provider: 'openai' }, ROOT_CONTEXT);
export const tool = observer.start({ kind: 'tool', name: 'add' }, ROOT_CONTEXT);
const operation: GenAiOperation = { kind: 'model', provider: 'openai', operation: 'text_completion' };
const outcome: TerminalOutcome = { kind: 'outcome-unknown' };
const content: ContentObservation = { kind: 'output', messages: [{ role: 'assistant', parts: [{ type: 'text', content: 'response' }], finish_reason: 'stop' }] };
observer.start(operation, ROOT_CONTEXT, { runId: 'run-1' });
if (agent.kind === 'ok') agent.value.finish(outcome);
if (tool.kind === 'ok') tool.value.finish({ kind: 'success' });
createGenAiObserver({ tracer: trace.getTracer('consumer'), allowedToolNames: [], contentPolicy: { kind: 'sanitized', sanitize: value => value } });
void content;
