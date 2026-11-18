import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openCodexTransport } from '/dist/adapters/codex/transport.js';

// Container side of probes A1 to A4. The probe plays the host: it spawns the pinned app-server, lends its stdio to
// Switchboard's compiled transport, answers `item/tool/call` itself and records what native does. It never asserts;
// run.mjs saves the report and the qualification document reads it.
// hold-control passes the 15 s handler bound of the native interaction proof, below its own hold, to show that the
// probe sees a hold cut short; the bound, not native, ends it. `namespace` declares the tool inside a namespace, as
// Crew's trusted lane does (crew:src/service/trusted-codex.ts:139). `resumed` holds in a second process after
// thread/resume. `freshIndex` gives every process its own empty sqlite_home, so only CODEX_HOME carries the thread.
const SCENARIOS = { 'hold-121': { holdMs: 121_000 }, 'hold-151': { holdMs: 151_000 }, 'hold-171': { holdMs: 171_000 },
  'hold-control': { holdMs: 30_000, handlerTimeoutMs: 15_000 },
  'hold-171-resumed-namespace': { holdMs: 171_000, resumed: true, namespace: true },
  resume: { resume: true }, 'resume-namespace': { resume: true, namespace: true }, 'resume-fresh-index': { resume: true, freshIndex: true } };
const [scenario] = process.argv.slice(2);
if (!(scenario in SCENARIOS)) throw new Error(`Unknown scenario ${scenario}`);

const target = { arm64: ['codex-linux-arm64', 'aarch64-unknown-linux-musl'], x64: ['codex-linux-x64', 'x86_64-unknown-linux-musl'] }[process.arch];
const CODEX = `/node_modules/@openai/${target[0]}/vendor/${target[1]}/bin/codex`;
const HOME = '/home/probe';
const CODEX_HOME = join(HOME, '.codex');
const PROJECT = join(HOME, 'project');
for (const dir of [CODEX_HOME, PROJECT]) mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const now = () => Date.now() - t0;
const TOOL = 'host_probe';
const { namespace = false, freshIndex = false } = SCENARIOS[scenario];
const fn = (name) => ({ type: 'function', name, description: 'Host-run probe tool. Call it when asked.',
  inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false } });
const toolSpec = (name) => (namespace ? { type: 'namespace', name: 'application', description: 'Host application tools',
  tools: [{ ...fn(name), deferLoading: false }] } : fn(name));

// The bounds a host passes to Switchboard's transport. `handlerTimeoutMs` bounds how long any server request may be held
// for the whole transport (docs/architecture/boundaries.md), so a host that holds a tool call for Crew's longest live
// deadline (170 s, crew:src/service/codex-calls.ts) must pass more than that. The other values are the ones the native
// interaction proof passes (spikes/codex-native/interaction-reader.mjs).
const TRANSPORT_BOUNDS = { maxFrameBytes: 1048576, maxChunkBytes: 2097151, maxDiagnosticBytes: 65536, maxPending: 8,
  maxHandlers: 4, maxWrites: 8, observationCapacity: 4096, handlerTimeoutMs: SCENARIOS[scenario].handlerTimeoutMs ?? 180_000,
  observationTimeoutMs: 5000, writeTimeoutMs: 20000 };

const report = { scenario, codex: execFileSync(CODEX, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME, CODEX_HOME },
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), node: process.version, arch: process.arch,
  environmentKeys: Object.keys(process.env).sort(), transportBounds: TRANSPORT_BOUNDS, model: [], processes: [] };

// Synthetic Responses service. A request whose last input item is a function_call_output gets a text answer; any other
// request gets one function_call of the tool named by the last `call:<name>` in the newest user message. Every
// response carries distinct usage so totals can be told apart from per-request counts.
const usageOf = (n) => ({ input_tokens: 1000 * n + 1, input_tokens_details: { cached_tokens: n },
  output_tokens: 10 * n + 2, output_tokens_details: { reasoning_tokens: n }, total_tokens: 1000 * n + 1 + 10 * n + 2 });
const textOf = (item) => (typeof item?.content === 'string' ? item.content
  : Array.isArray(item?.content) ? item.content.map((part) => part?.text ?? '').join('') : '');
let responses = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    report.model.push({ at: now(), method: request.method, url: request.url, status: 404 });
    response.writeHead(404).end();
    return;
  }
  const n = ++responses;
  const input = JSON.parse(body);
  const items = Array.isArray(input.input) ? input.input : [];
  const last = items.at(-1);
  const lastUser = items.findLast((item) => item?.role === 'user');
  const wanted = [...textOf(lastUser).matchAll(/call:([a-z_]+)/g)].at(-1)?.[1] ?? null;
  const continued = last?.type === 'function_call_output';
  const entry = { n, at: now(), tools: (input.tools ?? []).map((tool) => tool?.name ?? `(${tool?.type})`),
    offered: (input.tools ?? []).filter((tool) => /host_probe/.test(JSON.stringify(tool))),
    inputTypes: items.map((item) => item?.type ?? `role:${item?.role}`),
    functionCalls: items.filter((item) => item?.type === 'function_call').map(({ call_id, name, arguments: args }) => ({ call_id, name, arguments: args })),
    functionCallOutputs: items.filter((item) => item?.type === 'function_call_output').map(({ call_id, output }) => ({ call_id, output })),
    lastUser: textOf(lastUser).slice(0, 200), wanted, continued };
  report.model.push(entry);
  const id = `resp_${n}`;
  const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit({ type: 'response.created', response: { id, status: 'in_progress' } });
  let item;
  if (!continued && wanted) {
    // A namespaced tool is called with its namespace, as the Responses wire carries it.
    const space = (input.tools ?? []).find((tool) => tool?.type === 'namespace' && JSON.stringify(tool.tools ?? []).includes(`"${wanted}"`));
    item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: wanted, ...(space && { namespace: space.name }),
      status: 'completed', arguments: JSON.stringify({ note: `request ${n}` }) };
    entry.reply = { functionCall: item.call_id, name: wanted, namespace: space?.name ?? null };
  } else {
    const text = continued ? `answer after ${last.call_id}` : 'plain answer';
    item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
    entry.reply = { text };
  }
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: usageOf(n) } });
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const config = { model_provider: 'fixture', model: 'fixture-model', check_for_update_on_startup: false,
  'analytics.enabled': false, 'feedback.enabled': false, 'model_providers.fixture.name': 'fixture',
  'model_providers.fixture.base_url': `${origin}/v1`, 'model_providers.fixture.wire_api': 'responses',
  'model_providers.fixture.requires_openai_auth': false, 'model_providers.fixture.supports_websockets': false,
  'model_providers.fixture.request_max_retries': 0, 'model_providers.fixture.stream_max_retries': 0,
  sqlite_home: join(HOME, 'index'), log_dir: join(HOME, 'logs') };
let processes = 0;

function walk(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
      ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
  } catch { return []; }
}
// The native history a host would fingerprint: the thread's rollout file, its size and digest, and the newest
// task_complete entry that marks the last completed turn. The rollout's last token_count totals ride along for A4.
function fingerprint(threadId) {
  const files = walk(join(CODEX_HOME, 'sessions')).filter((file) => file.endsWith(`-${threadId}.jsonl`));
  if (files.length !== 1) return { rollouts: files.length };
  const bytes = readFileSync(files[0]);
  let lines;
  try { lines = bytes.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line)); }
  catch (error) { return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parseError: String(error.message) }; }
  const lastLine = lines.at(-1);
  const completeAt = lines.findLastIndex((line) => line.type === 'event_msg' && line.payload?.type === 'task_complete');
  const tokenCounts = lines.filter((line) => line.type === 'event_msg' && line.payload?.type === 'token_count' && line.payload.info);
  return { path: relative(CODEX_HOME, files[0]), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    lines: lines.length, mtimeMs: statSync(files[0]).mtimeMs,
    lastLine: { type: lastLine.type, payloadType: lastLine.payload?.type ?? null },
    lastTaskComplete: completeAt < 0 ? null : { line: completeAt, turnId: lines[completeAt].payload?.turn_id ?? null },
    rolloutTotals: tokenCounts.length ? { total: tokenCounts.at(-1).payload.info.total_token_usage,
      last: tokenCounts.at(-1).payload.info.last_token_usage } : null };
}

/** One app-server owned by the probe, with Switchboard's transport over its stdio. */
function appServer(label, holdMs) {
  const own = { ...config, ...(freshIndex && { sqlite_home: join(HOME, `index-${++processes}`) }) };
  const child = spawn(CODEX, ['app-server', ...Object.entries(own).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
    { cwd: PROJECT, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME, CODEX_HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
  const proc = { label, pid: child.pid, startedAt: now(), sqliteHome: own.sqlite_home, notifications: [], terminals: [], serverRequests: [],
    rpc: [], stderrTail: '', exit: null };
  report.processes.push(proc);
  proc.exited = new Promise((resolve) => child.once('close', (code, signal) => { proc.exit = { code, signal, at: now() }; resolve(); }));
  const channel = {
    listen(sink) {
      const data = (chunk) => sink.data(chunk);
      const diagnostic = (chunk) => { proc.stderrTail = (proc.stderrTail + chunk).slice(-4096); sink.diagnostic(chunk); };
      const ended = () => sink.ended('process-exit');
      child.stdout.on('data', data);
      child.stderr.on('data', diagnostic);
      child.once('close', ended);
      return () => { child.stdout.off('data', data); child.stderr.off('data', diagnostic); child.off('close', ended); };
    },
    write: (frame) => new Promise((resolve, reject) => child.stdin.write(frame, (error) => (error ? reject(error) : resolve()))),
  };
  const onRequest = async (call, signal) => {
    const params = call.params ?? {};
    const record = { method: call.method, idType: typeof call.id, receivedAt: now(), threadId: params.threadId ?? null,
      turnId: params.turnId ?? null, callId: params.callId ?? null, namespace: params.namespace ?? null, tool: params.tool ?? null,
      arguments: params.arguments ?? null, notificationsDuringHold: [] };
    proc.serverRequests.push(record);
    if (call.method !== 'item/tool/call') return { kind: 'error', error: { code: -32601, message: 'probe answers only item/tool/call', data: null } };
    proc.holding = record;
    try { while (now() - record.receivedAt < holdMs) await delay(holdMs - (now() - record.receivedAt), undefined, { signal }); }
    catch { record.abortedAt = now(); record.abortReason = String(signal.reason); throw new Error('transport ended during hold'); }
    finally { proc.holding = undefined; }
    record.answeredAt = now();
    record.heldMs = record.answeredAt - record.receivedAt;
    record.answer = `host result for ${params.callId}`;
    return { kind: 'result', value: { contentItems: [{ type: 'inputText', text: record.answer }], success: true } };
  };
  const onObservation = (observation) => {
    if (observation.kind !== 'notification') { proc.notifications.push({ at: now(), kind: observation.kind }); return; }
    const { method, params = {} } = observation;
    const item = params.item;
    const entry = { at: now(), method, threadId: params.threadId ?? params.thread?.id ?? null, turnId: params.turnId ?? params.turn?.id ?? null };
    if (item) Object.assign(entry, { itemType: item.type, itemId: item.id, itemStatus: item.status ?? null,
      ...(item.type === 'dynamicToolCall' && { tool: item.tool, namespace: item.namespace ?? null, success: item.success ?? null,
        contentItems: item.contentItems ?? null, arguments: item.arguments ?? null }),
      ...(item.type === 'agentMessage' && { text: item.text }) });
    // Read synchronously in the observer, before the probe reacts, so this is the history as the terminal finds it.
    if (method === 'turn/completed') Object.assign(entry, { status: params.turn?.status, error: params.turn?.error ?? null,
      fingerprint: entry.threadId ? fingerprint(entry.threadId) : null });
    if (method === 'thread/tokenUsage/updated') entry.tokenUsage = params.tokenUsage;
    if (['error', 'warning', 'configWarning', 'deprecationNotice'].includes(method)) entry.params = params;
    if (method === 'turn/completed') proc.terminals.push(entry);
    if (proc.notifications.length < 400) proc.notifications.push(entry);
    if (proc.holding) proc.holding.notificationsDuringHold.push({ at: entry.at, method, itemType: entry.itemType ?? null });
  };
  proc.transport = openCodexTransport({ channel, bounds: TRANSPORT_BOUNDS, onRequest, onObservation });
  proc.transport.ended.then((close) => { proc.transportEnd = { at: now(), reason: close.reason, unsettled: close.unsettled }; });
  proc.call = async (method, params, ms = 30_000) => {
    const exchange = await proc.transport.request({ method, params }, AbortSignal.timeout(ms));
    const entry = { method, at: now() };
    if (exchange.kind !== 'reply') entry.failure = exchange;
    else if (exchange.envelope.reply.kind === 'error') entry.error = exchange.envelope.reply.error;
    else entry.ok = true;
    proc.rpc.push(entry);
    return exchange.kind === 'reply' ? exchange.envelope.reply : { kind: 'failure', failure: exchange };
  };
  proc.initialize = async () => {
    const reply = await proc.call('initialize', { clientInfo: { name: 'switchboard-host-tool-probe', version: '0' },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    await proc.transport.notify({ method: 'initialized' }, AbortSignal.timeout(5000));
    return reply;
  };
  // Runs one turn and returns its terminal notification, or null when none came within the bound.
  proc.turn = async (threadId, text, ms) => {
    const reply = await proc.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    const turnId = reply.kind === 'result' ? reply.value?.turn?.id : undefined;
    if (!turnId) return { turnStart: reply };
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const done = proc.terminals.find((entry) => entry.turnId === turnId);
      if (done) return { turnId, completed: done };
      if (proc.exit || proc.transportEnd) break;
      await delay(50);
    }
    return { turnId, completed: null };
  };
  // Host-attested exit: close the transport, end stdin and wait; escalate only if the process does not leave.
  proc.stop = async () => {
    await proc.transport.close();
    child.stdin.end();
    proc.stopMethod = 'stdin-eof';
    if (await Promise.race([proc.exited.then(() => true), delay(10_000).then(() => false)])) return;
    proc.stopMethod = 'SIGTERM';
    child.kill('SIGTERM');
    if (await Promise.race([proc.exited.then(() => true), delay(5000).then(() => false)])) return;
    proc.stopMethod = 'SIGKILL';
    child.kill('SIGKILL');
    await proc.exited;
  };
  return proc;
}

const usageNotes = (proc) => proc.notifications.filter((entry) => entry.method === 'thread/tokenUsage/updated')
  .map(({ at, turnId, tokenUsage }) => ({ at, turnId, total: tokenUsage?.total, last: tokenUsage?.last }));
const summary = (proc, turn) => ({
  label: proc.label,
  toolCalls: proc.serverRequests.map(({ method, tool, namespace, callId, heldMs, answer, abortedAt, abortReason, notificationsDuringHold }) =>
    ({ method, tool, namespace, callId, heldMs: heldMs ?? null, answer: answer ?? null, abortedAt: abortedAt ?? null,
      abortReason: abortReason ?? null, notificationsDuringHold })),
  dynamicToolItems: proc.notifications.filter((entry) => entry.itemType === 'dynamicToolCall'),
  agentMessages: proc.notifications.filter((entry) => entry.method === 'item/completed' && entry.itemType === 'agentMessage').map((entry) => entry.text),
  turn: turn ? { turnId: turn.turnId ?? null, status: turn.completed?.status ?? null, error: turn.completed?.error ?? null, turnStart: turn.turnStart ?? null } : null,
  usage: usageNotes(proc), errors: proc.notifications.filter((entry) => entry.params),
});

try {
  if (scenario.startsWith('hold-')) {
    const { holdMs, resumed = false } = SCENARIOS[scenario];
    report.holdMs = holdMs;
    let threadId = null;
    if (resumed) {
      // A first process starts the thread with the tool and answers one call at once, then exits.
      const first = appServer('p0-start', 0);
      await first.initialize();
      const started = await first.call('thread/start', { cwd: PROJECT, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [toolSpec(TOOL)] });
      threadId = started.kind === 'result' ? started.value.thread.id : null;
      report.firstSegment = threadId ? summary(first, await first.turn(threadId, `call:${TOOL} at once`, 60_000)) : started;
      await first.stop();
      report.firstSegment.stopMethod = first.stopMethod;
    }
    const proc = appServer(resumed ? 'p1-resume' : 'p1', holdMs);
    report.initialize = (await proc.initialize()).kind;
    const opened = resumed ? await proc.call('thread/resume', { threadId })
      : await proc.call('thread/start', { cwd: PROJECT, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [toolSpec(TOOL)] });
    threadId = opened.kind === 'result' ? opened.value.thread.id : null;
    report.threadOpen = opened.kind === 'result' ? { method: resumed ? 'thread/resume' : 'thread/start', threadId } : opened;
    const turn = threadId ? await proc.turn(threadId, `call:${TOOL} and hold`, holdMs + 60_000) : null;
    report.result = summary(proc, turn);
    report.transportEndBeforeStop = proc.transportEnd ?? null;
    report.transportOpenAtTurnEnd = proc.transportEnd === undefined;
    report.processAliveAtTurnEnd = proc.exit === null;
    await proc.stop();
    report.result.stopMethod = proc.stopMethod;
    report.result.transportEnd = proc.transportEnd ?? null;
  } else {
    // A2 to A4: start with the tool declared, then three plain resumes in fresh processes, then (plain variant only) one
    // resume that tries to declare a second tool. Fingerprints are taken when the turn completes, after the turn, after
    // exit, and in the next process before and after it opens the thread.
    const segments = [];
    let threadId;
    const plan = [
      { label: 'p1-start', method: 'thread/start', tool: TOOL },
      { label: 'p2-resume', method: 'thread/resume', tool: TOOL },
      { label: 'p3-resume', method: 'thread/resume', tool: TOOL },
      { label: 'p4-resume', method: 'thread/resume', tool: TOOL },
      ...(scenario === 'resume' ? [{ label: 'p5-resume-declaring', method: 'thread/resume', tool: 'host_probe_late', declare: true }] : []),
    ];
    for (const step of plan) {
      const proc = appServer(step.label, 0);
      const segment = { label: step.label, method: step.method };
      segments.push(segment);
      segment.initialize = (await proc.initialize()).kind;
      if (threadId) segment.fingerprintBeforeOpen = fingerprint(threadId);
      const params = step.method === 'thread/start'
        ? { cwd: PROJECT, approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [toolSpec(TOOL)] }
        : { threadId, ...(step.declare && { dynamicTools: [toolSpec(step.tool)] }) };
      const opened = await proc.call(step.method, params);
      segment.open = opened.kind === 'result' ? { ok: true, threadId: opened.value.thread.id } : opened;
      if (opened.kind === 'result') {
        threadId ??= opened.value.thread.id;
        if (step.method === 'thread/resume') segment.fingerprintAtOpen = fingerprint(threadId);
        const firstModelRequest = report.model.length;
        const turn = await proc.turn(threadId, `turn ${step.label}: call:${step.tool}`, 60_000);
        segment.modelRequests = report.model.slice(firstModelRequest).map((entry) => entry.n);
        segment.result = summary(proc, turn);
        segment.fingerprintAtTurnCompleted = turn.completed?.fingerprint ?? null;
        segment.fingerprintAtSegmentEnd = fingerprint(threadId);
      }
      await proc.stop();
      segment.stopMethod = proc.stopMethod;
      segment.exit = proc.exit;
      if (threadId) segment.fingerprintAfterExit = fingerprint(threadId);
    }
    report.threadId = threadId;
    report.segments = segments;
    report.syntheticUsagePerResponse = Object.fromEntries(report.model.filter((entry) => entry.n).map((entry) => [entry.n, usageOf(entry.n)]));
  }
} catch (error) {
  report.harnessError = String(error?.stack ?? error);
} finally {
  for (const proc of report.processes) {
    delete proc.transport; delete proc.exited; delete proc.call; delete proc.initialize; delete proc.turn; delete proc.stop;
  }
  server.close();
  server.closeAllConnections();
}
process.stdout.write(JSON.stringify(report), () => process.exit(0));
