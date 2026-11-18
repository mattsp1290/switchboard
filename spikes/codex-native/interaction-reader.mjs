import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { accountProfile, accountRouting } from './account-reads.mjs';
// The compiled product modules, mounted read-only from the host's fresh build.
import { createCodexWriters, openCodexExecution } from '../dist/adapters/codex/execution.js';
import { codexApprovalEvidence, codexServerRequestSupport, createCodexInteraction } from '../dist/adapters/codex/interaction.js';

// Container side of the 118i native proof: one scenario per container. The harness plays the host: it spawns and kills
// app-servers, lends their stdio as the channel, attests process exit and continues approvals through the bridge. It
// records facts, raw native observations, every native error and named failed checks; the host
// (interaction-proof.mjs) is the only place a run passes. Never retries.
const SCENARIOS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N7', 'N8', 'N9'];
const [scenario] = process.argv.slice(2);
if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
const home = '/root/.codex';
const report = { scenario, failures: [], inference: {}, tools: {}, serverRequests: [], replyFrames: [], bridge: [],
  raw: { nativeErrors: [], notifications: [] } };
const need = (condition, label) => { if (!condition) report.failures.push(label); };
mkdirSync('/tmp/project', { recursive: true });

// Synthetic Responses service. The last `marker:<name>` in the request body selects the behaviour: `answer`,
// `hold-<name>` (parked until released), `call-<name>` (one native `exec_command` function call, then text once its
// output is in the history) and `tool-<name>` (a call of the named native tool when it is advertised).
const commands = { n1: 'touch /tmp/n1-marker', n2: 'touch /tmp/n2-marker', n3: 'touch /tmp/n3-marker', n4: 'touch /tmp/n4-marker',
  n5: 'touch /tmp/n5-marker', n7: 'sleep 3; touch /tmp/n7-marker', n9: 'touch /tmp/n9-marker' };
const toolCalls = { request_user_input: { questions: [{ id: 'q1', header: 'Fixture', question: 'Fixture only?', options: [
  { label: 'yes', description: 'fixture' }, { label: 'no', description: 'fixture' }] }] },
request_permissions: { reason: 'fixture', permissions: { network: { enabled: true } } } };
const held = new Map();
let responses = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) { response.writeHead(413).end(); return; }
  }
  if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
  const marker = [...body.matchAll(/marker:([a-z0-9-]+)/g)].at(-1)?.[1] ?? 'none';
  report.inference[marker] = (report.inference[marker] ?? 0) + 1;
  let input = {};
  try { input = JSON.parse(body); } catch {}
  const names = Array.isArray(input.tools) ? input.tools.map((tool) => tool?.name ?? tool?.type ?? null) : [];
  report.tools[marker] ??= names;
  const id = `resp_${++responses}`;
  const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit({ type: 'response.created', response: { id, status: 'in_progress' } });
  if (marker.startsWith('hold-')) {
    const gate = Promise.withResolvers();
    held.set(marker, gate);
    request.once('close', () => gate.resolve('gone'));
    if ((await gate.promise) === 'gone') return;
  }
  let item = { type: 'message', id: `msg_${responses}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }] };
  const continued = body.includes('"function_call_output"');
  const [kind, name] = [marker.split('-')[0], marker.slice(marker.indexOf('-') + 1)];
  if (!continued && kind === 'call' && names.includes('exec_command')) {
    item = { type: 'function_call', id: `fc_${responses}`, call_id: `call_${responses}`, name: 'exec_command', status: 'completed',
      arguments: JSON.stringify({ cmd: commands[name], yield_time_ms: 1000 }) };
  } else if (!continued && kind === 'tool' && names.includes(name)) {
    item = { type: 'function_call', id: `fc_${responses}`, call_id: `call_${responses}`, name, status: 'completed',
      arguments: JSON.stringify(toolCalls[name] ?? {}) };
  } else {
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture answer' });
  }
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { id, status: 'completed', output: [item],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
// account/read projects the API-key requester only for a provider that requires OpenAI auth (pg51 first arm64 run).
const routing = createServer(accountRouting);
await new Promise((resolve) => routing.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const config = { model_provider: 'fixture', model: 'fixture-model', check_for_update_on_startup: false, 'analytics.enabled': false,
  'features.apps': false, 'model_providers.fixture.name': 'fixture', 'model_providers.fixture.base_url': `${origin}/v1`,
  'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.supports_websockets': false,
  'model_providers.fixture.request_max_retries': 0, 'model_providers.fixture.stream_max_retries': 0,
  sqlite_home: '/tmp/private-index', log_dir: '/tmp/private-logs',
  ...accountProfile(`http://127.0.0.1:${routing.address().port}`, origin) };

const transportBounds = { maxFrameBytes: 1048576, maxChunkBytes: 2097151, maxDiagnosticBytes: 65536, maxPending: 8, maxHandlers: 4,
  maxWrites: 8, observationCapacity: 4096, handlerTimeoutMs: 15000, observationTimeoutMs: 5000, writeTimeoutMs: 20000 };
const bounds = { maxSessions: 4, maxObservers: 3, eventCapacity: 4096, maxEarlyNotifications: 256, cleanupTimeoutMs: 15000,
  acknowledgementTimeoutMs: 10000 };
const access = () => ({ bounds: { maxResults: 100, maxExamined: 1000, maxDurationMs: 20000 }, signal: AbortSignal.timeout(20000) });
// Host-passed policy (the probe's settings); the bridge never chooses one.
const threadParams = { cwd: '/tmp/project', approvalPolicy: 'untrusted', sandbox: 'read-only' };
const writers = createCodexWriters(16);
const servers = [];
const executions = [];
const within = (promise, ms, label) => Promise.race([promise, delay(ms).then(() => { throw new Error(`Timed out: ${label}`); })]);
async function until(predicate, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return true; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}
const settledWithin = async (promise, ms) => Promise.race([promise.then((value) => ({ value })), delay(ms).then(() => null)]);

/**
 * One app-server owned by this harness (the host). It records each server request raw (method, id type, param keys,
 * approvalId presence), each reply frame the bridge writes (answered method and kind) and every native error reply.
 */
function appServer() {
  const child = spawn('/opt/codex', ['app-server', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
    { cwd: '/tmp/project', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  let closed = false;
  const s = { frames: [], stderr: '', ids: new Map(), requests: new Map(), line: '' };
  s.scan = (chunk) => {
    const lines = (s.line + chunk).split('\n');
    s.line = lines.pop().slice(-1048576);
    for (const line of lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message?.method === 'string' && message.id !== undefined) {
        s.requests.set(JSON.stringify(message.id), message.method);
        const params = message.params ?? {};
        report.serverRequests.push({ method: message.method, idType: typeof message.id, paramKeys: Object.keys(params).sort(),
          approvalId: params.approvalId !== undefined && params.approvalId !== null, availableDecisions: params.availableDecisions ?? null });
      } else if (typeof message?.method === 'string' && report.raw.notifications.length < 256) {
        const { item, requestId, turn } = message.params ?? {};
        report.raw.notifications.push({ method: message.method, itemType: item?.type ?? null, itemStatus: item?.status ?? null,
          requestIdType: requestId === undefined ? null : typeof requestId, turnStatus: turn?.status ?? null });
      } else if (message?.error !== undefined && report.raw.nativeErrors.length < 32) {
        report.raw.nativeErrors.push({ method: s.ids.get(message.id) ?? null, code: message.error?.code ?? null,
          message: message.error?.message ?? null });
      }
    }
  };
  s.exited = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  s.channel = {
    listen(sink) {
      const data = (chunk) => { s.scan(chunk); sink.data(chunk); };
      const diagnostic = (chunk) => { s.stderr = (s.stderr + chunk).slice(-2048); sink.diagnostic(chunk); };
      const ended = () => sink.ended('process-exit');
      child.stdout.on('data', data);
      child.stderr.on('data', diagnostic);
      child.once('close', ended);
      return () => { child.stdout.off('data', data); child.stderr.off('data', diagnostic); child.off('close', ended); };
    },
    async write(frame) {
      let method = 'reply';
      try {
        const message = JSON.parse(Buffer.from(frame).toString());
        method = message.method ?? 'reply';
        if (message.method !== undefined && message.id !== undefined) s.ids.set(message.id, method);
        if (message.method === undefined) {
          const decision = message.result?.decision;
          report.replyFrames.push({ method: s.requests.get(JSON.stringify(message.id)) ?? null, kind: message.error ? 'error' : 'result',
            code: message.error?.code ?? null, decision: typeof decision === 'object' && decision !== null ? Object.keys(decision)[0] : decision ?? null });
        }
      } catch {}
      s.frames.push(method);
      await new Promise((resolve, reject) => child.stdin.write(frame, (error) => (error ? reject(error) : resolve())));
    },
  };
  s.count = (method) => s.frames.filter((frame) => frame === method).length;
  s.kill = async () => { if (!closed) child.kill('SIGKILL'); await s.exited; };
  s.stop = async () => {
    if (!closed) child.kill('SIGTERM');
    await Promise.race([s.exited, delay(5000)]);
    if (!closed) { child.kill('SIGKILL'); await s.exited; }
  };
  servers.push(s);
  return s;
}
/** One bridge per execution, fed by the compiled module; its events are recorded as kinds and settlement kinds. */
function bridge(expiry = null) {
  const made = createCodexInteraction({ maxObservers: 2, eventCapacity: 4096, maxSettled: 64, maxPending: 3,
    transport: transportBounds, expiry });
  if (made.kind !== 'ok') throw new Error('bridge options');
  const b = { interaction: made.value, events: [] };
  made.value.events.subscribe((event) => {
    b.events.push(event);
    report.bridge.push(event.kind === 'settled' ? `settled:${event.settlement.kind}${event.settlement.by ? `:${event.settlement.by}` : ''}`
      : event.kind === 'refused' ? `refused:${event.reason}:${event.code}`
        : event.kind === 'observed' ? `observed:${event.method}:${event.effect.kind}:${event.evidence}` : event.kind);
  });
  b.pending = async (label) => {
    await until(() => b.interaction.pending().length > 0, label);
    return b.interaction.pending()[0];
  };
  b.reply = (pending, nativeChoiceId) => b.interaction.reply({ value: { formatVersion: 1, kind: 'approval', target: pending.target,
    nativeChoiceId }, recordIntent: () => {}, signal: AbortSignal.timeout(10000) });
  b.settlements = () => b.events.filter((event) => event.kind === 'settled').map((event) => event.settlement.kind);
  return b;
}
async function execute(s, b) {
  const opened = await openCodexExecution({ channel: s.channel, transport: transportBounds, bounds, home, writers,
    initialize: { clientInfo: { name: 'switchboard_interaction_proof', version: '0' } }, signal: AbortSignal.timeout(10000),
    processExit: s.exited, onServerRequest: b.interaction.onServerRequest });
  if (opened.kind !== 'ok') throw new Error(`open ${opened.error.code}: ${s.stderr}`);
  const execution = opened.value;
  executions.push(execution);
  const login = await execution.scope.request({ method: 'account/login/start', params: { type: 'apiKey', apiKey: 'synthetic-interaction-key' } },
    AbortSignal.timeout(10000));
  need(login.kind === 'reply' && login.envelope.reply.kind === 'result', 'API key login');
  return execution;
}
const outcome = (value) => (value.kind === 'ok' ? value.value.kind ?? 'ok' : `error:${value.error.code}`);
function watch(session) {
  const seen = { methods: [], items: [] };
  session.events.subscribe((event) => {
    if (event.kind !== 'native') return;
    seen.methods.push(event.method);
    if (event.method === 'item/completed' || event.method === 'item/started') {
      seen.items.push({ method: event.method, type: event.params?.item?.type ?? null, status: event.params?.item?.status ?? null });
    }
  });
  return seen;
}
function turnOn(session, marker) {
  const started = session.turn({ hostOperationId: `op-${marker}-${Math.random()}`, signal: AbortSignal.timeout(20000), recordIntent: () => {},
    input: [{ type: 'text', text: `Fixture only. marker:${marker}`, text_elements: [] }] });
  if (started.kind !== 'ok') throw new Error(`turn ${started.error.code}`);
  return started.value;
}
async function create(execution, b) {
  const created = await execution.create({ ...access(), params: threadParams });
  if (created.kind !== 'ok') throw new Error(`create ${created.error.code}`);
  need(b.interaction.attach(created.value).kind === 'ok', 'attach');
  return created.value;
}
const status = (completion) => (completion.kind === 'terminal' ? completion.terminal.status : completion.kind);
const terminal = async (turn, label, ms = 15000) => status(await within(turn.completion, ms, label));
const commandItem = (seen) => seen.items.filter((item) => item.method === 'item/completed' && item.type === 'commandExecution')
  .map((item) => item.status);
const decisionFrames = () => report.replyFrames.filter((frame) => frame.kind === 'result');
/** The one raw ordering record per scenario: resolved, item completion and turn terminal positions in native order. */
const order = () => report.raw.notifications.map((entry) => entry.method)
  .filter((method) => ['serverRequest/resolved', 'item/completed', 'turn/completed'].includes(method));

try {
  report.labels = { support: codexServerRequestSupport, evidence: codexApprovalEvidence };
  if (['N1', 'N2'].includes(scenario)) {
    // N1: 0.169 offers no `decline` here, so the not-offered choice must be refused locally before the native `cancel`.
    const choice = { N1: 'cancel', N2: 'accept' }[scenario];
    const marker = `call-${scenario.toLowerCase()}`;
    const b = bridge();
    const session = await create(await execute(appServer(), b), b);
    const seen = watch(session);
    const turn = turnOn(session, marker);
    const pending = await b.pending('approval');
    report.pendingMethod = pending.request.data.method;
    report.choices = pending.choices.map((entry) => entry.nativeChoiceId);
    if (scenario === 'N1') {
      report.notOffered = outcome(await b.reply(pending, 'decline'));
      report.framesAfterNotOffered = report.replyFrames.length;
    }
    report.reply = outcome(await b.reply(pending, choice));
    report.duplicate = outcome(await b.reply(pending, choice));
    report.terminal = await terminal(turn, 'terminal');
    await delay(300);
    report.item = commandItem(seen);
    report.settlements = b.settlements();
    report.decisionFrames = decisionFrames().map((frame) => frame.decision);
    report.marker = existsSync(`/tmp/${scenario.toLowerCase()}-marker`);
    report.markerInference = report.inference[marker] ?? 0;
    report.order = order();
  } else if (scenario === 'N3') {
    const b = bridge();
    const execution = await execute(appServer(), b);
    const [a, other] = [await create(execution, b), await create(execution, b)];
    const ta = turnOn(a, 'call-n3');
    const pending = await b.pending('A approval');
    const tb = turnOn(other, 'answer');
    report.b = await terminal(tb, 'B');
    report.aPendingAfterB = b.interaction.pending().length === 1;
    const read = await execution.scope.request({ method: 'thread/read', params: { threadId: other.threadId } }, AbortSignal.timeout(10000));
    report.read = read.kind === 'reply' ? read.envelope.reply.kind : read.kind;
    report.concurrentA = report.serverRequests.filter((entry) => entry.method === pending.request.data.method).length;
    report.reply = outcome(await b.reply(pending, 'cancel'));
    report.a = await terminal(ta, 'A');
    report.marker = existsSync('/tmp/n3-marker');
  } else if (scenario === 'N4' || scenario === 'N9') {
    // N4: interrupt while the approval is held. N9: the host-selected expiry answers a decision-free error.
    const b = bridge(scenario === 'N9' ? { afterMs: 500 } : null);
    const marker = `call-${scenario.toLowerCase()}`;
    const execution = await execute(appServer(), b);
    const session = await create(execution, b);
    const seen = watch(session);
    const turn = turnOn(session, marker);
    await b.pending('approval');
    if (scenario === 'N4') report.interrupt = await session.interrupt();
    else await until(() => b.settlements().length > 0, 'expiry', 5000);
    const settledTurn = await settledWithin(turn.completion, 5000);
    report.terminalWithin5s = settledTurn ? status(settledTurn.value) : null;
    await delay(300);
    report.settlements = b.settlements();
    report.withdrawnBy = b.events.find((event) => event.kind === 'settled')?.settlement.by ?? null;
    report.decisionFrames = decisionFrames().length;
    report.errorFrames = report.replyFrames.filter((frame) => frame.kind === 'error').map((frame) => frame.code);
    // Native gave no terminal: end the scenario after the checked facts were taken, by the host's native `cancel` while
    // the approval is still live, else by interrupt (N9's first); recorded, never assumed.
    if (!settledTurn) {
      const live = b.interaction.pending()[0];
      report.cleanup = live ? `cancel:${outcome(await b.reply(live, 'cancel'))}` : `interrupt:${await session.interrupt()}`;
    }
    report.terminal = await terminal(turn, 'terminal');
    report.item = commandItem(seen);
    report.marker = existsSync(`/tmp/${scenario.toLowerCase()}-marker`);
    report.markerInference = report.inference[marker] ?? 0;
    report.order = order();
    report.independent = await terminal(turnOn(await create(execution, b), 'answer'), 'independent');
  } else if (scenario === 'N5') {
    const first = appServer();
    const b = bridge();
    const session = await create(await execute(first, b), b);
    need((await terminal(turnOn(session, 'answer'), 'seed')) === 'completed', 'seed turn completed');
    const turn = turnOn(session, 'call-n5');
    const pending = await b.pending('approval');
    const before = report.inference['call-n5'] ?? 0;
    report.heldBeforeKill = writers.held();
    await first.kill();
    report.completion = status(await within(turn.completion, 10000, 'loss'));
    await delay(100);
    report.heldAfterExit = writers.held();
    report.settlements = b.settlements();
    report.lateReply = outcome(await b.reply(pending, 'accept'));
    report.replyFramesBeforeResume = report.replyFrames.length;
    const requestsBefore = report.serverRequests.length;
    const fresh = bridge();
    const resumed = await (await execute(appServer(), fresh)).resume({ ...access(), binding: session.reference.binding,
      reference: session.reference, params: threadParams });
    report.resume = outcome(resumed);
    // Attached at once, so a replayed approval would be held answerable (and recorded) rather than refused.
    if (resumed.value?.kind === 'resumed') need(fresh.interaction.attach(resumed.value.session).kind === 'ok', 'attach resumed');
    await delay(1000);
    report.reappeared = fresh.interaction.pending().length;
    const turns = resumed.value?.session?.native?.thread?.turns ?? [];
    report.resumedLastTurn = turns.at(-1)?.status ?? null;
    report.resumedItems = (turns.at(-1)?.items ?? []).filter((item) => item?.type === 'commandExecution').map((item) => item.status ?? null);
    report.requestsAfterResume = report.serverRequests.length - requestsBefore;
    report.inferenceAfterResume = (report.inference['call-n5'] ?? 0) - before;
    report.marker = existsSync('/tmp/n5-marker');
  } else if (scenario === 'N7') {
    const b = bridge();
    const session = await create(await execute(appServer(), b), b);
    const seen = watch(session);
    const turn = turnOn(session, 'call-n7');
    report.reply = outcome(await b.reply(await b.pending('approval'), 'accept'));
    const started = await until(() => seen.items.some((item) => item.method === 'item/started' && item.type === 'commandExecution'),
      'command started', 5000).catch(() => false);
    report.commandStarted = started;
    report.interrupt = await session.interrupt();
    report.terminal = await terminal(turn, 'terminal');
    await delay(5000);
    report.item = commandItem(seen);
    report.marker = existsSync('/tmp/n7-marker');
    report.order = order();
  } else if (scenario === 'N8') {
    const b = bridge();
    const execution = await execute(appServer(), b);
    const session = await create(execution, b);
    await terminal(turnOn(session, 'answer'), 'tool list');
    const advertised = report.tools.answer ?? [];
    report.candidates = ['request_permissions', 'request_user_input'].filter((name) => advertised.includes(name));
    report.reactions = {};
    for (const name of report.candidates) {
      const seen = watch(session);
      const marker = `tool-${name}`;
      const turn = turnOn(session, marker);
      const ended = await terminal(turn, name, 6000).catch(async () => {
        // Held by native after the refusal: interrupt so the session is free for the next candidate; recorded.
        const interrupted = await session.interrupt();
        return `held:${interrupted}:${await terminal(turn, `${name} interrupt`, 6000).catch(() => 'none')}`;
      });
      report.reactions[name] = { terminal: ended, items: seen.items.filter((item) => item.method === 'item/completed').map((item) => item.type),
        inference: report.inference[marker] ?? 0 };
    }
    if (report.candidates.length === 0) report.notAdvertised = true;
    report.refusedMethods = b.events.filter((event) => event.kind === 'refused').map((event) => event.method);
    report.errorOnlyRefusals = report.replyFrames.filter((frame) => codexServerRequestSupport[frame.method] !== 'approval')
      .every((frame) => frame.kind === 'error');
  }
} catch (error) {
  report.failures.push(`exception: ${error.message}`);
} finally {
  for (const gate of held.values()) gate.resolve('go');
  const reports = await Promise.allSettled(executions.map((execution) => within(execution.close(), 20000, 'execution close')));
  report.closeReasons = reports.map((settled) => (settled.status === 'fulfilled' ? settled.value.transport.reason : 'timeout'));
  for (const s of servers) await s.stop();
  report.heldAtEnd = writers.held();
  report.stderrTail = servers.map((s) => s.stderr.slice(-512));
  for (const owned of [server, routing]) {
    owned.closeAllConnections();
    await new Promise((resolve) => owned.close(resolve));
  }
}
console.log(JSON.stringify(report));
