import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { ROOT_CONTEXT } from '@opentelemetry/api';

export const fixtureCanaries = Object.freeze({
  secretInput: 'SWITCHBOARD_SYNTHETIC_INPUT_SECRET_84d6',
  secretOutput: 'SWITCHBOARD_SYNTHETIC_OUTPUT_SECRET_29b3',
  approvedInput: 'approved synthetic question',
  approvedOutput: 'approved synthetic answer',
});

const expected = (agentCount, modelCount, toolCount, inputTokens, outputTokens, outcome) =>
  Object.freeze({ agentCount, modelCount, toolCount, inputTokens, outputTokens, outcome });

export const fixtureScenarios = Object.freeze([
  { id: 'success-none', contentPolicy: 'none', expected: expected(1, 2, 1, 7, 4, 'success') },
  { id: 'success-sanitized', contentPolicy: 'sanitized', expected: expected(1, 2, 1, 7, 4, 'success') },
  { id: 'missing-usage', contentPolicy: 'none', expected: expected(1, 1, 0, undefined, undefined, 'success') },
  { id: 'http-error', contentPolicy: 'none', expected: expected(1, 1, 0, undefined, undefined, 'error') },
  { id: 'disconnect', contentPolicy: 'none', expected: expected(1, 1, 0, undefined, undefined, 'outcome-unknown') },
  { id: 'cancelled', contentPolicy: 'none', expected: expected(1, 1, 0, undefined, undefined, 'cancelled') },
  { id: 'parallel', contentPolicy: 'none', expected: expected(2, 2, 0, 2, 2, 'success') },
].map(Object.freeze));

export function fixtureContentPolicy(scenario) {
  const selected = typeof scenario === 'string' ? fixtureScenarios.find((entry) => entry.id === scenario) : scenario;
  if (!selected) throw new TypeError('Unknown fixture scenario');
  if (selected.contentPolicy !== 'sanitized') return { kind: 'none' };
  return {
    kind: 'sanitized',
    sanitize({ kind, messages }) {
      return { kind, messages: messages.map((message) => ({
        role: message.role,
        parts: [{ type: 'text', content: kind === 'input' ? fixtureCanaries.approvedInput : fixtureCanaries.approvedOutput }],
        ...(kind === 'output' ? { finish_reason: message.finish_reason } : {}),
      })) };
    },
  };
}

export const fixtureBatchOptions = Object.freeze({
  maxQueueSize: 256, maxExportBatchSize: 32, scheduledDelayMillis: 200, exportTimeoutMillis: 5000,
});

export async function withHostDeadline(operation, label = 'host operation', milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function modelRequest(url, mode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    let final;
    let buffer = '';
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        response.once('end', () => settle({ outcome: 'error' }));
        return;
      }
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (settled) return;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let event;
          try { event = JSON.parse(line); } catch {
            req.destroy();
            clearTimeout(timer);
            reject(new Error('Invalid synthetic fixture protocol'));
            settled = true;
            return;
          }
          if (mode === 'cancelled' && event.type === 'delta') {
            cancelled = true;
            req.destroy();
            settle({ outcome: 'cancelled' });
            return;
          }
          if (event.type === 'completed') final = event;
        }
      });
      response.once('end', () => settle(final ? {
        outcome: 'success', responseModel: final.model, usage: final.usage,
        outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: final.text }], finish_reason: final.finish_reason }],
      } : { outcome: 'outcome-unknown' }));
      response.once('aborted', () => settle({ outcome: cancelled ? 'cancelled' : 'outcome-unknown' }));
      response.once('error', () => settle({ outcome: cancelled ? 'cancelled' : 'outcome-unknown' }));
    });
    const timer = setTimeout(() => {
      req.destroy();
      if (!settled) {
        settled = true;
        reject(new Error('Synthetic HTTP fixture deadline exceeded'));
      }
    }, 5000);
    req.once('error', () => settle({ outcome: cancelled ? 'cancelled' : 'outcome-unknown' }));
    req.end(JSON.stringify({ model: 'switchboard-fixture', synthetic: true, input: fixtureCanaries.secretInput }));
  });
}

export async function runFixtureScenario({ scenario, observer, enabled = true, runId = randomUUID() }) {
  const selected = typeof scenario === 'string' ? fixtureScenarios.find((entry) => entry.id === scenario) : scenario;
  if (!selected || !fixtureScenarios.some((entry) => entry.id === selected.id)) throw new TypeError('Unknown fixture scenario');
  const startedAt = new Date().toISOString();
  const sockets = new Set();
  const timers = new Set();
  let requests = 0;
  let toolExecutions = 0;
  const spans = [];
  const roots = [];
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const server = createServer((incoming, response) => {
    requests += 1;
    const call = requests;
    incoming.resume();
    if (selected.id === 'http-error') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":"synthetic-provider-error"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ type: 'delta', text: 'synthetic chunk one' })}\n`);
    if (selected.id === 'disconnect') {
      schedule(() => response.destroy(), 10);
      return;
    }
    schedule(() => {
      if (response.destroyed) return;
      response.write(`${JSON.stringify({ type: 'delta', text: 'synthetic chunk two' })}\n`);
      const usage = selected.id === 'missing-usage' ? undefined : selected.id === 'parallel'
        ? { inputTokens: 1, outputTokens: 1 }
        : call === 1 ? { inputTokens: 5, outputTokens: 3 } : { inputTokens: 2, outputTokens: 1 };
      response.end(`${JSON.stringify({ type: 'completed', model: 'switchboard-fixture',
        text: fixtureCanaries.secretOutput, finish_reason: 'stop', ...(usage ? { usage } : {}) })}\n`);
    }, 15);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const start = (descriptor, parent, correlation) => {
    if (!enabled) return undefined;
    const result = observer.start(descriptor, parent, correlation);
    return result.kind === 'ok' ? result.value : undefined;
  };
  const finish = (handle, kind, parentSpanId, requestId, outcome, usage) => {
    if (!handle) return;
    handle.finish(outcome === 'error' ? { kind: 'error', category: 'provider-error' } : { kind: outcome });
    const identity = handle.spanContext;
    spans.push({ kind, traceId: identity.traceId, spanId: identity.spanId,
      ...(parentSpanId ? { parentSpanId } : {}), requestId, outcome, ...(usage ? { usage: { ...usage } } : {}) });
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
    const invocation = async (index) => {
      const correlation = { runId, requestId: `${runId}-agent-${index}`, conversationId: `${runId}-conversation-${index}` };
      const agent = start({ kind: 'agent', provider: 'openai', name: 'synthetic-fixture' }, ROOT_CONTEXT, correlation);
      if (agent) roots.push({ traceId: agent.spanContext.traceId, spanId: agent.spanContext.spanId });
      const parent = agent?.context ?? ROOT_CONTEXT;
      const callModel = async (number) => {
        const requestId = `${runId}-model-${index}-${number}`;
        const model = start({ kind: 'model', provider: 'openai', operation: 'chat', requestModel: 'switchboard-fixture',
          inputMessages: [{ role: 'user', parts: [{ type: 'text', content: fixtureCanaries.secretInput }] }],
        }, parent, { ...correlation, requestId });
        const result = await modelRequest(url, selected.id);
        if (result.outcome === 'success') model?.update({ responseModel: result.responseModel,
          ...(result.usage ? { usage: result.usage } : {}), outputMessages: result.outputMessages });
        finish(model, 'model', agent?.spanContext.spanId, requestId, result.outcome, result.usage);
        return result.outcome;
      };
      let outcome = await callModel(1);
      if (selected.id.startsWith('success-')) {
        const requestId = `${runId}-tool-${index}`;
        const tool = start({ kind: 'tool', name: 'fixture-add', callId: `${runId}-tool-call-${index}` }, parent,
          { ...correlation, requestId });
        const sum = await Promise.resolve(2 + 3);
        toolExecutions += 1;
        if (sum !== 5) throw new Error('Synthetic tool returned an incorrect result');
        finish(tool, 'tool', agent?.spanContext.spanId, requestId, 'success');
        outcome = await callModel(2);
      }
      finish(agent, 'agent', undefined, correlation.requestId, outcome);
      return outcome;
    };
    const outcomes = selected.id === 'parallel' ? await Promise.all([invocation(1), invocation(2)]) : [await invocation(1)];
    return { scenario: selected.id, runId, startedAt, endedAt: new Date().toISOString(), requests, toolExecutions,
      roots, spans, outcome: outcomes[0], result: outcomes.every((outcome) => outcome === 'success') ? 'completed' : outcomes[0] };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await withHostDeadline(() => new Promise((resolve, reject) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
    })), 'fixture server close');
  }
}
