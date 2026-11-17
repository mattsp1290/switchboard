import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';

const src = new URL('../../../src/', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  // Core discovery uses a parameter property, which strip-only loading rejects.
  if (!url.startsWith(src) || !url.endsWith('.ts')) return next(url, context);
  const source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url });
  return { format: 'module', source, shortCircuit: true };
} });
const { codexSessionMethods, codexSessions } = await import(new URL('adapters/codex/sessions.ts', src).href);
const { openCodexTransport } = await import(new URL('adapters/codex/transport.ts', src).href);
hook.deregister();

const id = (n) => `0199aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`;
const bounds = { maxResults: 10, maxExamined: 100, maxDurationMs: 5000 };
// Any request outside the frozen read-only method allowlist fails the test that sent it.
const strays = [];
afterEach(() => { const sent = strays.splice(0); assert.deepEqual(sent, [], 'Only allowlisted read methods are sent'); });
const reply = (value) => ({ kind: 'reply', envelope: { id: 1, raw: {}, reply: 'error' in value
  ? { kind: 'error', error: { data: null, ...value.error } } : { kind: 'result', value: value.result } } });
const hang = (signal) => new Promise((resolve) => signal.addEventListener('abort',
  () => resolve({ kind: 'uncertain', reason: 'aborted' }), { once: true }));
const thread = (threadId, historyMode = 'paginated', status = 'notLoaded') =>
  ({ result: { thread: { id: threadId, historyMode, status: status === 'active' ? { type: status, activeFlags: [] } : { type: status },
    path: null, cwd: '/tmp/project', cliVersion: '0.169.0', turns: [], extra: true } } });

function makeHome(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pg51-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  return dir;
}
function snapshot(dir) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = lstatSync(full);
      out.push([full, stat.mode, stat.ino, stat.size, stat.mtimeMs,
        stat.isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : null]);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}
/** Fake app-server behind the borrowed request function: summaries by path, threads by ID. */
function server(home, options = {}) {
  const calls = [];
  const summaries = new Map(Object.entries(options.summaries ?? {}).map(([name, value]) => [join(home, name), value]));
  const handlers = {
    'config/read': () => ({ result: { config: { sqlite_home: '/private/index', log_dir: '/private/logs', ...options.config } } }),
    'account/read': () => ({ result: options.account?.() ?? { account: { type: 'apiKey' }, userId: null, requiresOpenaiAuth: true } }),
    getConversationSummary: ({ rolloutPath }) => {
      const value = summaries.get(rolloutPath);
      if (value === undefined) return { error: { code: -32600, message: 'failed to resolve rollout path' } };
      return typeof value === 'string' ? { result: { summary: { conversationId: value, path: rolloutPath, cwd: '/tmp/project' } } } : value;
    },
    'thread/read': ({ threadId }) => options.threads?.[threadId] ?? { error: { code: -32600, message: `thread not loaded: ${threadId}` } },
  };
  const request = async (call, signal) => {
    calls.push(call);
    if (!codexSessionMethods.includes(call.method)) strays.push(call.method);
    const override = await options.on?.(call, calls.length, signal);
    if (override) return override;
    return reply(handlers[call.method]?.(call.params) ?? { error: { code: -32601, message: 'unexpected' } });
  };
  return { calls, request, scope: { home, request, initialize: { codexHome: home } }, methods: () => calls.map((call) => call.method) };
}
const binding = (home, extra = {}) => ({ engine: 'codex', nativeVersion: '0.169.0', account: 'apiKey',
  authorizedScope: home, nativeFormat: 'codex-thread/paginated', ...extra });
const access = (fake, extra = {}) => ({ scope: fake.scope, binding: binding(fake.scope.home), bounds,
  signal: new AbortController().signal, ...extra });
const session = (home, opaque, extra) => ({ kind: 'session', formatVersion: 1, binding: binding(home, extra), opaque });
function readOnly(fake) {
  for (const call of fake.calls.filter((entry) => entry.method === 'account/read')) assert.deepEqual(call.params, { refreshToken: false });
  for (const call of fake.calls.filter((entry) => entry.method === 'thread/read')) assert.equal(call.params.includeTurns, false);
}
const history = {
  'sessions/2026/11/17/rollout-a.jsonl': 'opaque native bytes a\n',
  'sessions/2026/11/17/rollout-bad.jsonl': '{invalid-json\n',
  'sessions/2026/11/17/rollout-legacy.jsonl': 'opaque legacy\n',
  'sessions/2026/11/17/rollout-unread.jsonl': 'opaque unread\n',
  'sessions/2026/11/17/rollout-moved.jsonl': 'opaque moved\n',
  'sessions/fixture-notes.txt': 'auxiliary\n',
  'state_5.sqlite': 'protected index bytes',
  'archived_sessions/2026/rollout-archived.jsonl': 'archived\n',
};
function fixture(t, options = {}) {
  const home = makeHome(t, history);
  linkSync(join(home, 'sessions/2026/11/17/rollout-a.jsonl'), join(home, 'sessions/2026/alias.opaque'));
  const corrupt = { error: { code: -32603, message: 'failed to read session metadata: rollout is empty' } };
  return server(home, { summaries: {
    'sessions/2026/11/17/rollout-a.jsonl': id(1), 'sessions/2026/alias.opaque': id(1), 'sessions/2026/11/17/rollout-bad.jsonl': corrupt,
    'sessions/2026/11/17/rollout-legacy.jsonl': id(2), 'sessions/2026/11/17/rollout-unread.jsonl': id(3),
    'sessions/2026/11/17/rollout-moved.jsonl': { result: { summary: { conversationId: id(4), path: join(home, 'elsewhere.jsonl') } } },
    'sessions/fixture-notes.txt': corrupt,
  }, threads: { [id(1)]: thread(id(1)), [id(2)]: thread(id(2), 'legacy'), [id(3)]: corrupt, [id(4)]: thread(id(4)) }, ...options });
}

test('bind derives the complete binding from the private index and native requester', async (t) => {
  const fake = fixture(t, { account: () => ({ account: { type: 'chatgpt', email: null, planType: 'plus', workspaceName: null },
    userId: 'user-a', requiresOpenaiAuth: true }) });
  const { binding: _omitted, ...options } = access(fake);
  const bound = await codexSessions.bind({ ...options, nativeFormat: 'codex-thread/legacy' });
  assert.deepEqual(bound, { kind: 'ok', value: { engine: 'codex', nativeVersion: '0.169.0', account: 'chatgpt:user-a',
    authorizedScope: fake.scope.home, nativeFormat: 'codex-thread/legacy' } });
  assert(Object.isFrozen(bound.value));
  assert.deepEqual(fake.methods(), ['config/read', 'account/read']);
  readOnly(fake);
});

test('bind and discover refuse a scope without a private index or with an unbindable requester before any history read', async (t) => {
  for (const config of [{ sqlite_home: null }, { log_dir: undefined }, { sqlite_home: 'relative/index' }]) {
    const fake = fixture(t, { config });
    assert.deepEqual(await codexSessions.discover(access(fake)), { kind: 'error', error: { code: 'invalid-input' } });
    assert.deepEqual(fake.methods(), ['config/read']);
  }
  const inside = fixture(t);
  inside.scope.request = server(inside.scope.home, { config: { sqlite_home: join(inside.scope.home, 'sub') } }).request;
  assert.deepEqual(await codexSessions.discover(access(inside)), { kind: 'error', error: { code: 'invalid-input' } });
  for (const account of [() => ({ account: null, userId: null, requiresOpenaiAuth: true }),
    () => ({ account: { type: 'gcp' }, userId: null, requiresOpenaiAuth: false }),
    () => ({ account: { type: 'chatgpt' }, userId: null, requiresOpenaiAuth: true })]) {
    const fake = fixture(t, { account });
    const { binding: _omitted, ...options } = access(fake);
    assert.deepEqual(await codexSessions.bind({ ...options, nativeFormat: 'codex-thread/paginated' }), { kind: 'error', error: { code: 'inaccessible' } });
    assert.deepEqual(fake.methods(), ['config/read', 'account/read']);
  }
});

test('operations refuse invalid scope, binding, format, bounds and signal without native requests', async (t) => {
  const fake = fixture(t);
  const invalid = [
    { ...access(fake), scope: { home: 'relative', request: fake.request } },
    { ...access(fake), scope: { home: `${fake.scope.home}/../x`, request: fake.request } },
    { ...access(fake), scope: { home: fake.scope.home, initialize: fake.scope.initialize } },
    { ...access(fake), scope: { ...fake.scope, initialize: { codexHome: '/other' } } },
    { ...access(fake), scope: { ...fake.scope, initialize: undefined } },
    { ...access(fake), binding: binding(fake.scope.home, { engine: 'claude' }) },
    { ...access(fake), binding: binding(fake.scope.home, { nativeVersion: '0.170.0' }) },
    { ...access(fake), binding: binding(fake.scope.home, { authorizedScope: '/other' }) },
    { ...access(fake), binding: binding(fake.scope.home, { nativeFormat: 'codex-rollout' }) },
    { ...access(fake), binding: binding(fake.scope.home, { account: 'a\nb' }) },
    { ...access(fake), bounds: { ...bounds, maxResults: 0 } },
    { ...access(fake), signal: {} },
    Object.defineProperty({}, 'scope', { get() { throw new Error('hostile'); } }),
  ];
  for (const options of invalid) {
    assert.deepEqual(await codexSessions.discover(options), { kind: 'error', error: { code: 'invalid-input' } });
    assert.deepEqual(await codexSessions.inspect({ ...options, reference: session(fake.scope.home, id(1)) }), { kind: 'error', error: { code: 'invalid-input' } });
    assert.deepEqual(await codexSessions.prepareResume({ ...options, reference: session(fake.scope.home, id(1)) }), { kind: 'error', error: { code: 'invalid-input' } });
  }
  const { binding: _omitted, ...options } = access(fake);
  assert.deepEqual(await codexSessions.bind({ ...options, nativeFormat: 'codex-thread/other' }), { kind: 'error', error: { code: 'invalid-input' } });
  assert.deepEqual(fake.calls, []);
});

test('discover returns bound native sessions, retains path-free diagnostics for failed files and writes nothing', async (t) => {
  const fake = fixture(t);
  const before = snapshot(fake.scope.home);
  const result = await codexSessions.discover(access(fake));
  assert.equal(result.kind, 'ok');
  const page = result.value;
  assert.equal(page.kind, 'complete');
  assert.deepEqual(page.sessions, [session(fake.scope.home, id(1))]);
  assert(Object.isFrozen(page) && Object.isFrozen(page.sessions[0]) && Object.isFrozen(page.diagnostics));
  assert.deepEqual(page.skipped, { corrupt: 0, inaccessible: 0 });
  assert.deepEqual(page.diagnostics.map((entry) => entry.kind), Array(4).fill('file-inspection-failed'));
  const tokens = page.diagnostics.map((entry) => entry.subject.token);
  assert.equal(new Set(tokens).size, 4);
  for (const token of tokens) assert(!/rollout|jsonl|notes|sessions|0199/.test(token) && !token.includes(fake.scope.home));
  assert.equal(page.examined, 10, 'Every directory entry under sessions is examined; archived history and the index are not');
  assert(page.diagnostics.length <= page.examined);
  const summaries = fake.calls.filter((call) => call.method === 'getConversationSummary').map((call) => call.params);
  assert.equal(summaries.length, 7);
  for (const params of summaries) assert.deepEqual(Object.keys(params), ['rolloutPath']);
  assert(summaries.every(({ rolloutPath }) => rolloutPath.startsWith(join(fake.scope.home, 'sessions'))));
  assert.equal(fake.calls.filter((call) => call.method === 'thread/read' && call.params.threadId === id(1)).length, 1, 'Aliases share one read');
  readOnly(fake);
  assert.deepEqual(snapshot(fake.scope.home), before);
  const legacy = await codexSessions.discover(access(fake, { binding: binding(fake.scope.home, { nativeFormat: 'codex-thread/legacy' }) }));
  assert.deepEqual(legacy.value.sessions, [session(fake.scope.home, id(2), { nativeFormat: 'codex-thread/legacy' })]);
});

test('discover reports an absent sessions tree as complete and an invalid tree as inaccessible', async (t) => {
  const absent = server(makeHome(t, { 'archived_sessions/x.jsonl': 'x' }));
  assert.deepEqual(await codexSessions.discover(access(absent)), { kind: 'ok', value: { kind: 'complete', sessions: [], examined: 0,
    skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [] } });
  const invalid = server(makeHome(t, { sessions: 'synthetic invalid directory' }));
  assert.deepEqual(await codexSessions.discover(access(invalid)), { kind: 'error', error: { code: 'inaccessible' } });
  assert.deepEqual(invalid.methods(), [], 'The host refuses an invalid tree before any native request');
});

test('discover refuses a requester that differs from the bound account before enumeration', async (t) => {
  const fake = fixture(t);
  const result = await codexSessions.discover(access(fake, { binding: binding(fake.scope.home, { account: 'chatgpt:user-b' }) }));
  assert.deepEqual(result, { kind: 'error', error: { code: 'inaccessible' } });
  assert.deepEqual(fake.methods(), ['config/read', 'account/read']);
});

test('discover retains settled observations in a failed page after a fatal transport failure', async (t) => {
  for (const kind of ['not-sent', 'uncertain']) {
    let summaries = 0;
    const fake = fixture(t, { on: (call) => call.method === 'getConversationSummary' && ++summaries === 7
      ? { kind, reason: 'closed' } : undefined });
    const { value: page } = await codexSessions.discover(access(fake));
    assert.equal(page.kind, 'failed');
    assert.equal(page.code, 'native-failure');
    assert.equal(page.examined, 10);
    assert.equal(page.sessions.length + page.diagnostics.length > 0, true, 'Earlier observations survive the fatal ending');
    assert.equal(summaries, 7);
  }
  const thrown = fixture(t, { on: (call) => { if (call.method === 'thread/read') throw new Error('borrowed failure'); } });
  const { value: page } = await codexSessions.discover(access(thrown));
  assert.deepEqual([page.kind, page.code], ['failed', 'native-failure']);
});

test('admission failures return outer errors before any native request', async (t) => {
  const notDir = server(makeHome(t, { sessions: 'synthetic invalid directory' }));
  const link = makeHome(t, { 'elsewhere/rollout.jsonl': 'opaque' });
  symlinkSync(join(link, 'elsewhere'), join(link, 'sessions'));
  const linked = server(link);
  for (const fake of [notDir, linked]) {
    assert.deepEqual(await codexSessions.discover(access(fake)), { kind: 'error', error: { code: 'inaccessible' } });
  }
  const moved = fixture(t);
  assert.deepEqual(await codexSessions.discover(access(moved, { scope: { ...moved.scope, initialize: { codexHome: join(moved.scope.home, 'x') } } })),
    { kind: 'error', error: { code: 'invalid-input' } });
  assert.deepEqual([...notDir.calls, ...linked.calls, ...moved.calls], []);
});

test('transport failure after observations retains a failed page; a later abort cannot replace it', async (t) => {
  const controller = new AbortController();
  let reads = 0;
  const fake = fixture(t, { on: (call) => {
    if (call.method !== 'thread/read' || ++reads < 2) return undefined;
    queueMicrotask(() => controller.abort());
    return { kind: 'uncertain', reason: 'closed' };
  } });
  const { value } = await codexSessions.discover(access(fake, { signal: controller.signal }));
  assert.deepEqual([value.kind, value.code], ['failed', 'native-failure']);
  assert.equal(value.sessions.length + value.diagnostics.length >= 1, true, 'The settled first read is retained');
  assert.equal(fake.calls.filter((call) => call.method === 'thread/read').length, 2, 'Nothing is sent after the fatal failure');
});

test('discover keeps a settled fatal failure ahead of a later abort and cancels while a request is outstanding', async (t) => {
  const controller = new AbortController();
  let summaries = 0;
  const fatal = fixture(t, { on: (call) => {
    if (call.method !== 'getConversationSummary' || ++summaries < 3) return undefined;
    queueMicrotask(() => controller.abort());
    return { kind: 'not-sent', reason: 'closed' };
  } });
  const first = await codexSessions.discover(access(fatal, { signal: controller.signal }));
  assert.deepEqual([first.value.kind, first.value.code], ['failed', 'native-failure']);
  const cancel = new AbortController();
  summaries = 0;
  const held = fixture(t, { on: (call, _, signal) => {
    if (call.method !== 'getConversationSummary' || ++summaries < 4) return undefined;
    setImmediate(() => cancel.abort());
    return hang(signal);
  } });
  const second = await codexSessions.discover(access(held, { signal: cancel.signal }));
  assert.equal(second.value.kind, 'cancelled');
  const retained = second.value.sessions.length + second.value.diagnostics.length;
  assert(retained >= 1 && retained <= 3, 'Observations settled before the abort are retained; cancellation adds no diagnostic');
  assert.equal(held.calls.length, held.calls.findIndex((call) => call.method === 'getConversationSummary') + summaries
    + held.calls.filter((call) => call.method === 'thread/read').length, 'No request after cancellation');
});

test('discover truncates by results, examined and duration with retained observations', async (t) => {
  const many = makeHome(t, Object.fromEntries([1, 2, 3, 4].map((n) => [`sessions/r${n}.jsonl`, `${n}`])));
  const fake = server(many, { summaries: Object.fromEntries([1, 2, 3, 4].map((n) => [`sessions/r${n}.jsonl`, id(n)])),
    threads: Object.fromEntries([1, 2, 3, 4].map((n) => [id(n), thread(id(n))])) });
  const results = await codexSessions.discover(access(fake, { bounds: { ...bounds, maxResults: 2 } }));
  assert.deepEqual([results.value.kind, results.value.reason, results.value.sessions.length], ['truncated', 'results', 2]);
  const examined = await codexSessions.discover(access(fake, { bounds: { maxResults: 2, maxExamined: 2, maxDurationMs: 5000 } }));
  assert.deepEqual([examined.value.kind, examined.value.reason, examined.value.examined], ['truncated', 'examined', 2]);
  assert(examined.value.sessions.length <= 2);
  let summaries = 0;
  const slow = server(many, { summaries: Object.fromEntries([1, 2, 3, 4].map((n) => [`sessions/r${n}.jsonl`, id(n)])),
    threads: Object.fromEntries([1, 2, 3, 4].map((n) => [id(n), thread(id(n))])),
    on: (call, _, signal) => call.method === 'getConversationSummary' && ++summaries === 2 ? hang(signal) : undefined });
  const duration = await codexSessions.discover(access(slow, { bounds: { ...bounds, maxDurationMs: 200 } }));
  assert.deepEqual([duration.value.kind, duration.value.reason, duration.value.sessions.length], ['truncated', 'duration', 1]);
});

test('inspect maps available, absent, busy, incompatible and unclassified native failures', async (t) => {
  const home = makeHome(t, {});
  const cases = [
    [thread(id(1)), { kind: 'available', reference: session(home, id(1)) }],
    [{ error: { code: -32600, message: `thread not loaded: ${id(1)}` } }, { kind: 'absent' }],
    [thread(id(1), 'paginated', 'idle'), { kind: 'busy' }],
    [thread(id(1), 'paginated', 'active'), { kind: 'busy' }],
    [thread(id(1), 'legacy'), { kind: 'incompatible', reason: 'native-format' }],
  ];
  for (const [native, expected] of cases) {
    const fake = server(home, { threads: { [id(1)]: native } });
    assert.deepEqual(await codexSessions.inspect({ ...access(fake), reference: session(home, id(1)) }), { kind: 'ok', value: expected });
    assert.deepEqual(fake.methods(), ['config/read', 'account/read', 'thread/read']);
    readOnly(fake);
  }
  for (const native of [
    { error: { code: -32603, message: 'failed to read session metadata: rollout is empty' } },
    { error: { code: -32600, message: 'failed to resolve rollout path' } },
    { error: { code: -32600, message: `thread not loaded: ${id(2)}` } },
    thread(id(2)), thread(id(1), 'future'), thread(id(1), 'paginated', 'unknown'), { result: null },
  ]) {
    const fake = server(home, { threads: { [id(1)]: native } });
    assert.deepEqual(await codexSessions.inspect({ ...access(fake), reference: session(home, id(1)) }), { kind: 'error', error: { code: 'native-failure' } });
  }
});

test('inspect rejects references outside the access binding or without a native identity', async (t) => {
  const home = makeHome(t, {});
  const fake = server(home, { threads: { [id(1)]: thread(id(1)) } });
  for (const reference of [session(home, id(1), { account: 'chatgpt:user-b' }), session(home, id(1), { nativeFormat: 'codex-thread/legacy' }),
    { ...session(home, id(1)), formatVersion: 2 }, session(home, '../rollout-a.jsonl'), session(home, id(1).toUpperCase())]) {
    assert.deepEqual(await codexSessions.inspect({ ...access(fake), reference }), { kind: 'error', error: { code: 'invalid-input' } });
  }
  assert.deepEqual(fake.calls, []);
  const other = server(home, { threads: { [id(1)]: thread(id(1)) }, account: () => ({ account: { type: 'chatgpt' }, userId: 'user-b', requiresOpenaiAuth: true }) });
  assert.deepEqual(await codexSessions.inspect({ ...access(other), reference: session(home, id(1)) }), { kind: 'error', error: { code: 'inaccessible' } });
  assert.deepEqual(other.methods(), ['config/read', 'account/read']);
});

test('prepareResume rechecks binding, requester and availability on every call without dispatching or reserving', async (t) => {
  const home = makeHome(t, {});
  let requester = { account: { type: 'apiKey' }, userId: null, requiresOpenaiAuth: true };
  const threads = { [id(1)]: thread(id(1)), [id(2)]: thread(id(2), 'legacy') };
  const fake = server(home, { threads, account: () => requester });
  const persisted = JSON.parse(JSON.stringify(session(home, id(1))));
  const ready = await codexSessions.prepareResume({ ...access(fake), reference: persisted });
  assert.deepEqual(ready, { kind: 'ok', value: { kind: 'ready', reference: session(home, id(1)), threadId: id(1) } });
  assert(Object.isFrozen(ready.value.reference) && ready.value.reference !== persisted);
  const again = await codexSessions.prepareResume({ ...access(fake), reference: persisted });
  assert.deepEqual(again, ready, 'Repeat preparation succeeds: nothing is reserved');
  assert.equal(fake.methods().filter((method) => method === 'account/read').length, 2, 'Authority is reread at each preparation');
  threads[id(1)] = thread(id(1), 'paginated', 'idle');
  assert.deepEqual(await codexSessions.prepareResume({ ...access(fake), reference: persisted }), { kind: 'ok', value: { kind: 'busy' } });
  const legacy = access(fake, { binding: binding(home, { nativeFormat: 'codex-thread/legacy' }) });
  assert.deepEqual(await codexSessions.inspect({ ...legacy, reference: session(home, id(2), { nativeFormat: 'codex-thread/legacy' }) }),
    { kind: 'ok', value: { kind: 'available', reference: session(home, id(2), { nativeFormat: 'codex-thread/legacy' }) } });
  assert.deepEqual(await codexSessions.prepareResume({ ...legacy, reference: session(home, id(2), { nativeFormat: 'codex-thread/legacy' }) }),
    { kind: 'ok', value: { kind: 'incompatible', reason: 'native-format' } }, 'Legacy exact resume is unqualified');
  for (const [reference, code] of [[session(home, id(1), { account: 'chatgpt:user-a' }), 'binding-mismatch'],
    [{ ...session(home, id(1)), formatVersion: 2 }, 'unsupported-version'], [{ kind: 'session' }, 'invalid-reference'],
    [session(home, 'not-a-thread'), 'invalid-reference']]) {
    assert.deepEqual(await codexSessions.prepareResume({ ...access(fake), reference }), { kind: 'error', error: { code } });
  }
  requester = { account: { type: 'chatgpt', email: null }, userId: 'user-a', requiresOpenaiAuth: true };
  assert.deepEqual(await codexSessions.prepareResume({ ...access(fake), reference: persisted }), { kind: 'error', error: { code: 'binding-mismatch' } },
    'A changed native login is a wrong-account binding mismatch at resume');
  readOnly(fake);
});

test('inspect and prepareResume map cancellation, deadline and transport loss without retry', async (t) => {
  const home = makeHome(t, {});
  const reference = session(home, id(1));
  const cancel = new AbortController();
  const held = server(home, { on: (call, _, signal) => call.method === 'thread/read' ? (setImmediate(() => cancel.abort()), hang(signal)) : undefined });
  assert.deepEqual(await codexSessions.inspect({ ...access(held, { signal: cancel.signal }), reference }), { kind: 'error', error: { code: 'cancelled' } });
  const slow = server(home, { on: (call, _, signal) => call.method === 'account/read' ? hang(signal) : undefined });
  assert.deepEqual(await codexSessions.prepareResume({ ...access(slow, { bounds: { ...bounds, maxDurationMs: 50 } }), reference }),
    { kind: 'error', error: { code: 'bounds-exceeded' } });
  for (const failure of [{ kind: 'not-sent', reason: 'capacity' }, { kind: 'uncertain', reason: 'closed' }]) {
    const lost = server(home, { on: (call) => call.method === 'thread/read' ? failure : undefined });
    assert.deepEqual(await codexSessions.prepareResume({ ...access(lost), reference }), { kind: 'error', error: { code: 'native-failure' } });
    assert.equal(lost.methods().filter((method) => method === 'thread/read').length, 1, 'No blind retry');
  }
  const aborted = AbortSignal.abort();
  const idle = server(home);
  assert.deepEqual(await codexSessions.discover(access(idle, { signal: aborted })), { kind: 'error', error: { code: 'cancelled' } });
  assert.deepEqual(idle.calls, []);
});

test('borrowed transport carries discovery and preparation end to end', async (t) => {
  const home = makeHome(t, { 'sessions/2026/rollout.jsonl': 'opaque' });
  const native = server(home, { summaries: { 'sessions/2026/rollout.jsonl': id(7) }, threads: { [id(7)]: thread(id(7)) } });
  let sink;
  const channel = {
    listen(next) { sink = next; return () => {}; },
    async write(bytes) {
      const message = JSON.parse(Buffer.from(bytes).toString());
      const { envelope: { reply: answer } } = await native.request({ method: message.method, params: message.params }, AbortSignal.timeout(1000));
      const body = answer.kind === 'result' ? { result: answer.value } : { error: answer.error };
      setImmediate(() => sink.data(Buffer.from(`${JSON.stringify({ id: message.id, ...body })}\n`)));
    },
  };
  const transport = openCodexTransport({ channel, onRequest: () => ({ kind: 'error', error: { code: -32601, message: 'none', data: null } }),
    onObservation: () => {}, bounds: { maxFrameBytes: 65536, maxChunkBytes: 65536, maxDiagnosticBytes: 64, maxPending: 4, maxHandlers: 1,
      maxWrites: 4, observationCapacity: 4, handlerTimeoutMs: 1000, observationTimeoutMs: 1000, writeTimeoutMs: 1000 } });
  t.after(() => transport.close());
  const scope = { home, request: transport.request, initialize: { codexHome: home } };
  const page = await codexSessions.discover({ scope, binding: binding(home), bounds, signal: new AbortController().signal });
  assert.deepEqual(page.value.sessions, [session(home, id(7))]);
  const ready = await codexSessions.prepareResume({ scope, binding: binding(home), bounds, signal: new AbortController().signal,
    reference: page.value.sessions[0] });
  assert.equal(ready.value.threadId, id(7));
  readOnly(native);
});
