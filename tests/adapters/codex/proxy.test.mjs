import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

const src = new URL('../../../src/', import.meta.url).href;
const target = new URL('adapters/codex/proxy.ts', src).href;
// Broken controls: a config that adds a static env-key credential, and a broker that caches its first resolution.
const call = "const resolved = await resolve.call(auth, { boundary: 'request', invocationId, requestId: randomUUID() }, requestSignal);";
// `fast` is not a broken control: a short connection lifetime so the idle and flood tests run in well under a second.
const mutations = new Map([['fast', ['connectionTimeoutMs: 10000', 'connectionTimeoutMs: 1000']], ['env-key', ["[`${at}.auth.command`]: command,", "[`${at}.env_key`]: 'LITELLM_API_KEY', [`${at}.auth.command`]: command,"]],
  ['cached', [call, call.replace('await resolve.call(', 'await (globalThis.me4lCache ??= resolve.call(').replace(/;$/, ');')]],
  // Broken control: a routed config that leaves native multi-agent on, so a sub-agent can pick its own model.
  ['multi-agent', ["'features.multi_agent': false, 'features.multi_agent_v2': false };", '};']]]);
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
    assert.notEqual(source.replace(from, to), source, `${query}-mutation-entered`);
    source = source.replace(from, to);
  }
  return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true };
} });
const proxy = await import(target);
const envKey = await import(`${target}?mutant=env-key`);
const cached = await import(`${target}?mutant=cached`);
const fast = await import(`${target}?mutant=fast`);
const multiAgent = await import(`${target}?mutant=multi-agent`);
const { codexSessions } = await import(new URL('adapters/codex/sessions.ts', src).href);
const { createAuthContext } = await import(new URL('core/auth.ts', src).href);
const { serializeDiagnostic, summarizeDiagnostic } = await import(new URL('core/diagnostics.ts', src).href);
hook.deregister();

const endpoint = 'http://127.0.0.1:4000/v1';
const route = Object.freeze({ kind: 'litellm-proxy', providerId: 'litellm', endpoint, credentialPurpose: 'litellm-proxy',
  model: 'team/gpt-5.1-codex', scope: { engine: 'codex', account: 'host-account-a' } });
const helper = { command: '/usr/local/bin/node', args: ['/opt/sb/proxy-helper.js', '/tmp/sb-codex-broker-x/s'] };
const options = { helper };
const scope = { engine: 'codex', account: 'host-account-a', adapterInstanceId: 'adapter-1', sessionId: 'session-1' };

/** A real `createAuthContext` LiteLLM resolver issuing `<prefix>-<n>`, recording every boundary it was called at. */
function auth(prefix, produce = (n) => ({ purpose: 'litellm-proxy', token: `${prefix}-${n}` }), extra = {}) {
  const contexts = [];
  const made = createAuthContext({ scope, config: { kind: 'litellm', model: 'team/gpt-5.1-codex', endpoint, protocol: 'responses',
    credentialPurpose: 'litellm-proxy', resolve: (context) => { contexts.push(context); return produce(contexts.length); }, ...extra } });
  assert.equal(made.kind, 'ok');
  return { scoped: made.value, contexts };
}
/** Runs the broker's helper exactly as Codex would: its command and args, no extra environment. */
const run = (broker) => new Promise((done) => execFile(broker.helper.command, broker.helper.args, { env: {} },
  (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr })));
async function start(t, scoped, invocationId = 'invocation-1', signal = new AbortController().signal, module = proxy) {
  const made = await module.startCodexCredentialBroker(scoped, { invocationId, route, signal });
  assert.equal(made.kind, 'ok');
  t.after(() => made.value.close());
  return made.value;
}
/** A resolver bypassing `createAuthContext` that answers a valid resolved LiteLLM value with `changes` applied. */
const raw = (changes) => ({ resolve: async () => ({ kind: 'ok', value: { kind: 'litellm', endpoint, model: route.model, protocol: 'responses',
  credentialPurpose: 'litellm-proxy', material: { purpose: 'litellm-proxy', token: 'tok' }, ...changes } }) });
const unavailable = { code: 3, stdout: '', stderr: 'switchboard: proxy credential unavailable\n' };

/** `-c key=value` args parsed back into the nested object `config/read` reports. */
function configRead(args) {
  const config = { sqlite_home: '/private/index', log_dir: '/private/logs' };
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], '-c');
    const [, key, value] = /^([^=]+)=(.*)$/su.exec(args[index + 1]);
    const path = key.split('.');
    let at = config;
    for (const part of path.slice(0, -1)) at = at[part] ??= {};
    at[path.at(-1)] = JSON.parse(value);
  }
  return config;
}
function appServer(config, account) {
  const request = async (request) => ({ kind: 'reply', envelope: { id: 1, raw: {}, reply: { kind: 'result',
    value: request.method === 'config/read' ? { config } : account } } });
  const home = mkdtempSync(join(tmpdir(), 'me4l-'));
  return { home, scope: (withRoute) => ({ home, request, initialize: { codexHome: home }, ...(withRoute ? { route } : {}) }) };
}
const bind = (fake, withRoute, sessions = codexSessions) => sessions.bind({ scope: fake.scope(withRoute), nativeFormat: 'codex-thread/paginated',
  bounds: { maxResults: 1, maxExamined: 1, maxDurationMs: 5000 }, signal: new AbortController().signal });

test('the proxy config is the exact provider override map with command auth and no retries', () => {
  const { config } = proxy.codexProxyConfig(route, options);
  const overrides = { model_provider: 'litellm', model: 'team/gpt-5.1-codex', 'model_providers.litellm.name': 'LiteLLM',
    'model_providers.litellm.base_url': endpoint, 'model_providers.litellm.wire_api': 'responses',
    'model_providers.litellm.supports_websockets': false, 'model_providers.litellm.request_max_retries': 0,
    'model_providers.litellm.stream_max_retries': 0, 'model_providers.litellm.requires_openai_auth': false,
    'model_providers.litellm.auth.command': helper.command, 'model_providers.litellm.auth.args': helper.args,
    'model_providers.litellm.auth.timeout_ms': 5000, 'model_providers.litellm.auth.refresh_interval_ms': 300000,
    'features.multi_agent': false, 'features.multi_agent_v2': false };
  assert.deepEqual(config.overrides, overrides);
  assert.deepEqual(config.args, Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]));
  assert(Object.isFrozen(config) && Object.isFrozen(config.overrides) && Object.isFrozen(config.args));
  assert.doesNotMatch(config.args.join(' '), /env_key|bearer|chatgpt|forced_login|openai_base_url/i);
  const tuned = proxy.codexProxyConfig(route, { ...options, timeoutMs: 1, refreshIntervalMs: 1000 }).config.overrides;
  assert.deepEqual([tuned['model_providers.litellm.auth.timeout_ms'], tuned['model_providers.litellm.auth.refresh_interval_ms']], [1, 1000]);
});

test('the generated config round-trips through config/read into a routed bind; direct mode is separate', async (t) => {
  const routed = { account: null, userId: null, requiresOpenaiAuth: false, workspaceRouting: null };
  const fake = appServer(configRead(proxy.codexProxyConfig(route, options).config.args), routed);
  t.after(() => rmSync(fake.home, { recursive: true, force: true }));
  assert.match((await bind(fake, true)).value.account, /^litellm-proxy:sha256:[0-9a-f]{64}$/);
  // Multi-agent is off as config/read reports it: a sub-agent's spawn_agent model would bypass the route model.
  const multiAgentOff = (args) => isDeepStrictEqual(configRead(args).features, { multi_agent: false, multi_agent_v2: false });
  assert.equal(multiAgentOff(proxy.codexProxyConfig(route, options).config.args), true);
  // Broken control: without the pin the routed config leaves native multi-agent on.
  assert.equal(multiAgentOff(multiAgent.codexProxyConfig(route, options).config.args), false);
  // ...and the routed bind refuses that config: a host that omits the pins cannot bind a route the model can bypass.
  const unpinned = appServer(configRead(multiAgent.codexProxyConfig(route, options).config.args), routed);
  t.after(() => rmSync(unpinned.home, { recursive: true, force: true }));
  assert.deepEqual(await bind(unpinned, true), { kind: 'error', error: { code: 'inaccessible' } });
  // No route: provider command auth has no native login to bind, so there is no subscription or stored-key passthrough.
  assert.deepEqual(await bind(fake, false), { kind: 'error', error: { code: 'inaccessible' } });
  // Broken control: a static env-key credential in the generated entry is refused by the routed check.
  const keyed = appServer(configRead(envKey.codexProxyConfig(route, options).config.args), routed);
  t.after(() => rmSync(keyed.home, { recursive: true, force: true }));
  assert.deepEqual(await bind(keyed, true), { kind: 'error', error: { code: 'inaccessible' } });
  // Direct mode without the proxy config is unaffected: the native login is the requester.
  const direct = appServer({ sqlite_home: '/private/index', log_dir: '/private/logs' }, { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
  t.after(() => rmSync(direct.home, { recursive: true, force: true }));
  assert.equal((await bind(direct, false)).value.account, 'apiKey');
});

test('invalid routes, models, helpers, timings and non-empty headers are refused with a precise problem', () => {
  const problem = (r, o) => proxy.codexProxyConfig(r, o).problem;
  assert.match(problem({ ...route, endpoint: 'http://127.0.0.1:4000/v2' }, options), /ending in \/v1/);
  assert.match(problem({ ...route, providerId: 'lite.llm' }, options), /providerId/);
  assert.match(problem(undefined, options), /route must be an object/);
  for (const model of ['', ' padded', 'a\nb', 'x'.repeat(257), 7, 'lone\ud800', undefined]) assert.match(problem({ ...route, model }, options), /route model must be/);
  assert.equal(problem(route, { ...options, auth: { model: 'other-model' } }), 'auth model must equal the route model');
  assert.ok(proxy.codexProxyConfig(route, { ...options, auth: { model: route.model } }).config);
  for (const bad of [{ command: 'node', args: [] }, { command: '/n', args: ['a\u0000'] }, { command: '/n', args: 'x' }]) {
    assert.match(problem(route, { ...options, helper: bad }), /helper must be/);
  }
  for (const timing of [{ timeoutMs: 0 }, { timeoutMs: 10001 }, { refreshIntervalMs: 0 }, { refreshIntervalMs: 1.5 }]) {
    assert.match(problem(route, { ...options, ...timing }), /out of range/);
  }
  assert.equal(proxy.codexProxyConfig(route, { ...options, timeoutMs: 10000 }).config.overrides['model_providers.litellm.auth.timeout_ms'], 10000);
  assert.equal(problem(route, { ...options, auth: { headers: { 'x-litellm-tag': 'a' } } }),
    'auth headers are refused: no native Codex provider header key is qualified for a LiteLLM route');
  assert.ok(proxy.codexProxyConfig(route, { ...options, auth: { headers: {} } }).config);
  assert.equal(problem(route, { get auth() { throw new Error('secret-token'); }, helper }), 'proxy options could not be read');
});

test('each helper run resolves a fresh token at a distinct request boundary; a caching broker is caught', async (t) => {
  const { scoped, contexts } = auth('token');
  const broker = await start(t, scoped);
  assert.equal(broker.helper.command, process.execPath);
  assert.deepEqual(broker.helper.args.length, 2);
  assert.equal(lstatSync(dirname(broker.helper.args[1])).mode & 0o777, 0o700);
  assert(lstatSync(broker.helper.args[1]).isSocket());
  const runs = [await run(broker), await run(broker), await run(broker)];
  assert.deepEqual(runs.map((r) => [r.code, r.stdout, r.stderr]), [[0, 'token-1', ''], [0, 'token-2', ''], [0, 'token-3', '']]);
  assert.deepEqual(contexts.map(({ boundary, invocationId, scope: s }) => [boundary, invocationId, s.sessionId]),
    Array(3).fill(['request', 'invocation-1', 'session-1']));
  assert.equal(new Set(contexts.map((context) => context.requestId)).size, 3);
  assert.doesNotMatch(JSON.stringify([broker.helper, proxy.codexProxyConfig(route, { ...options, helper: broker.helper })]), /token-/);
  // Broken control: reusing the first resolution never rotates.
  const mutant = await start(t, auth('cached').scoped, 'invocation-1', new AbortController().signal, cached);
  assert.deepEqual([(await run(mutant)).stdout, (await run(mutant)).stdout], ['cached-1', 'cached-1']);
  delete globalThis.me4lCache;
});

test('a failed, thrown, header-carrying or oversized resolution gives no token and a fixed redacted failure', async (t) => {
  const failing = [auth('x', () => { throw new Error('secret-token-leak'); }).scoped,
    auth('x', () => ({ purpose: 'other', token: 'secret-token-leak' })).scoped,
    auth('x', undefined, { headers: { 'x-extra': 'secret-token-leak' } }).scoped,
    // Not a printable-ASCII token: Codex trims stdout, and a newline in the header value suppresses Authorization.
    ...['tok\n', ' tok', 'tok en', 'tök', 'é'.repeat(40000), 'a'.repeat(65537), '', 7].map((token) => raw({ material: { purpose: 'litellm-proxy', token } })),
    // Not a litellm-proxy Responses credential.
    raw({ protocol: 'chat' }), raw({ credentialPurpose: 'other' }), raw({ material: { purpose: 'other', token: 'tok' } }), raw({ material: undefined }),
    // A resolver for another endpoint or model would send its token to this app-server's proxy.
    auth('x', undefined, { endpoint: 'http://127.0.0.1:4001/v1' }).scoped, auth('x', undefined, { model: 'other-model' }).scoped,
    auth('x', undefined, { protocol: 'chat' }).scoped,
    { resolve: async () => ({ kind: 'ok', value: { kind: 'direct', material: { token: 'secret-token-leak' } } }) }];
  for (const scoped of failing) assert.deepEqual(await run(await start(t, scoped)), unavailable);
  assert.deepEqual(await run(await start(t, raw({}))), { code: 0, stdout: 'tok', stderr: '' }, 'the raw control is served');
  for (const [scoped, r] of [[{}, route], [auth('x').scoped, { ...route, model: undefined }]]) {
    assert.deepEqual(await proxy.startCodexCredentialBroker(scoped, { invocationId: 'i', route: r, signal: new AbortController().signal }),
      { kind: 'error', error: { code: 'invalid-config', message: 'The credential broker could not start.' } });
  }
  assert.equal(serializeDiagnostic(summarizeDiagnostic('credentials', 'secret-token-leak')), '{"kind":"redacted","category":"credentials"}');
  // A connection that sends any payload is dropped unserved.
  const broker = await start(t, auth('quiet').scoped);
  const received = await new Promise((done) => { let out = ''; const socket = connect(broker.helper.args[1]);
    socket.on('data', (c) => { out += c; }).on('close', () => done(out)).on('error', () => {}); socket.write('x'); });
  assert.equal(received, '');
  // The helper takes exactly one argument.
  for (const args of [[], ['a', 'b']]) assert.deepEqual(await run({ helper: { command: process.execPath, args: [broker.helper.args[0], ...args] } }), unavailable);
  // Closing while a resolution is pending aborts it and writes nothing, even if the resolver answers afterwards.
  let seen; const pending = await start(t, { resolve: (_, signal) => { seen = signal; return new Promise((done) => signal.addEventListener('abort',
    () => done(raw({ material: { purpose: 'litellm-proxy', token: 'late-token' } }).resolve()))); } });
  const helperRun = run(pending);
  while (!seen) await new Promise((done) => setTimeout(done, 10));
  await pending.close();
  assert.deepEqual([await helperRun, seen.aborted], [unavailable, true]);
});

test('concurrent brokers are isolated and close removes the socket and its directory', async (t) => {
  const a = auth('alpha'); const b = auth('beta');
  const [first, second] = await Promise.all([start(t, a.scoped, 'inv-a'), start(t, b.scoped, 'inv-b')]);
  assert.notEqual(dirname(first.helper.args[1]), dirname(second.helper.args[1]));
  const runs = await Promise.all([run(first), run(second), run(first), run(second)]);
  assert.deepEqual(runs.map((r) => r.stdout.replace(/-\d$/, '')), ['alpha', 'beta', 'alpha', 'beta']);
  assert.deepEqual([a.contexts.map((c) => c.invocationId), b.contexts.map((c) => c.invocationId)], [['inv-a', 'inv-a'], ['inv-b', 'inv-b']]);
  await first.close(); await first.close();
  assert.equal(existsSync(dirname(first.helper.args[1])), false);
  assert.deepEqual(await run(first), unavailable);
  assert.equal((await run(second)).stdout, 'beta-3');
  const controller = new AbortController();
  const aborted = await start(t, auth('gone').scoped, 'inv-c', controller.signal);
  controller.abort();
  await aborted.close();
  assert.equal(existsSync(dirname(aborted.helper.args[1])), false);
  assert.deepEqual(await proxy.startCodexCredentialBroker(a.scoped, { invocationId: 'i', route, signal: controller.signal }),
    { kind: 'error', error: { code: 'aborted', message: 'The credential broker could not start.' } });
});

test('idle connections are reaped: a full broker fails fast, then serves again; a long socket path fails cleanly', async (t) => {
  const flood = auth('flood');
  const broker = await start(t, flood.scoped, 'invocation-1', new AbortController().signal, fast);
  const idle = await new Promise((done) => { const socket = connect(broker.helper.args[1]); socket.on('error', () => {});
    const at = Date.now(); socket.on('close', () => done(Date.now() - at)); });
  assert(idle >= 900 && idle < 3000, `idle connection closed after ${idle} ms`);
  // A same-user process holding every connection: the helper fails at once instead of hanging, and recovers after reaping.
  const holders = Array.from({ length: proxy.codexBrokerLimits.maxConnections }, () => connect(broker.helper.args[1]).on('error', () => {}));
  await Promise.all(holders.map((socket) => new Promise((done) => socket.once('connect', done))));
  assert.deepEqual(await run(broker), unavailable);
  assert.equal(flood.contexts.length, 0, 'refused before any resolution');
  await Promise.all(holders.map((socket) => new Promise((done) => (socket.destroyed ? done() : socket.once('close', done)))));
  assert.deepEqual(await run(broker), { code: 0, stdout: 'flood-1', stderr: '' });
  // A socket path beyond the platform limit: credential-unavailable, and no broker directory is left behind.
  const long = join(mkdtempSync(join(tmpdir(), 'me4l-long-')), 'x'.repeat(100));
  mkdirSync(long);
  t.after(() => rmSync(dirname(long), { recursive: true, force: true }));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = long;
  try {
    assert.deepEqual(await proxy.startCodexCredentialBroker(auth('long').scoped, { invocationId: 'i', route, signal: new AbortController().signal }),
      { kind: 'error', error: { code: 'credential-unavailable', message: 'The credential broker could not start.' } });
  } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  assert.deepEqual(readdirSync(long), []);
});
