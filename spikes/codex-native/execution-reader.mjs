import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { accountProfile, accountRouting } from './account-reads.mjs';
// The compiled product module, mounted read-only from the host's fresh build.
import { codexNotificationEvidence, createCodexWriters, openCodexExecution } from '../dist/adapters/codex/execution.js';

// Container side of the x9av native proof: one scenario per container. The harness plays the host: it spawns and kills
// app-servers, lends their stdio as the channel and attests process exit. It records facts, raw native observations and
// named failed checks; the host (execution-proof.mjs) is the only place a run passes. Never retries.
const SCENARIOS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9'];
const [scenario] = process.argv.slice(2);
if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
const home = '/root/.codex';
const report = { scenario, failures: [], inference: {}, serverRequests: [], raw: {} };
const need = (condition, label) => { if (!condition) report.failures.push(label); };
mkdirSync('/tmp/project', { recursive: true });

// Synthetic Responses service. The last `marker:<name>` in the request body selects the behaviour, so sessions are
// independent: `answer`, `hold-<name>` (parked until released) and `disconnect` (one delta, then the stream ends).
const held = new Map();
const usage = { input_tokens: 11, input_tokens_details: { cached_tokens: 5 }, output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 18 };
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
  const id = `resp_${++responses}`;
  const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit({ type: 'response.created', response: { id, status: 'in_progress' } });
  const item = { type: 'message', id: `msg_${responses}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }] };
  if (marker.startsWith('hold-')) {
    const gate = Promise.withResolvers();
    held.set(marker, gate);
    request.once('close', () => gate.resolve('gone'));
    if ((await gate.promise) === 'gone') return;
  }
  emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture answer' });
  if (marker === 'disconnect') { response.end(); return; }
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage } });
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

const transportBounds = { maxFrameBytes: 1048576, maxChunkBytes: 2097151, maxDiagnosticBytes: 65536, maxPending: 8, maxHandlers: 2,
  maxWrites: 8, observationCapacity: 4096, handlerTimeoutMs: 5000, observationTimeoutMs: 5000, writeTimeoutMs: 20000 };
const bounds = { maxSessions: 4, maxObservers: 2, eventCapacity: 4096, maxEarlyNotifications: 256, cleanupTimeoutMs: 15000,
  acknowledgementTimeoutMs: 10000 };
const access = () => ({ bounds: { maxResults: 100, maxExamined: 1000, maxDurationMs: 20000 }, signal: AbortSignal.timeout(20000) });
const threadParams = { cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'read-only' };
const writers = createCodexWriters(16);
const servers = [];
const executions = [];
const within = (promise, ms, label) => Promise.race([promise, delay(ms).then(() => { throw new Error(`Timed out: ${label}`); })]);
async function until(predicate, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}

/** One app-server owned by this harness (the host). Its channel can gate a named outgoing method or buffer stdout. */
function appServer({ bufferStdout = false, eofAfter } = {}) {
  const child = spawn('/opt/codex', ['app-server', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
    { cwd: '/tmp/project', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  let closed = false;
  const s = { frames: [], detached: 0, buffering: bufferStdout, buffered: [], gates: new Map(), stderr: '' };
  s.exited = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  s.gate = (method) => { const gate = Promise.withResolvers(); s.gates.set(method, gate); return gate; };
  s.channel = {
    listen(sink) {
      s.sink = sink;
      const data = (chunk) => { if (s.buffering) s.buffered.push(chunk); else sink.data(chunk); };
      const diagnostic = (chunk) => { s.stderr = (s.stderr + chunk).slice(-2048); sink.diagnostic(chunk); };
      const ended = () => sink.ended('process-exit');
      child.stdout.on('data', data);
      child.stderr.on('data', diagnostic);
      child.once('close', ended);
      return () => { s.detached++; child.stdout.off('data', data); child.stderr.off('data', diagnostic); child.off('close', ended); };
    },
    async write(frame) {
      let method = 'reply';
      try { method = JSON.parse(Buffer.from(frame).toString()).method ?? 'reply'; } catch {}
      s.frames.push(method);
      await s.gates.get(method)?.promise;
      await new Promise((resolve, reject) => child.stdin.write(frame, (error) => (error ? reject(error) : resolve())));
      // Acknowledgement loss: the host's channel ends right after the frame is written, before any reply.
      if (method === eofAfter) setImmediate(() => s.sink.ended('eof'));
    },
  };
  s.count = (method) => s.frames.filter((frame) => frame === method).length;
  s.release = () => { s.buffering = false; for (const chunk of s.buffered.splice(0)) s.sink?.data(chunk); };
  s.kill = async () => { if (!closed) child.kill('SIGKILL'); await s.exited; };
  s.stop = async () => {
    if (!closed) child.kill('SIGTERM');
    await Promise.race([s.exited, delay(5000)]);
    if (!closed) { child.kill('SIGKILL'); await s.exited; }
  };
  servers.push(s);
  return s;
}
const options = (s, signal = AbortSignal.timeout(10000)) => ({ channel: s.channel, transport: transportBounds, bounds, home, writers,
  initialize: { clientInfo: { name: 'switchboard_execution_proof', version: '0' } }, signal, processExit: s.exited,
  onServerRequest: (request) => {
    report.serverRequests.push(request.method);
    return { kind: 'error', error: { code: -32601, message: 'No server requests in this proof', data: null } };
  } });
async function execute(s) {
  const opened = await openCodexExecution(options(s));
  if (opened.kind !== 'ok') throw new Error(`open ${opened.error.code}: ${s.stderr}`);
  const execution = opened.value;
  executions.push(execution);
  const login = await execution.scope.request({ method: 'account/login/start', params: { type: 'apiKey', apiKey: 'synthetic-execution-key' } },
    AbortSignal.timeout(10000));
  need(login.kind === 'reply' && login.envelope.reply.kind === 'result', 'API key login');
  return execution;
}
const outcome = (value) => (value.kind === 'ok' ? value.value.kind ?? 'ok' : `error:${value.error.code}`);
function watch(session) {
  const seen = { kinds: [], methods: [], usage: [], usageRaw: [], errors: [] };
  session.events.subscribe((event) => {
    seen.kinds.push(event.kind);
    if (event.kind === 'usage') seen.usage.push({ total: event.total, last: event.last, window: event.modelContextWindow, evidence: event.evidence });
    if (event.kind !== 'native') return;
    seen.methods.push(event.method);
    if (event.method === 'thread/tokenUsage/updated') seen.usageRaw.push(event.params);
    if (event.method === 'error') seen.errors.push({ willRetry: event.params?.willRetry ?? null, message: typeof event.params?.error?.message });
  });
  return seen;
}
function turnOn(session, marker, extra = {}) {
  const started = session.turn({ hostOperationId: `op-${marker}-${Math.random()}`, signal: AbortSignal.timeout(20000), recordIntent: () => {},
    input: [{ type: 'text', text: `Fixture only. marker:${marker}`, text_elements: [] }], ...extra });
  if (started.kind !== 'ok') throw new Error(`turn ${started.error.code}`);
  return started.value;
}
async function create(execution) {
  const created = await execution.create({ ...access(), params: threadParams });
  if (created.kind !== 'ok') throw new Error(`create ${created.error.code}`);
  return created.value;
}
const terminal = async (turn, label, ms = 15000) => {
  const completion = await within(turn.completion, ms, label);
  return completion.kind === 'terminal' ? completion.terminal.status : completion.kind;
};
const sum = (counts) => Object.values(counts).reduce((total, value) => total + value, 0);
/** A durable thread: created, then one answered turn (start-only IDs are not durable, probe.mjs). */
async function seed(execution, marker = 'seed') {
  const session = await create(execution);
  need((await terminal(turnOn(session, marker), 'seed turn')) === 'completed', 'seed turn completed');
  return session;
}
async function resume(execution, session) {
  return execution.resume({ ...access(), binding: session.reference.binding, reference: session.reference, params: threadParams });
}

try {
  report.evidenceLabels = codexNotificationEvidence;
  if (scenario === 'X1') {
    const execution = await execute(appServer());
    const session = await create(execution);
    const seen = watch(session);
    const turn = turnOn(session, 'answer');
    report.snapshot = (await within(turn.run(), 15000, 'run')).observation.kind;
    report.completion = await terminal(turn, 'X1 terminal');
    await delay(200);
    report.eventKinds = [...new Set(seen.kinds)].sort();
    report.nativeMethods = [...new Set(seen.methods)].sort();
    report.turnStartedSeen = seen.methods.includes('turn/started');
    report.usageSeen = seen.usage.length > 0;
    report.usage = seen.usage.at(-1) ?? null;
    report.raw.usage = seen.usageRaw;
    report.raw.native = seen.methods.slice(0, 64);
    report.threadPathPresent = typeof session.native?.thread?.path === 'string';
  } else if (scenario === 'X2') {
    const first = appServer();
    const session = await seed(await execute(first));
    const path = session.native?.thread?.path;
    await executions.at(-1).close();
    await first.stop();
    const prefix = readFileSync(path);
    const before = sum(report.inference);
    const next = await resume(await execute(appServer()), session);
    report.resume = outcome(next);
    report.sameId = next.value?.session?.threadId === session.threadId;
    report.resumeInference = sum(report.inference) - before;
    report.resumeTurns = next.value?.session?.native?.thread?.turns?.length ?? null;
    report.completion = await terminal(turnOn(next.value.session, 'after-resume'), 'X2 turn');
    report.prefixPreserved = readFileSync(path).subarray(0, prefix.length).equals(prefix);
  } else if (scenario === 'X3') {
    const execution = await execute(appServer());
    const [a, b] = [await create(execution), await create(execution)];
    const [ta, tb] = [turnOn(a, 'hold-a'), turnOn(b, 'hold-b')];
    await until(() => held.has('hold-a') && held.has('hold-b'), 'both held');
    let aDone = false;
    void ta.completion.then(() => { aDone = true; });
    held.get('hold-b').resolve('go');
    report.b = await terminal(tb, 'b');
    report.aPendingAfterB = !aDone;
    held.get('hold-a').resolve('go');
    report.a = await terminal(ta, 'a');
    report.held = writers.held();
  } else if (scenario === 'X4') {
    const first = appServer();
    const a = await execute(first);
    const held1 = await seed(a);
    const turn = turnOn(held1, 'hold-x');
    report.accepted = (await within(turn.run(), 15000, 'accepted')).observation.kind;
    await until(() => held.has('hold-x'), 'held inference');
    const unsubscribe = first.gate('thread/unsubscribe');
    const closing = held1.close();
    await until(() => first.count('thread/unsubscribe') === 1, 'cleanup reached unsubscribe');
    report.terminal = await terminal(turn, 'interrupted');
    const second = appServer();
    const b = await execute(second);
    const framesBefore = second.frames.length;
    report.busyDuringHold = outcome(await resume(b, held1));
    report.requestsDuringHold = second.frames.length - framesBefore;
    const independent = await create(b);
    report.independent = await terminal(turnOn(independent, 'independent'), 'independent');
    report.heldDuringHold = writers.held();
    unsubscribe.resolve();
    const closed = await within(closing, 15000, 'close');
    report.close = closed;
    const admitted = await resume(b, held1);
    report.admittedAfter = outcome(admitted);
    report.after = admitted.kind === 'ok' && admitted.value.kind === 'resumed'
      ? await terminal(turnOn(admitted.value.session, 'after'), 'after') : null;
    report.holdInference = report.inference['hold-x'] ?? 0;
  } else if (scenario === 'X5') {
    const execution = await execute(appServer());
    const session = await seed(execution);
    report.close = await session.close();
    const reopened = await resume(execution, session);
    report.reopen = outcome(reopened);
    report.raw.reopen = reopened.kind === 'ok' ? reopened.value.kind : reopened.error;
    if (reopened.kind === 'ok' && reopened.value.kind === 'resumed') {
      report.afterReopen = await terminal(turnOn(reopened.value.session, 'reopen'), 'reopen');
    }
  } else if (scenario === 'X6') {
    const seeder = appServer();
    const session = await seed(await execute(seeder));
    await executions.at(-1).close();
    await seeder.stop();
    const lossy = appServer({ eofAfter: 'turn/start' });
    const resumed = await resume(await execute(lossy), session);
    need(outcome(resumed) === 'resumed', 'X6 resume before loss');
    const turn = turnOn(resumed.value.session, 'hold-lost');
    report.snapshot = (await within(turn.run(), 15000, 'X6 run')).observation.kind;
    report.completion = await within(turn.completion, 15000, 'X6 completion');
    report.turnStartWrites = lossy.count('turn/start');
    report.retainedBeforeExit = writers.held();
    await delay(500);
    report.inferenceBeforeExit = report.inference['hold-lost'] ?? 0;
    await lossy.kill();
    await delay(100);
    report.releasedAfterExit = writers.held() === 0;
    const fresh = await resume(await execute(appServer()), session);
    report.resume = outcome(fresh);
    await delay(500);
    report.inferenceAfterResume = report.inference['hold-lost'] ?? 0;
  } else if (scenario === 'X7') {
    const s = appServer();
    const session = await create(await execute(s));
    const seen = watch(session);
    const turn = turnOn(session, 'invalid', { input: [{ type: 'fixture-invalid-input' }] });
    const snapshot = await within(turn.run(), 15000, 'X7 run');
    report.snapshot = snapshot.observation.kind;
    report.completion = (await within(turn.completion, 15000, 'X7 completion')).kind;
    report.raw.error = snapshot.observation.result?.error ? { code: snapshot.observation.result.error.code } : null;
    await delay(500);
    report.turnEventsWithin500ms = seen.kinds.length;
    report.turnStartWrites = s.count('turn/start');
  } else if (scenario === 'X8') {
    const session = await create(await execute(appServer()));
    const seen = watch(session);
    report.terminal = await terminal(turnOn(session, 'disconnect'), 'X8 terminal');
    await delay(200);
    report.deltaSeen = seen.kinds.includes('text-delta');
    report.errorNotification = { present: seen.errors.length > 0, willRetry: seen.errors.map((error) => error.willRetry) };
    report.raw.errors = seen.errors;
    report.disconnectInference = report.inference.disconnect ?? 0;
  } else if (scenario === 'X9') {
    // The host channel buffers stdout, so `initialize` is written but its reply cannot arrive before the abort.
    const s = appServer({ bufferStdout: true });
    const controller = new AbortController();
    const opening = openCodexExecution(options(s, controller.signal));
    await until(() => s.count('initialize') === 1, 'initialize written');
    controller.abort();
    report.aborted = outcome(await within(opening, 10000, 'aborted open'));
    report.detached = s.detached;
    report.heldAfterAbort = writers.held();
    s.release();
    await s.stop();
    const fresh = await execute(appServer());
    report.freshCreate = outcome(await fresh.create({ ...access(), params: threadParams }));
  }
} catch (error) {
  report.failures.push(`exception: ${error.message}`);
} finally {
  for (const gate of held.values()) gate.resolve('go');
  const reports = await Promise.allSettled(executions.map((execution) => within(execution.close(), 20000, 'execution close')));
  report.closeReasons = reports.map((settled) => (settled.status === 'fulfilled' ? settled.value.transport.reason : 'timeout'));
  for (const s of servers) await s.stop();
  report.heldAtEnd = writers.held();
  for (const owned of [server, routing]) {
    owned.closeAllConnections();
    await new Promise((resolve) => owned.close(resolve));
  }
  need(report.serverRequests.length === 0, 'no server requests');
}
console.log(JSON.stringify(report));
