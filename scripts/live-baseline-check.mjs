// Pure assertions for scripts/live-baseline.mjs. Each returns { ok: true, ... } or { ok: false, code }.
// A code is a fixed identifier: it never carries prompt, completion, tool JSON, a path, or a credential.

const AGENT_OUTCOME = Object.freeze({
  success: 'success', failed: 'error', cancelled: 'cancelled', 'outcome-unknown': 'outcome-unknown',
});
const CONTENT_KEYS = Object.freeze([
  'gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions',
  'gen_ai.tool.definitions', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
]);
export const PROJECTION_FAMILIES = Object.freeze([
  'state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'usage', 'reasoning', 'subagents',
]);
const fail = (code) => ({ ok: false, code });

/** `expect.modelSpans` is `some` or `none`; `counts` is the lotel span count object. */
export function checkEngineEvidence(engine, counts) {
  switch (engine.expect?.modelSpans) {
    case 'some': return counts.model === 0 ? fail('model-span-missing') : { ok: true };
    case 'none': return counts.model !== 0 ? fail('model-span-unexpected') : { ok: true };
    default: return fail('expectation-missing');
  }
}

export function lastTerminal(observations) {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    if (observations[index]?.kind === 'terminal') return observations[index];
  }
  return undefined;
}

/** The `switchboard.outcome` attribute the observer writes for the observed terminal. */
export function expectedAgentOutcome(observations) {
  const terminal = lastTerminal(observations);
  return terminal === undefined ? undefined : AGENT_OUTCOME[terminal.outcome];
}

/**
 * Tool spans: at most one per call id that reached completed or failed, or arguments-ended carrying a result.
 * Model spans: one per model-boundary.
 */
export function expectedSpanCounts(observations) {
  const tools = new Set();
  let model = 0;
  for (const observation of observations) {
    if (observation?.kind === 'model-boundary') model += 1;
    if (observation?.kind !== 'tool') continue;
    if (observation.phase === 'completed' || observation.phase === 'failed'
      || (observation.phase === 'arguments-ended' && observation.resultJson !== undefined)) tools.add(observation.callId);
  }
  return { agent: 1, tool: tools.size, model };
}

/** Mirrors the baseline: reasoning needs non-empty text, and usage counts only when the terminal event carries rows. */
function observedFamilies(observations, events) {
  const supported = new Set();
  if (observations.some((item) => item?.kind === 'reasoning' && typeof item.text === 'string' && item.text !== '')) supported.add('reasoning');
  const terminal = events.findLast((event) => event?.type === 'RUN_FINISHED' || event?.type === 'RUN_ERROR');
  if (Array.isArray(terminal?.usage) && terminal.usage.length > 0) supported.add('usage');
  return supported;
}

function checkReport(report, observations, events) {
  if (report === undefined || report === null || !Array.isArray(report.families) || !Array.isArray(report.baseline)) {
    return fail('report-missing');
  }
  const supported = observedFamilies(observations, events);
  for (const family of PROJECTION_FAMILIES) {
    const row = report.families.find((item) => item?.family === family);
    if (row === undefined) return fail('family-missing');
    if (row.qualification !== 'unqualified') return fail('family-qualified');
    if (row.availability !== (supported.has(family) ? 'supported' : 'unsupported')) return fail('family-availability');
  }
  const sawText = observations.some((item) => item?.kind === 'text');
  const sawTool = observations.some((item) => item?.kind === 'tool');
  const expected = { text: sawText, tools: sawTool, steps: false };
  for (const [family, seen] of Object.entries(expected)) {
    const row = report.baseline.find((item) => item?.family === family);
    if (row === undefined) return fail('family-missing');
    if (row.qualification !== 'unqualified') return fail('family-qualified');
    if (row.availability !== (seen ? 'supported' : 'unsupported')) return fail('family-availability');
  }
  return { ok: true };
}

/** The native call id inside an AG-UI tool call id `[1, sourceKey, 'tool', scope, id]` (src/agui/internal.ts `identity`), else the id itself. */
function nativeToolCallId(toolCallId) {
  try {
    const parsed = JSON.parse(toolCallId);
    if (Array.isArray(parsed) && parsed.length === 5 && parsed[0] === 1 && parsed[2] === 'tool' && typeof parsed[4] === 'string') return parsed[4];
  } catch {
    // Not an encoded id.
  }
  return toolCallId;
}

/**
 * `batches` are the `accept(...).projection` values in order. `observations` are the `RunObservation` values fed.
 * `report` is `close()`'s result.
 */
export function checkAguiRun({ batches, observations, report }) {
  if (!Array.isArray(batches) || !Array.isArray(observations)) return fail('input-malformed');
  if (batches.some((batch) => batch?.kind !== 'mapped')) return fail('projection-error');
  const events = batches.flatMap((batch) => batch.events);
  if (events[0]?.type !== 'RUN_STARTED') return fail('run-started-first');
  const terminal = lastTerminal(observations);
  if (terminal === undefined) return fail('terminal-missing');
  const finished = events.find((event) => event.type === 'RUN_FINISHED');
  const errored = events.some((event) => event.type === 'RUN_ERROR');
  switch (terminal.outcome) {
    case 'success': {
      if (finished === undefined || errored) return fail('run-finished-missing');
      if (finished.outcome !== undefined && finished.outcome.type !== 'success') return fail('run-finished-outcome');
      const text = events
        .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_CHUNK')
        .map((event) => (typeof event.delta === 'string' ? event.delta : '')).join('');
      if (text.length === 0) return fail('text-missing');
      break;
    }
    case 'failed':
      if (!errored) return fail('run-error-missing');
      break;
    case 'cancelled':
      if (finished === undefined || finished.outcome?.type !== 'cancelled') return fail('run-finished-outcome');
      break;
    case 'outcome-unknown':
      if (finished !== undefined || errored) return fail('outcome-unknown-terminated');
      break;
    default:
      return fail('terminal-malformed');
  }
  const calls = new Map();
  const call = (id) => {
    if (!calls.has(id)) calls.set(id, { args: '', results: [] });
    return calls.get(id);
  };
  for (const event of events) {
    if (event.type === 'TOOL_CALL_ARGS') call(event.toolCallId).args += String(event.delta);
    if (event.type === 'TOOL_CALL_RESULT') call(event.toolCallId).results.push(typeof event.content === 'string' ? event.content : JSON.stringify(event.content));
  }
  const own = (callId) => [...calls].filter(([id]) => nativeToolCallId(id) === callId).map(([, value]) => value);
  const byCall = new Map();
  for (const observation of observations) {
    if (observation?.kind !== 'tool') continue;
    if (!byCall.has(observation.callId)) byCall.set(observation.callId, []);
    byCall.get(observation.callId).push(observation);
  }
  for (const [callId, items] of byCall) {
    const mine = own(callId);
    const args = mine.map((item) => item.args).join('');
    const deltas = items.filter((item) => item.phase === 'arguments' && typeof item.argumentsJson === 'string' && item.argumentsJson !== '');
    if (deltas.length > 0) {
      if (deltas.map((item) => item.argumentsJson).join('') !== args) return fail('tool-arguments-missing');
    } else {
      const first = items.find((item) => typeof item.argumentsJson === 'string' && item.argumentsJson !== '');
      if (first !== undefined && !args.includes(first.argumentsJson)) return fail('tool-arguments-missing');
    }
    const results = mine.flatMap((item) => item.results);
    for (const item of items) {
      if (typeof item.resultJson === 'string' && !results.some((result) => result.includes(item.resultJson))) return fail('tool-result-missing');
    }
  }
  return checkReport(report, observations, events);
}

const attributesOf = (span) => (span !== null && typeof span === 'object' && span.attributes !== null
  && typeof span.attributes === 'object' ? span.attributes : {});

/** `spans` is the bare array `lotel query traces` printed. It is filtered again here by run id. */
export function checkLotelSpans({ spans, runId, observations }) {
  if (!Array.isArray(spans)) return fail('traces-malformed');
  const own = spans.filter((span) => attributesOf(span)['switchboard.run_id'] === runId);
  const operation = (span) => attributesOf(span)['gen_ai.operation.name'];
  const agents = own.filter((span) => operation(span) === 'invoke_agent');
  const counts = {
    agent: agents.length,
    tool: own.filter((span) => operation(span) === 'execute_tool').length,
    model: own.filter((span) => operation(span) !== 'invoke_agent' && operation(span) !== 'execute_tool').length,
  };
  const result = (code) => ({ ok: false, code, counts });
  if (counts.agent !== 1) return result('agent-span-count');
  const outcome = expectedAgentOutcome(observations);
  if (outcome === undefined) return result('terminal-missing');
  if (attributesOf(agents[0])['switchboard.outcome'] !== outcome) return result('agent-outcome');
  for (const span of own) {
    const keys = Object.keys(attributesOf(span));
    if (keys.some((key) => CONTENT_KEYS.includes(key))) return result('content-attribute');
  }
  const expected = expectedSpanCounts(observations);
  if (counts.tool !== expected.tool) return result('tool-span-count');
  if (counts.model !== expected.model) return result('model-span-count');
  return { ok: true, counts, outcome };
}
