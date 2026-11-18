import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const src = new URL('../../../src/', import.meta.url).href;
const target = new URL('adapters/codex/execution.ts', src).href;
// Broken controls are source mutations of the real module (precedent: tests/spikes/codex-bindings.test.mjs).
// early-release frees the writer at cleanup start; cleanup-release frees it once cleanup ends, as a turn-conclusion release did.
const mutations = new Map([['early-release', ['session.abort.abort();\n    const deadline', 'session.abort.abort();\n    release(session.lease);\n    const deadline']],
  ['cleanup-release', ['deadline));\n    return Object.freeze({ interrupt', 'deadline));\n    release(session.lease);\n    return Object.freeze({ interrupt']]]);
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (!url.startsWith(src)) return next(url, context);
  const [path, query] = url.split('?mutant=');
  if (!path.endsWith('.ts')) return next(url, context);
  let source = readFileSync(new URL(path), 'utf8');
  if (query) {
    const [from, to] = mutations.get(query);
    const changed = source.replace(from, to);
    assert.notEqual(changed, source, `${query}-mutation-entered`);
    source = changed;
  }
  return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true };
} });
const real = await import(target);
const mutant = await import(`${target}?mutant=early-release`);
const cleanupMutant = await import(`${target}?mutant=cleanup-release`);
hook.deregister();

const home = '/fixture/codex-home';
const transport = { maxFrameBytes: 65536, maxChunkBytes: 131072, maxDiagnosticBytes: 64, maxPending: 8, maxHandlers: 2,
  maxWrites: 8, observationCapacity: 64, handlerTimeoutMs: 60000, observationTimeoutMs: 60000, writeTimeoutMs: 60000 };
const bounds = { maxSessions: 4, maxObservers: 2, eventCapacity: 32, maxEarlyNotifications: 8, cleanupTimeoutMs: 60000,
  acknowledgementTimeoutMs: 60000 };
const access = { bounds: { maxResults: 10, maxExamined: 10, maxDurationMs: 5000 }, signal: new AbortController().signal };
const binding = { engine: 'codex', nativeVersion: '0.169.0', account: 'apiKey', authorizedScope: home, nativeFormat: 'codex-thread/paginated' };
const reference = (opaque, overrides = {}) => ({ kind: 'session', formatVersion: 1, binding: { ...binding, ...overrides }, opaque });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
const input = [{ type: 'text', text: 'Fixture only.', text_elements: [] }];
const usage = (n) => ({ totalTokens: 3 * n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2 * n,
  reasoningOutputTokens: 0 });

/** Shared synthetic native history: every app-server generation sees the same threads, as on one $CODEX_HOME. */
function world(...ids) {
  const w = { threads: new Map(), overlaps: [] };
  for (const id of ids) w.threads.set(id, { writer: null, holder: null });
  return w;
}
/**
 * Inert, permissive fake app-server over a borrowed channel. It answers only the methods this module and pg51 send and
 * records every request. As natively (X4, X5), a thread stays loaded by its app-server until that process exits, even
 * after `thread/unsubscribe`; an overlap is recorded whenever a second writer is admitted while another live app-server
 * holds the thread or a turn is in progress.
 */
function appServer(t, w, script = {}) {
  const f = { sent: [], loaded: new Set(), holds: new Map(), detached: 0 };
  const send = (value) => { if (f.sink && !f.gone) f.sink.data(Buffer.from(`${JSON.stringify(value)}\n`)); };
  f.notify = (method, params) => send({ method, params });
  f.complete = (threadId, turnId, status = 'completed') => {
    const thread = w.threads.get(threadId);
    if (thread.writer?.turnId === turnId) thread.writer = null;
    f.notify('turn/completed', { threadId, turn: { id: turnId, status, items: [], error: status === 'failed' ? { message: 'x' } : null } });
  };
  f.exit = () => {
    for (const thread of w.threads.values()) {
      if (thread.writer?.server === f) thread.writer = null;
      if (thread.holder === f) thread.holder = null;
    }
    f.sink.ended('process-exit');
  };
  f.hold = (method) => { const held = gate(); f.holds.set(method, held); return held; };
  const answer = {
    'initialize': () => ({ codexHome: home, userAgent: 'fake/0.169.0' }),
    'config/read': () => ({ config: { sqlite_home: '/private/index', log_dir: '/private/logs', ...script.config } }),
    'account/read': () => script.account ?? ({ account: { type: 'apiKey' } }),
    'thread/read': ({ threadId }) => {
      const thread = w.threads.get(threadId);
      if (!thread) return { error: { code: -32600, message: `thread not loaded: ${threadId}` } };
      return { thread: { id: threadId, historyMode: 'paginated', status: { type: f.loaded.has(threadId) ? 'idle' : 'notLoaded' },
        modelProvider: 'litellm' } };
    },
    'thread/start': () => {
      const id = randomUUID();
      w.threads.set(id, { writer: null, holder: f });
      f.loaded.add(id);
      return { thread: { id, historyMode: 'paginated', ephemeral: false, status: { type: 'idle' }, modelProvider: script.provider ?? 'litellm' },
        model: 'fixture-model' };
    },
    'thread/resume': ({ threadId }) => {
      const thread = w.threads.get(threadId);
      if (thread.writer || (thread.holder && thread.holder !== f)) w.overlaps.push(`resume ${threadId}`);
      thread.holder = f;
      f.loaded.add(threadId);
      return { thread: { id: script.resumeAs ?? threadId, turns: [{ id: 'saved' }], modelProvider: script.provider ?? 'litellm' } };
    },
    'turn/start': ({ threadId }) => {
      const thread = w.threads.get(threadId);
      if (thread.writer) w.overlaps.push(`turn ${threadId}`);
      const turnId = randomUUID();
      thread.writer = { server: f, turnId };
      queueMicrotask(() => (script.turn ?? run)(f, threadId, turnId));
      return { turn: { id: turnId, status: 'inProgress', items: [], error: null } };
    },
    'turn/interrupt': ({ threadId, turnId }) => {
      void (f.holds.get('interrupted')?.promise ?? Promise.resolve()).then(() => f.complete(threadId, turnId, 'interrupted'));
      return {};
    },
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  };
  const channel = {
    listen(sink) { f.sink = sink; return () => { f.detached++; }; },
    write(bytes) {
      const message = JSON.parse(Buffer.from(bytes).toString());
      if (message.method === undefined || message.id === undefined) return Promise.resolve();
      f.sent.push(message.method);
      f.last = message;
      const held = f.holds.get(message.method);
      void (held?.promise ?? Promise.resolve()).then((mode) => {
        if (mode === 'drop') return;
        const value = answer[message.method]?.(message.params) ?? { error: { code: -32601, message: 'unsupported' } };
        send(value.error ? { id: message.id, error: value.error } : { id: message.id, result: value });
      });
      return Promise.resolve();
    },
  };
  f.channel = channel;
  // Registered before any execution's close hook: a failed schedule never leaves cleanup held.
  t.after(() => { for (const held of f.holds.values()) held.open(); });
  return f;
}
/** Default native turn: started, two deltas, usage, completed. */
function run(f, threadId, turnId) {
  f.notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  f.notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm1', delta: 'fixture ' });
  f.notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm1', delta: 'answer' });
  f.notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: usage(2), last: usage(1), modelContextWindow: 1000 } });
  f.complete(threadId, turnId);
}
const hold = () => {};
async function open(t, module, f, writers, extra = {}) {
  const opened = await module.openCodexExecution({ channel: f.channel, transport, bounds, home, writers,
    initialize: { clientInfo: { name: 'x9av-test', title: null, version: '0' }, capabilities: null },
    onServerRequest: () => ({ kind: 'error', error: { code: -32601, message: 'test host', data: null } }),
    signal: new AbortController().signal, processExit: new Promise(() => {}), ...extra });
  assert.equal(opened.kind, 'ok', JSON.stringify(opened));
  t.after(() => opened.value.close());
  return opened.value;
}
function collect(observer) {
  const events = [];
  observer.subscribe((event) => { events.push(event); });
  return events;
}
async function turnOn(session, id = 'op') {
  const started = session.turn({ hostOperationId: id, input, signal: new AbortController().signal, recordIntent: () => {} });
  assert.equal(started.kind, 'ok', JSON.stringify(started));
  return started.value;
}
async function resumed(execution, opaque) {
  const result = await execution.resume({ ...access, binding, reference: reference(opaque) });
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  assert.equal(result.value.kind, 'resumed', JSON.stringify(result.value));
  return result.value.session;
}

test('create starts a bound thread, runs one turn and streams accepted, deltas, usage and the native terminal', async (t) => {
  const w = world();
  const f = appServer(t, w);
  const execution = await open(t, real, f, real.createCodexWriters(4));
  const created = await execution.create(access);
  assert.equal(created.kind, 'ok');
  const session = created.value;
  assert.deepEqual(session.reference, reference(session.threadId));
  assert.equal(session.origin, 'created');
  const events = collect(session.events);
  const turn = await turnOn(session);
  const snapshot = await turn.run();
  const completion = await turn.completion;
  await settle();
  assert.equal(completion.kind, 'terminal');
  assert.equal(completion.terminal.status, 'completed');
  assert.ok(['accepted', 'conclusive'].includes(snapshot.observation.kind));
  assert.deepEqual(snapshot.observation.evidence.nativeOperation, { namespace: 'codex-turn', id: completion.terminal.turnId });
  assert.deepEqual(events.map((event) => event.kind), ['turn-accepted', 'native', 'text-delta', 'text-delta', 'usage', 'turn-completed']);
  const metered = events.find((event) => event.kind === 'usage');
  assert.deepEqual([metered.total, metered.last, metered.modelContextWindow, metered.evidence], [usage(2), usage(1), 1000, 'qualified']);
  assert.deepEqual(f.sent, ['initialize', 'config/read', 'account/read', 'thread/start', 'turn/start']);
});

test('resume reserves before preparation, sends only the exact thread id and rejects a different returned thread', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const writers = real.createCodexWriters(4);
  const f = appServer(t, w, { resumeAs: randomUUID() });
  const execution = await open(t, real, f, writers);
  const mismatch = await execution.resume({ ...access, binding, reference: reference(id), params: { cwd: '/tmp/project' } });
  assert.deepEqual(mismatch, { kind: 'error', error: { code: 'identity-mismatch' } });
  assert.equal(writers.held(), 1, 'the native thread may be loaded, so mismatch retains the reservation');
  f.exit();
  await settle();
  assert.equal(writers.held(), 0, 'process exit releases it');
  const g = appServer(t, w);
  const replacement = await open(t, real, g, writers);
  const session = await resumed(replacement, id);
  assert.deepEqual(g.sent.slice(-4), ['config/read', 'account/read', 'thread/read', 'thread/resume']);
  assert.equal(writers.held(), 1);
  const forbidden = await replacement.resume({ ...access, binding, reference: reference(id), params: { path: '/x' } });
  assert.deepEqual(forbidden, { kind: 'error', error: { code: 'invalid-input' } });
  await session.close();
});

const route = Object.freeze({ kind: 'litellm-proxy', providerId: 'litellm', endpoint: 'http://127.0.0.1:4000/v1',
  credentialPurpose: 'litellm-proxy', scope: { engine: 'codex', account: 'host-account-a' } });
const routedProvider = { base_url: route.endpoint, wire_api: 'responses', auth: { command: '/usr/bin/node' }, requires_openai_auth: false,
  env_key: null, experimental_bearer_token: null };
const routedServer = (script = {}) => ({ config: { model_provider: 'litellm', model_providers: { litellm: routedProvider } },
  account: { account: null, userId: null, requiresOpenaiAuth: false }, ...script });

test('a routed execution refuses provider and config overrides unsent and any thread native puts on another provider', async (t) => {
  const principal = 'litellm-proxy:sha256:e4cdf2841b0dd4b832471ebc154497192a380f641664cfa1ac614817a2a78b54';
  const id = randomUUID();
  const w = world(id);
  const writers = real.createCodexWriters(4);
  const f = appServer(t, w, routedServer());
  const execution = await open(t, real, f, writers, { route });
  const routedRef = { ...access, binding: { ...binding, account: principal }, reference: reference(id, { account: principal }) };
  for (const params of [{ modelProvider: 'openai' }, { config: { model_provider: 'other' } },
    { config: { 'model_providers.litellm.base_url': 'http://127.0.0.1:4000/evil/v1' } }, { modelProvider: null }]) {
    for (const result of [await execution.create({ ...access, params }), await execution.resume({ ...routedRef, params })]) {
      assert.equal(result.error?.code, 'invalid-input', JSON.stringify(params));
      assert.match(result.error.message, /(modelProvider|config) is refused under a proxy route/u);
    }
  }
  assert.deepEqual(f.sent, ['initialize'], 'nothing is sent for a refused override');
  assert.equal(writers.held(), 0);
  // Direct mode still passes `config` through unchanged.
  const direct = await open(t, real, appServer(t, w), writers);
  assert.equal((await direct.create({ ...access, params: { config: { model: 'x' } } })).kind, 'ok');
  // A reply that puts the thread on another provider never becomes a session; resume keeps the lease to exit as on a
  // mismatched thread id, since the thread may be loaded.
  const g = appServer(t, w, routedServer({ provider: 'openai' }));
  const off = await open(t, real, g, writers, { route });
  assert.deepEqual(await off.create(access), { kind: 'error', error: { code: 'native-failure' } });
  const held = writers.held();
  assert.deepEqual(await off.resume(routedRef), { kind: 'error', error: { code: 'native-failure' } });
  assert.equal(writers.held(), held + 1);
  g.exit();
  await settle();
  assert.equal(writers.held(), held, 'process exit releases it');
});

test('a routed execution binds create and resume to the route principal, turns, and refuses direct references', async (t) => {
  const principal = 'litellm-proxy:sha256:e4cdf2841b0dd4b832471ebc154497192a380f641664cfa1ac614817a2a78b54';
  const routed = { config: { model_provider: 'litellm', model_providers: { litellm: routedProvider } },
    account: { account: null, userId: null, requiresOpenaiAuth: false } };
  const w = world();
  const writers = real.createCodexWriters(4);
  const f = appServer(t, w, routed);
  const hostRoute = structuredClone(route);
  const execution = await open(t, real, f, writers, { route: hostRoute });
  // The route is copied once at open: a later host mutation cannot change the principal.
  hostRoute.providerId = 'other';
  hostRoute.scope.account = 'host-account-b';
  assert.equal(execution.scope.route.endpoint, route.endpoint);
  const created = await execution.create(access);
  assert.equal(created.kind, 'ok', JSON.stringify(created));
  assert.deepEqual(created.value.reference.binding, { ...binding, account: principal });
  assert.equal((await (await turnOn(created.value)).completion).kind, 'terminal');
  const { threadId } = created.value;
  f.exit();
  await settle();
  const g = appServer(t, w, routed);
  const again = await open(t, real, g, writers, { route });
  const routedBinding = { ...binding, account: principal };
  const result = await again.resume({ ...access, binding: routedBinding, reference: reference(threadId, { account: principal }) });
  assert.equal(result.value?.kind, 'resumed', JSON.stringify(result));
  assert.equal((await (await turnOn(result.value.session)).completion).kind, 'terminal');
  assert.deepEqual(g.sent.slice(1), ['config/read', 'account/read', 'thread/read', 'thread/resume', 'turn/start']);
  // A direct reference under the route, and the routed reference on a direct app-server, are binding mismatches.
  const id = randomUUID();
  w.threads.set(id, { writer: null, holder: null });
  assert.deepEqual(await again.resume({ ...access, binding, reference: reference(id) }), { kind: 'error', error: { code: 'binding-mismatch' } });
  const direct = await open(t, real, appServer(t, w), writers);
  assert.deepEqual(await direct.resume({ ...access, binding: routedBinding, reference: reference(id, { account: principal }) }),
    { kind: 'error', error: { code: 'binding-mismatch' } });
  // A route that the app-server does not report, or an invalid route, never binds.
  const unrouted = await open(t, real, appServer(t, w, { account: routed.account }), writers, { route });
  assert.deepEqual(await unrouted.create(access), { kind: 'error', error: { code: 'inaccessible' } });
  const bad = await real.openCodexExecution({ channel: appServer(t, w).channel, transport, bounds, home, writers, initialize: {},
    onServerRequest: () => ({}), signal: new AbortController().signal, processExit: new Promise(() => {}),
    route: { ...route, endpoint: 'http://127.0.0.1:4000' } });
  assert.deepEqual(bad, { kind: 'error', error: { code: 'invalid-input' } });
  assert.deepEqual(w.overlaps, []);
});

test('a second open of the same reference is busy before any native request while independent sessions progress', async (t) => {
  const [first, second] = [randomUUID(), randomUUID()];
  const w = world(first, second);
  const writers = real.createCodexWriters(4);
  const f = appServer(t, w);
  const g = appServer(t, w);
  const a = await open(t, real, f, writers);
  const b = await open(t, real, g, writers);
  await resumed(a, first);
  const before = g.sent.length;
  assert.deepEqual(await b.resume({ ...access, binding, reference: reference(first) }), { kind: 'ok', value: { kind: 'busy' } });
  assert.equal(g.sent.length, before, 'reservation refuses before preparation');
  // Same native id under a different binding is a different key; pg51 preparation then refuses it.
  const other = await b.resume({ ...access, binding: { ...binding, account: 'chatgpt:other' },
    reference: reference(first, { account: 'chatgpt:other' }) });
  assert.deepEqual(other, { kind: 'error', error: { code: 'binding-mismatch' } });
  const independent = await resumed(b, second);
  const turn = await turnOn(independent);
  assert.equal((await turn.completion).kind, 'terminal');
  assert.deepEqual(w.overlaps, []);
});

test('turns on one session are serialized and a busy turn sends nothing', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const f = appServer(t, w, { turn: hold });
  const execution = await open(t, real, f, real.createCodexWriters(4));
  const session = await resumed(execution, id);
  const first = await turnOn(session, 'one');
  await first.run();
  assert.deepEqual(session.turn({ hostOperationId: 'two', input, signal: access.signal, recordIntent: () => {} }),
    { kind: 'error', error: { code: 'busy' } });
  assert.equal(f.sent.filter((method) => method === 'turn/start').length, 1);
  f.complete(id, w.threads.get(id).writer.turnId);
  assert.equal((await first.completion).kind, 'terminal');
  const second = await turnOn(session, 'two');
  await second.run();
  f.complete(id, w.threads.get(id).writer.turnId);
  assert.equal((await second.completion).kind, 'terminal');
  assert.deepEqual(w.overlaps, []);
});

test('a terminal and deltas observed before the turn/start reply are attributed by turn id, not order', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const f = appServer(t, w);
  const execution = await open(t, real, f, real.createCodexWriters(4));
  const session = await resumed(execution, id);
  const events = collect(session.events);
  f.hold('turn/start').open('drop');
  const turn = await turnOn(session);
  while (f.last.method !== 'turn/start') await settle();
  const turnId = randomUUID();
  f.notify('item/agentMessage/delta', { threadId: id, turnId: randomUUID(), itemId: 'm0', delta: 'stale' });
  f.notify('item/agentMessage/delta', { threadId: id, turnId, itemId: 'm1', delta: 'early' });
  f.notify('turn/completed', { threadId: id, turn: { id: turnId, status: 'completed', error: null } });
  await settle();
  assert.deepEqual(events, [], 'nothing is attributed before the reply names the turn');
  f.sink.data(Buffer.from(`${JSON.stringify({ id: f.last.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`));
  const snapshot = await turn.run();
  await settle();
  assert.equal(snapshot.observation.kind, 'conclusive');
  assert.equal(snapshot.observation.result.status, 'completed');
  assert.deepEqual(events.map((event) => event.kind), ['turn-accepted', 'text-delta', 'turn-completed']);
  assert.equal(events[1].delta, 'early', 'a stale turn never reaches this session');
  f.complete(id, turnId);
  await settle();
  assert.deepEqual(events.slice(3).map((event) => [event.kind, event.method]), [['native', 'turn/completed']], 'a settled turn concludes once');
});

test('ownership release holds the writer through cleanup and after close until process exit while an independent session progresses', async (t) => {
  await ownershipRelease(t, real);
});

test('the broken early-release controls enter cleanup and fail the overlap invariant', async (t) => {
  for (const module of [mutant, cleanupMutant]) {
    let entered = false;
    await assert.rejects(ownershipRelease(t, module, () => { entered = true; }), { message: /same-session-writer-overlap/ });
    assert.ok(entered, 'broken control entered cleanup before the failed assertion');
  }
});

async function ownershipRelease(t, module, cleanupEntered = () => {}) {
  const [first, second] = [randomUUID(), randomUUID()];
  const w = world(first, second);
  const writers = module.createCodexWriters(4);
  const f = appServer(t, w, { turn: (server, threadId, turnId) => { if (threadId === second) run(server, threadId, turnId); } });
  const g = appServer(t, w);
  const a = await open(t, module, f, writers);
  const b = await open(t, module, g, writers);
  const held = await resumed(a, first);
  const independent = await resumed(a, second);
  const active = await turnOn(held, 'held');
  assert.equal((await active.run()).observation.kind, 'accepted');
  const completion = f.hold('interrupted');
  const closing = held.close();
  while (!f.sent.includes('turn/interrupt')) await settle();
  cleanupEntered();
  const reopened = await b.resume({ ...access, binding, reference: reference(first) });
  const progressed = await turnOn(independent, 'independent');
  assert.equal((await progressed.completion).kind, 'terminal', 'independent session progresses during held cleanup');
  assert.deepEqual(w.overlaps, [], 'same-session-writer-overlap');
  assert.deepEqual(reopened, { kind: 'ok', value: { kind: 'busy' } });
  completion.open();
  const report = await closing;
  assert.equal((await active.completion).terminal.status, 'interrupted');
  // The turn concluded and cleanup finished, but A still holds the thread loaded: refused before any native request.
  const before = g.sent.length;
  const early = await b.resume({ ...access, binding, reference: reference(first) });
  assert.deepEqual(w.overlaps, [], 'same-session-writer-overlap');
  assert.deepEqual(report, { interrupt: 'replied', unsubscribe: 'replied', released: false });
  assert.deepEqual([early, g.sent.length], [{ kind: 'ok', value: { kind: 'busy' } }, before]);
  f.exit();
  await settle();
  const admitted = await resumed(b, first);
  assert.equal((await (await turnOn(admitted, 'after')).completion).kind, 'terminal', 'subsequent admission progresses');
  assert.deepEqual(w.overlaps, [], 'same-session-writer-overlap');
}

test('a cleanup deadline or rejection never releases an accepted unconcluded writer; host-attested exit does', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const writers = real.createCodexWriters(4);
  const exit = gate();
  const f = appServer(t, w, { turn: hold });
  const a = await open(t, real, f, writers, { bounds: { ...bounds, cleanupTimeoutMs: 20 }, processExit: exit.promise });
  const session = await resumed(a, id);
  const turn = await turnOn(session);
  await turn.run();
  f.hold('turn/interrupt').promise.then(() => {});
  f.holds.set('interrupted', gate());
  const report = await session.close();
  assert.equal(report.released, false);
  assert.equal(writers.held(), 1, 'deadline is not termination');
  assert.equal((await a.close()).retained, 1);
  const g = appServer(t, w);
  const b = await open(t, real, g, writers);
  assert.deepEqual(await b.resume({ ...access, binding, reference: reference(id) }), { kind: 'ok', value: { kind: 'busy' } });
  assert.equal((await turn.completion).kind, 'unconcluded');
  exit.open();
  await settle();
  assert.equal(writers.held(), 0, 'host-attested process exit releases');
  await resumed(b, id);
});

test('late cleanup from generation A cannot release or close replacement B', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const writers = real.createCodexWriters(4);
  const exit = gate();
  const f = appServer(t, w);
  const a = await open(t, real, f, writers, { processExit: exit.promise });
  const first = await resumed(a, id);
  await first.close();
  exit.open();
  await settle();
  const g = appServer(t, w);
  const b = await open(t, real, g, writers);
  const replacement = await resumed(b, id);
  // Generation A's late cleanup after replacement: repeated close, execution close and channel end.
  await first.close();
  await a.close();
  f.sink.ended('process-exit');
  await settle();
  assert.equal(writers.held(), 1, 'B keeps its reservation');
  assert.deepEqual(await a.resume({ ...access, binding, reference: reference(id) }), { kind: 'error', error: { code: 'closed' } });
  const turn = await turnOn(replacement);
  assert.equal((await turn.completion).kind, 'terminal', 'B transport still open');
  assert.equal(g.detached, 0);
});

test('aborting startup mid-handshake closes the owned transport and takes no reservation', async (t) => {
  const w = world();
  const writers = real.createCodexWriters(4);
  const f = appServer(t, w);
  f.hold('initialize');
  const controller = new AbortController();
  const opening = real.openCodexExecution({ channel: f.channel, transport, bounds, home, writers, initialize: {},
    onServerRequest: () => ({ kind: 'result', value: null }), signal: controller.signal, processExit: new Promise(() => {}) });
  while (!f.sent.includes('initialize')) await settle();
  controller.abort();
  assert.deepEqual(await opening, { kind: 'error', error: { code: 'closed' } });
  assert.equal(f.detached, 1);
  assert.equal(writers.held(), 0);
  // Nothing was reserved, so nothing is released; a fresh open on a new app-server proceeds.
  const fresh = await open(t, real, appServer(t, w), writers);
  assert.equal((await fresh.create(access)).kind, 'ok');
  assert.equal(writers.held(), 1);
});

test('close during a pending resume yields no session and retains the entered writer until process exit', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const writers = real.createCodexWriters(4);
  const exit = gate();
  const f = appServer(t, w);
  const a = await open(t, real, f, writers, { processExit: exit.promise });
  const held = f.hold('thread/resume');
  const pending = a.resume({ ...access, binding, reference: reference(id) });
  while (!f.sent.includes('thread/resume')) await settle();
  const closed = a.close();
  assert.deepEqual(await pending, { kind: 'error', error: { code: 'closed' } });
  assert.equal((await closed).retained, 1, 'the written thread/resume may have loaded the thread');
  held.open();
  const g = appServer(t, w);
  const b = await open(t, real, g, writers);
  assert.deepEqual(await b.resume({ ...access, binding, reference: reference(id) }), { kind: 'ok', value: { kind: 'busy' } });
  exit.open();
  await settle();
  const session = await resumed(b, id);
  assert.equal((await (await turnOn(session)).completion).kind, 'terminal');
});

test('acknowledgement loss after turn/start entry is outcome-unknown and never resent', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const writers = real.createCodexWriters(4);
  const f = appServer(t, w, { turn: hold });
  const a = await open(t, real, f, writers);
  const session = await resumed(a, id);
  f.hold('turn/start');
  const turn = await turnOn(session);
  while (!f.sent.includes('turn/start')) await settle();
  f.sink.ended('eof');
  assert.deepEqual((await turn.run()).observation, { kind: 'outcome-unknown' });
  assert.deepEqual(await turn.completion, { kind: 'unconcluded', accepted: false, reason: 'eof' });
  assert.deepEqual((await turn.reconcile(new AbortController().signal)).error, { code: 'unsupported' });
  assert.equal(f.sent.filter((method) => method === 'turn/start').length, 1);
  assert.equal(writers.held(), 1, 'uncertain entry retains the writer');
});

test('an invalid turn/start reply orphans the turn and session close does not wait for it', async (t) => {
  const id = randomUUID();
  const f = appServer(t, world(id));
  const session = await resumed(await open(t, real, f, real.createCodexWriters(4)), id);
  f.hold('turn/start').open('drop');
  const turn = await turnOn(session);
  while (f.last.method !== 'turn/start') await settle();
  f.sink.data(Buffer.from(`${JSON.stringify({ id: f.last.id, result: {} })}\n`));
  assert.deepEqual((await turn.run()).observation, { kind: 'outcome-unknown' });
  const late = new Promise((resolve) => { setTimeout(resolve, 1000, 'waited').unref(); });
  assert.deepEqual(await Promise.race([session.close(), late]), { interrupt: 'not-needed', unsubscribe: 'replied', released: false });
});

test('a not-sent turn/start is outcome-unknown in core but proven unsent to the adapter and releases nothing', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const f = appServer(t, w);
  const a = await open(t, real, f, real.createCodexWriters(4), { transport: { ...transport, maxFrameBytes: 4096 } });
  const session = await resumed(a, id);
  const turn = session.turn({ hostOperationId: 'big', input: [{ type: 'text', text: 'x'.repeat(8192), text_elements: [] }],
    signal: access.signal, recordIntent: () => {} });
  assert.deepEqual((await turn.value.run()).observation, { kind: 'outcome-unknown' });
  assert.deepEqual(await turn.value.completion, { kind: 'not-sent', reason: 'invalid-outgoing' });
  assert.equal(f.sent.includes('turn/start'), false);
  assert.equal((await (await turnOn(session, 'next')).completion).kind, 'terminal', 'session stays usable');
});

test('a slow session observer overflows alone and never closes the transport', async (t) => {
  const [first, second] = [randomUUID(), randomUUID()];
  const w = world(first, second);
  const flood = (server, threadId, turnId) => {
    for (let n = 0; n < 40; n++) server.notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm', delta: `${n}` });
    server.complete(threadId, turnId);
  };
  const f = appServer(t, w, { turn: flood });
  const a = await open(t, real, f, real.createCodexWriters(4));
  const slow = await resumed(a, first);
  const other = await resumed(a, second);
  const stuck = gate();
  const subscription = slow.events.subscribe(() => stuck.promise);
  const turn = await turnOn(slow);
  assert.equal((await turn.completion).kind, 'terminal');
  assert.equal(await subscription.value.ended, 'overflow');
  const next = await turnOn(other);
  assert.equal((await next.completion).kind, 'terminal', 'transport stayed open');
  stuck.open();
});

test('server requests reach the host hook unanswered by the adapter', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const f = appServer(t, w);
  const seen = [];
  await open(t, real, f, real.createCodexWriters(4), { onServerRequest: (request) => {
    seen.push(request.method);
    return { kind: 'result', value: { decision: 'decline' } };
  } });
  f.sink.data(Buffer.from(`${JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: id } })}\n`));
  await settle();
  await settle();
  assert.deepEqual(seen, ['item/commandExecution/requestApproval']);
});

test('invalid options, bounds, params and references are refused before any native request', async (t) => {
  const id = randomUUID();
  const f = appServer(t, world(id));
  const base = { channel: f.channel, transport, bounds, home, initialize: {}, onServerRequest: () => ({ kind: 'result', value: null }),
    signal: access.signal, writers: real.createCodexWriters(4), processExit: new Promise(() => {}) };
  for (const broken of [{ onServerRequest: undefined }, { processExit: undefined }, { processExit: {} }, { home: '' }, { signal: null }, { writers: {} }, { initialize: [] },
    { bounds: { ...bounds, acknowledgementTimeoutMs: 0 } }, { bounds: { ...bounds, cleanupTimeoutMs: 2 ** 31 } },
    { bounds: { ...bounds, maxSessions: 1.5 } }, { bounds: null }]) {
    assert.deepEqual(await real.openCodexExecution({ ...base, ...broken }), { kind: 'error', error: { code: 'invalid-input' } });
  }
  assert.deepEqual(f.sent, [], 'refused before the transport opens');
  const execution = await open(t, real, f, real.createCodexWriters(4));
  const invalid = { kind: 'error', error: { code: 'invalid-input' } };
  assert.deepEqual(await execution.create({ ...access, params: { ephemeral: true } }), invalid);
  assert.deepEqual(await execution.create({ ...access, signal: 'no' }), invalid);
  assert.deepEqual(await execution.resume({ ...access, binding, reference: reference(id), params: { threadId: id } }), invalid);
  assert.deepEqual(await execution.resume({ ...access, binding: { engine: 'codex' }, reference: reference(id) }), invalid);
  assert.deepEqual(await execution.resume({ ...access, binding, reference: { ...reference(id), formatVersion: 2 } }),
    { kind: 'error', error: { code: 'unsupported-version' } });
  assert.deepEqual(await execution.resume({ ...access, binding, reference: reference(id, { account: 'chatgpt:other' }) }),
    { kind: 'error', error: { code: 'binding-mismatch' } });
  assert.deepEqual(f.sent, ['initialize']);
  const session = await resumed(execution, id);
  const before = f.sent.length;
  const turn = (extra) => session.turn({ hostOperationId: 'op', input, signal: access.signal, recordIntent: () => {}, ...extra });
  for (const extra of [{ input: 'text' }, { params: { input: [] } }, { params: { threadId: id } }, { signal: undefined }]) {
    assert.deepEqual(turn(extra), invalid);
  }
  assert.equal(f.sent.length, before);
  assert.equal((await turn({}).value.completion).kind, 'terminal', 'refusals left the session idle');
});

test('an initialize reply for another home closes the transport and fails the open', async (t) => {
  const f = appServer(t, world());
  const writers = real.createCodexWriters(4);
  const opened = await real.openCodexExecution({ channel: f.channel, transport, bounds, home: '/fixture/other-home', writers,
    initialize: {}, onServerRequest: () => ({ kind: 'result', value: null }), signal: access.signal,
    processExit: new Promise(() => {}) });
  assert.deepEqual(opened, { kind: 'error', error: { code: 'native-failure' } });
  assert.equal(f.detached, 1);
  assert.deepEqual(f.sent, ['initialize'], 'no initialized notification or later request');
});

test('create refuses ephemeral threads and a close during create yields no session', async (t) => {
  const w = world();
  const writers = real.createCodexWriters(4);
  const f = appServer(t, w, {});
  const execution = await open(t, real, f, writers);
  const start = f.hold('thread/start');
  const pending = execution.create(access);
  while (!f.sent.includes('thread/start')) await settle();
  const closed = execution.close();
  // The native thread may exist, but a start-only thread holds no writer and is not durable.
  assert.deepEqual(await pending, { kind: 'error', error: { code: 'outcome-unknown' } });
  assert.equal((await closed).retained, 0);
  start.open();
  assert.equal(writers.held(), 0);
  const g = appServer(t, w);
  const ephemeral = await open(t, real, g, writers);
  g.hold('thread/start').open('drop');
  const created = ephemeral.create(access);
  while (!g.sent.includes('thread/start')) await settle();
  const thread = { id: randomUUID(), historyMode: 'paginated', ephemeral: true };
  g.sink.data(Buffer.from(`${JSON.stringify({ id: g.last.id, result: { thread } })}\n`));
  assert.deepEqual(await created, { kind: 'error', error: { code: 'native-failure' } });
  assert.equal(writers.held(), 0);
});

test('usage keeps native total and last labelled per method; malformed usage becomes opaque and nothing is invented', async (t) => {
  const id = randomUUID();
  const malformed = { total: { ...usage(2), outputTokens: -1 }, last: usage(1), modelContextWindow: 1000 };
  const f = appServer(t, world(id), { turn: (server, threadId, turnId) => {
    server.notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: malformed });
    server.notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: usage(4), last: usage(2), modelContextWindow: null } });
    server.complete(threadId, turnId);
  } });
  const execution = await open(t, real, f, real.createCodexWriters(4));
  const session = await resumed(execution, id);
  const events = collect(session.events);
  await (await turnOn(session)).completion;
  await settle();
  const [opaque, metered] = events.filter((event) => event.kind === 'native' || event.kind === 'usage');
  assert.deepEqual([opaque.kind, opaque.method, opaque.evidence], ['native', 'thread/tokenUsage/updated', 'unqualified']);
  assert.deepEqual(opaque.params.tokenUsage, malformed, 'native payload preserved, no zeros invented');
  assert.deepEqual([metered.total, metered.last, metered.modelContextWindow], [usage(4), usage(2), null]);
  assert.equal(metered.evidence, real.codexNotificationEvidence['thread/tokenUsage/updated']);
  assert.equal(metered.evidence, 'qualified', 'qualified by native proof X1 on both architectures');
  assert.equal(events.find((event) => event.kind === 'turn-completed').evidence, 'qualified');
});

test('unknown and thread-less notifications reach the counted execution stream, never a session', async (t) => {
  const id = randomUUID();
  const f = appServer(t, world(id));
  const execution = await open(t, real, f, real.createCodexWriters(4));
  const session = await resumed(execution, id);
  const routed = collect(session.events);
  const unrouted = collect(execution.events);
  f.notify('account/updated', { authMode: 'apikey' });
  f.notify('item/agentMessage/delta', { threadId: randomUUID(), turnId: randomUUID(), itemId: 'm', delta: 'other' });
  f.notify('thread/status/changed', { threadId: id, status: { type: 'idle' } });
  f.sink.data(Buffer.from(`${JSON.stringify({ id: 'never-sent', result: {} })}\n`));
  await settle();
  await settle();
  assert.deepEqual(unrouted.map((event) => event.method ?? event.kind), ['account/updated', 'item/agentMessage/delta', 'unmatched-reply']);
  assert.deepEqual(routed.map((event) => [event.kind, event.method]), [['native', 'thread/status/changed']]);
  assert.deepEqual(execution.counts(), { unrouted: 2, unmatchedReplies: 1, earlyOverflow: 0 });
});

test('a closed session keeps its writer, so a same-process reopen is busy before any native request', async (t) => {
  const id = randomUUID();
  const w = world(id);
  const f = appServer(t, w);
  const writers = real.createCodexWriters(4);
  const execution = await open(t, real, f, writers);
  const first = await resumed(execution, id);
  await (await turnOn(first)).completion;
  assert.deepEqual(await first.close(), { interrupt: 'not-needed', unsubscribe: 'replied', released: false });
  const before = f.sent.length;
  assert.deepEqual(await execution.resume({ ...access, binding, reference: reference(id) }), { kind: 'ok', value: { kind: 'busy' } });
  assert.equal(f.sent.length, before);
  assert.equal(writers.held(), 1);
  f.exit();
  await settle();
  assert.equal(writers.held(), 0);
  assert.deepEqual(w.overlaps, []);
});

test('early-notification overflow is reported once the turn id is known', async (t) => {
  const id = randomUUID();
  const f = appServer(t, world(id), { turn: hold });
  const execution = await open(t, real, f, real.createCodexWriters(4), { bounds: { ...bounds, maxEarlyNotifications: 2 } });
  const session = await resumed(execution, id);
  const events = collect(session.events);
  const unrouted = collect(execution.events);
  f.hold('turn/start').open('drop');
  const turn = await turnOn(session);
  while (f.last.method !== 'turn/start') await settle();
  const turnId = randomUUID();
  for (let n = 0; n < 4; n++) f.notify('item/agentMessage/delta', { threadId: id, turnId, itemId: 'm', delta: `${n}` });
  f.complete(id, turnId);
  await settle();
  f.sink.data(Buffer.from(`${JSON.stringify({ id: f.last.id, result: { turn: { id: turnId, status: 'inProgress' } } })}\n`));
  assert.equal((await turn.run()).observation.kind, 'conclusive', 'overflow never strands the terminal');
  await settle();
  assert.deepEqual(events.map((event) => event.kind), ['turn-accepted', 'early-overflow', 'text-delta', 'text-delta', 'turn-completed']);
  assert.equal(events[1].discarded, 2);
  assert.deepEqual(unrouted.map((event) => event.params.delta), ['2', '3'], 'overflowed notifications are not lost');
  assert.deepEqual(execution.counts(), { unrouted: 2, unmatchedReplies: 0, earlyOverflow: 2 });
});

test('a turn/start error reply is conclusive rejected and the session stays usable', async (t) => {
  const id = randomUUID();
  const f = appServer(t, world(id));
  const writers = real.createCodexWriters(4);
  const execution = await open(t, real, f, writers);
  const session = await resumed(execution, id);
  const unrouted = collect(execution.events);
  f.hold('turn/start').open('drop');
  const turn = await turnOn(session);
  while (f.last.method !== 'turn/start') await settle();
  f.notify('item/agentMessage/delta', { threadId: id, turnId: randomUUID(), itemId: 'm', delta: 'buffered' });
  await settle();
  const error = { code: -32600, message: 'invalid input', data: null };
  f.sink.data(Buffer.from(`${JSON.stringify({ id: f.last.id, error })}\n`));
  const snapshot = await turn.run();
  assert.deepEqual([snapshot.observation.kind, snapshot.observation.result], ['conclusive', { kind: 'rejected', error }]);
  assert.equal(snapshot.observation.evidence.nativeOperation, null);
  assert.deepEqual(await turn.completion, { kind: 'rejected', error });
  assert.deepEqual(unrouted.map((event) => event.params.delta), ['buffered'], 'buffered notifications are never dropped silently');
  assert.equal(execution.counts().unrouted, 1);
  f.holds.delete('turn/start');
  assert.equal((await (await turnOn(session, 'next')).completion).kind, 'terminal');
  assert.deepEqual(await session.close(), { interrupt: 'not-needed', unsubscribe: 'replied', released: false });
  assert.equal(writers.held(), 1);
});

test('process exit mid-turn settles unconcluded and releases; eof retains', async (t) => {
  for (const reason of ['process-exit', 'eof']) {
    const id = randomUUID();
    const w = world(id);
    const writers = real.createCodexWriters(4);
    const f = appServer(t, w, { turn: hold });
    const execution = await open(t, real, f, writers);
    const session = await resumed(execution, id);
    const turn = await turnOn(session);
    assert.equal((await turn.run()).observation.kind, 'accepted');
    if (reason === 'process-exit') f.exit();
    else f.sink.ended('eof');
    assert.deepEqual(await turn.completion, { kind: 'unconcluded', accepted: true, reason });
    await settle();
    assert.equal(writers.held(), reason === 'process-exit' ? 0 : 1, reason);
    const g = appServer(t, w);
    const next = await (await open(t, real, g, writers)).resume({ ...access, binding, reference: reference(id) });
    assert.equal(next.value.kind, reason === 'process-exit' ? 'resumed' : 'busy', reason);
  }
});

test('session and execution close are idempotent shared cleanups and reject new work', async (t) => {
  const [first, second] = [randomUUID(), randomUUID()];
  const f = appServer(t, world(first, second));
  const writers = real.createCodexWriters(4);
  const execution = await open(t, real, f, writers);
  const session = await resumed(execution, first);
  const closing = session.close();
  assert.equal(session.close(), closing);
  assert.deepEqual(session.turn({ hostOperationId: 'late', input, signal: access.signal, recordIntent: () => {} }),
    { kind: 'error', error: { code: 'closed' } });
  await closing;
  await resumed(execution, second);
  const done = execution.close();
  assert.equal(execution.close(), done);
  assert.deepEqual((await done).retained, 2, 'closed sessions stay loaded until process exit');
  assert.equal(writers.held(), 2);
  assert.deepEqual(await execution.create(access), { kind: 'error', error: { code: 'closed' } });
  assert.deepEqual(await execution.resume({ ...access, binding, reference: reference(first) }), { kind: 'error', error: { code: 'closed' } });
  assert.equal(f.sent.filter((method) => method === 'thread/unsubscribe').length, 2, 'each session cleaned once');
  assert.equal(f.detached, 1);
});

test('maxSessions and writer capacity bound opens without leaking reservations', async (t) => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const w = world(...ids);
  const writers = real.createCodexWriters(2);
  const f = appServer(t, w);
  const one = await open(t, real, f, writers, { bounds: { ...bounds, maxSessions: 1 } });
  const kept = await resumed(one, ids[0]);
  assert.deepEqual(await one.resume({ ...access, binding, reference: reference(ids[1]) }), { kind: 'error', error: { code: 'capacity' } });
  assert.equal(writers.held(), 1, 'a capacity refusal on the execution leaks no reservation');
  const two = await open(t, real, appServer(t, w), writers);
  await resumed(two, ids[1]);
  assert.deepEqual(await two.resume({ ...access, binding, reference: reference(ids[2]) }), { kind: 'error', error: { code: 'capacity' } });
  assert.deepEqual(await two.create(access), { kind: 'error', error: { code: 'capacity' } });
  assert.equal(writers.held(), 2);
  await kept.close();
  assert.equal(writers.held(), 2, 'close alone frees no writer capacity');
  f.exit();
  await settle();
  await resumed(two, ids[2]);
  assert.equal(writers.held(), 2);
  assert.throws(() => real.createCodexWriters(0), RangeError);
});

test('a written turn/start is bounded only by its acknowledgement deadline and is written exactly once', async (t) => {
  const id = randomUUID();
  const f = appServer(t, world(id), { turn: hold });
  const writers = real.createCodexWriters(4);
  const execution = await open(t, real, f, writers, { bounds: { ...bounds, acknowledgementTimeoutMs: 30, cleanupTimeoutMs: 30 } });
  const session = await resumed(execution, id);
  const unrouted = collect(execution.events);
  const host = new AbortController();
  f.hold('turn/start').open('drop');
  const started = session.turn({ hostOperationId: 'once', input, signal: host.signal, recordIntent: () => {} });
  const turn = started.value;
  const running = turn.run();
  while (f.last.method !== 'turn/start') await settle();
  host.abort();
  await settle();
  let settled = false;
  void running.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, 'the caller signal does not abandon a written turn/start');
  assert.deepEqual((await running).observation, { kind: 'outcome-unknown' });
  assert.deepEqual(session.turn({ hostOperationId: 'again', input, signal: access.signal, recordIntent: () => {} }),
    { kind: 'error', error: { code: 'busy' } }, 'uncertain entry keeps the session busy');
  // A late native terminal for the unacknowledged turn is preserved on the execution stream, never attributed.
  f.notify('turn/completed', { threadId: id, turn: { id: randomUUID(), status: 'completed', error: null } });
  await settle();
  assert.deepEqual(unrouted.map((event) => event.method), ['turn/completed']);
  assert.deepEqual((await turn.reconcile(access.signal)).error, { code: 'unsupported' });
  assert.equal(f.sent.filter((method) => method === 'turn/start').length, 1);
  assert.equal(writers.held(), 1, 'uncertain entry retains the writer');
});
