import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const src = new URL('../../../src/', import.meta.url).href;
const target = new URL('adapters/codex/sessions.ts', src).href;
// Broken controls: a routed requester that falls back to the native login instead of refusing it, and one that binds
// without checking the multi-agent pins.
const mutations = new Map([['native-fallback', ['if (run.route) {', 'if (run.route && account === null) {']],
  ['unpinned', ['|| settings.features.multi_agent_v2 !== false) return false;', '|| settings.features.multi_agent_v2 !== false) {}']],
  ['approvals', ["  if (settings.approval_policy !== 'never') return false;\n", '']]]);
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
const { codexSessions } = await import(target);
const fallback = (await import(`${target}?mutant=native-fallback`)).codexSessions;
const unpinned = (await import(`${target}?mutant=unpinned`)).codexSessions;
const approving = (await import(`${target}?mutant=approvals`)).codexSessions;
const { codexRoutePrincipal, copyCodexRoute } = await import(new URL('adapters/codex/route.ts', src).href);
hook.deregister();

const route = Object.freeze({ kind: 'litellm-proxy', providerId: 'litellm', endpoint: 'http://127.0.0.1:4000/v1',
  credentialPurpose: 'litellm-proxy', model: 'team/gpt-5.1-codex', scope: { engine: 'codex', account: 'host-account-a' } });
// SHA-256 of the UTF-8 of JSON.stringify([1, 'litellm', 'http://127.0.0.1:4000/v1', 'litellm-proxy', 'codex', 'host-account-a']): no model.
const principal = 'litellm-proxy:sha256:e4cdf2841b0dd4b832471ebc154497192a380f641664cfa1ac614817a2a78b54';
const threadId = '0199aaaa-0000-7000-8000-000000000001';
const bounds = { maxResults: 10, maxExamined: 10, maxDurationMs: 5000 };
const routed = { account: null, userId: null, requiresOpenaiAuth: false, workspaceRouting: null };

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai7m-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// The `config/read` provider entry observed for command auth (ai7m-review out.json), trimmed to the checked fields.
const entry = { name: 'LiteLLM', base_url: 'http://127.0.0.1:4000/v1', env_key: null, experimental_bearer_token: null,
  auth: { command: '/usr/bin/node', args: ['helper.mjs'], timeout_ms: 5000, refresh_interval_ms: 300000, cwd: '/w' },
  wire_api: 'responses', requires_openai_auth: false };
// `config/read` reports `-c features.multi_agent=false` nested under `features` and omits an unset feature (me4l-pin out.json).
const pinned = { multi_agent_v2: false, network_proxy: null, multi_agent: false, memories: false };
// `config/read` reports `-c approval_policy="never"` as that string and an unset policy as null (pvvq-native cfgread).
const sandbox = { sandbox_mode: 'workspace-write', default_permissions: null, sandbox_workspace_write: { writable_roots: [], network_access: false },
  approval_policy: 'never' };
/** Fake app-server: the native projections observed with provider command auth (codex-native-api.md). */
function server(dir, { provider = 'litellm', account = routed, route: scopeRoute = route, providers = { litellm: entry },
  threads = {}, threadProviders = {}, features = pinned, sandboxing = sandbox } = {}) {
  const calls = [];
  const request = async (call) => {
    calls.push(call.method);
    const id = call.params.threadId ?? threads[call.params.rolloutPath];
    const value = call.method === 'config/read'
      ? { config: { sqlite_home: '/private/index', log_dir: '/private/logs', model_providers: providers,
        ...(features === 'absent' ? {} : { features }), ...sandboxing,
        ...(provider === 'absent' ? {} : { model_provider: provider }) } }
      : call.method === 'account/read' ? account
        : call.method === 'getConversationSummary' ? { summary: { path: call.params.rolloutPath, conversationId: id } }
          : { thread: { id, historyMode: 'paginated', status: { type: 'notLoaded' },
            ...(Object.hasOwn(threadProviders, id) ? threadProviders[id] : { modelProvider: id.endsWith('2') ? 'openai' : 'litellm' }) } };
    return { kind: 'reply', envelope: { id: 1, raw: {}, reply: { kind: 'result', value } } };
  };
  const scope = { home: dir, request, initialize: { codexHome: dir }, ...(scopeRoute ? { route: scopeRoute } : {}) };
  return { calls, scope };
}
const options = (fake) => ({ scope: fake.scope, bounds, signal: new AbortController().signal });
const bind = (fake, sessions = codexSessions) => sessions.bind({ ...options(fake), nativeFormat: 'codex-thread/paginated' });
const binding = (dir, account) => ({ engine: 'codex', nativeVersion: '0.169.0', account, authorizedScope: dir,
  nativeFormat: 'codex-thread/paginated' });
const reference = (dir, account) => ({ kind: 'session', formatVersion: 1, binding: binding(dir, account), opaque: threadId });

test('a routed bind with no native login is the exact host-asserted route principal', async (t) => {
  const fake = server(home(t));
  assert.deepEqual(await bind(fake), { kind: 'ok', value: binding(fake.scope.home, principal) });
  assert.deepEqual(fake.calls, ['config/read', 'account/read']);
  assert.equal(codexRoutePrincipal(copyCodexRoute(route)), principal);
});

test('a routed requester refuses any native login, required OpenAI auth or another provider', async (t) => {
  for (const [account, provider] of [[{ ...routed, account: { type: 'apiKey' } }, 'litellm'],
    [{ ...routed, account: { type: 'chatgpt' }, userId: 'x' }, 'litellm'], [{ ...routed, requiresOpenaiAuth: true }, 'litellm'],
    [{ ...routed, requiresOpenaiAuth: undefined }, 'litellm'], [routed, 'openai'], [routed, null], [routed, 'LiteLLM']]) {
    const fake = server(home(t), { account, provider });
    assert.deepEqual(await bind(fake), { kind: 'error', error: { code: 'inaccessible' } }, JSON.stringify([account, provider]));
  }
  // Broken control: falling back to the native login binds a routed app-server to `apiKey`.
  const fake = server(home(t), { account: { ...routed, account: { type: 'apiKey' } } });
  assert.equal((await bind(fake, fallback)).value?.account, 'apiKey');
  assert.equal((await bind(server(home(t)), fallback)).value?.account, principal, 'The mutant still binds a clean route');
});

test('a routed requester refuses a provider entry that is not exactly the route with command auth only', async (t) => {
  const noAuth = { ...entry, auth: undefined };
  for (const providers of [{ litellm: { ...entry, base_url: 'http://127.0.0.1:4000/evil/v1' } },
    { litellm: { ...entry, base_url: 'http://127.0.0.1:4000/v1/' } }, {}, { litellm: noAuth }, { litellm: { ...entry, auth: {} } },
    { litellm: { ...entry, env_key: 'LITELLM_KEY' } }, { litellm: { ...entry, experimental_bearer_token: 'sk-x' } },
    { litellm: { ...entry, wire_api: 'chat' } }, { litellm: { ...entry, requires_openai_auth: true } }, null]) {
    const fake = server(home(t), { providers });
    assert.deepEqual(await bind(fake), { kind: 'error', error: { code: 'inaccessible' } }, JSON.stringify(providers));
    assert.deepEqual(fake.calls, ['config/read']);
  }
  // A built-in provider (ollama) is absent from model_providers yet reports no login: never a route.
  const ollama = server(home(t), { route: { ...route, providerId: 'ollama' }, provider: 'ollama' });
  assert.deepEqual(await bind(ollama), { kind: 'error', error: { code: 'inaccessible' } });
});

test('a routed requester refuses unless native multi-agent is pinned off', async (t) => {
  const { multi_agent: _v1, ...noV1 } = pinned;
  const { multi_agent_v2: _v2, ...noV2 } = pinned;
  for (const features of [noV1, noV2, { ...pinned, multi_agent: true }, { ...pinned, multi_agent_v2: true },
    { ...pinned, multi_agent: 'false' }, { memories: false }, 'absent', null]) {
    const fake = server(home(t), { features });
    assert.deepEqual(await bind(fake), { kind: 'error', error: { code: 'inaccessible' } }, JSON.stringify(features));
    assert.deepEqual(fake.calls, ['config/read']);
  }
  // A sandbox that config.toml can open to the network (or a default permissions profile) never binds either.
  for (const sandboxing of [{}, { ...sandbox, sandbox_mode: 'danger-full-access' }, { ...sandbox, default_permissions: ':workspace' },
    { ...sandbox, sandbox_workspace_write: { network_access: true } }, { ...sandbox, sandbox_workspace_write: null }]) {
    assert.deepEqual(await bind(server(home(t), { sandboxing })), { kind: 'error', error: { code: 'inaccessible' } }, JSON.stringify(sandboxing));
  }
  for (const sandbox_mode of ['read-only', 'workspace-write']) assert.equal((await bind(server(home(t), { sandboxing: { ...sandbox, sandbox_mode } }))).value?.account, principal);
  // Broken control: without the pin check a host that omitted the generated args binds a bypassable route.
  assert.equal((await bind(server(home(t), { features: { memories: false } }), unpinned)).value?.account, principal);
  // Direct mode does not consult the pins.
  const direct = server(home(t), { route: null, features: 'absent', account: { account: { type: 'apiKey' } } });
  assert.equal((await bind(direct)).value.account, 'apiKey');
});

test('a routed requester refuses unless native approvals are pinned to never', async (t) => {
  const granular = { granular: { sandbox_approval: true, rules: true, skill_approval: false, request_permissions: false, mcp_elicitations: true } };
  const { approval_policy: _policy, ...unset } = sandbox;
  for (const sandboxing of [unset, ...[null, 'on-request', 'untrusted', 'Never', granular, { never: true }].map((approval_policy) => ({ ...sandbox, approval_policy }))]) {
    const fake = server(home(t), { sandboxing });
    assert.deepEqual(await bind(fake), { kind: 'error', error: { code: 'inaccessible' } }, JSON.stringify(sandboxing));
    assert.deepEqual(fake.calls, ['config/read']);
  }
  // Broken control: without the check a config.toml approval policy binds a route an approved escalation can leave.
  assert.equal((await bind(server(home(t), { sandboxing: { ...sandbox, approval_policy: 'on-request' } }), approving)).value?.account, principal);
  // Direct mode does not consult it.
  const direct = server(home(t), { route: null, sandboxing: { ...sandbox, approval_policy: 'on-request' }, account: { account: { type: 'apiKey' } } });
  assert.equal((await bind(direct)).value.account, 'apiKey');
});

test('a routed resume and discovery admit only threads native ran on the route provider', async (t) => {
  const dir = home(t);
  const other = threadId.replace(/1$/, '2');
  const fake = server(dir);
  const access = { ...options(fake), binding: binding(dir, principal) };
  const offRoute = { ...reference(dir, principal), opaque: other };
  assert.deepEqual(await codexSessions.prepareResume({ ...access, reference: offRoute }), { kind: 'error', error: { code: 'inaccessible' } });
  assert.deepEqual(await codexSessions.inspect({ ...access, reference: offRoute }), { kind: 'error', error: { code: 'inaccessible' } });
  mkdirSync(join(dir, 'sessions'));
  for (const id of [threadId, other]) writeFileSync(join(dir, 'sessions', `${id}.jsonl`), '');
  const threads = Object.fromEntries([threadId, other].map((id) => [join(dir, 'sessions', `${id}.jsonl`), id]));
  const page = await codexSessions.discover({ ...options(server(dir, { threads })), binding: binding(dir, principal) });
  assert.deepEqual(page.value.sessions.map((item) => item.opaque), [threadId]);
  assert.equal(page.value.examined, 2);
});

test('direct mode is unchanged: a null native account is still inaccessible', async (t) => {
  const fake = server(home(t), { route: null });
  assert.deepEqual(await bind(fake), { kind: 'error', error: { code: 'inaccessible' } });
  assert.equal((await bind(server(home(t), { route: null, account: { account: { type: 'apiKey' } } }))).value.account, 'apiKey');
});

test('a direct requester admits only threads on its effective provider, never a routed thread', async (t) => {
  // Native probe7: a direct app-server over a home with a routed thread bound `apiKey` and resumed that thread on the
  // proxy with the helper's bearer. Direct discovery, inspection and preparation now refuse it.
  const dir = home(t);
  const other = threadId.replace(/1$/, '2');
  const direct = { route: null, provider: 'openai', account: { account: { type: 'apiKey' } } };
  const access = (fake) => ({ ...options(fake), binding: binding(dir, 'apiKey') });
  const litellm = reference(dir, 'apiKey');
  const openai = { ...litellm, opaque: other };
  const fake = server(dir, direct);
  assert.deepEqual(await codexSessions.inspect({ ...access(fake), reference: litellm }), { kind: 'error', error: { code: 'inaccessible' } });
  assert.deepEqual(await codexSessions.prepareResume({ ...access(fake), reference: litellm }),
    { kind: 'error', error: { code: 'inaccessible' } });
  assert.deepEqual(await codexSessions.prepareResume({ ...access(fake), reference: openai }),
    { kind: 'ok', value: { kind: 'ready', reference: openai, threadId: other, provider: 'openai' } });
  mkdirSync(join(dir, 'sessions'));
  for (const id of [threadId, other]) writeFileSync(join(dir, 'sessions', `${id}.jsonl`), '');
  const threads = Object.fromEntries([threadId, other].map((id) => [join(dir, 'sessions', `${id}.jsonl`), id]));
  const page = await codexSessions.discover({ ...access(server(dir, { ...direct, threads })) });
  assert.deepEqual(page.value.sessions.map((item) => item.opaque), [other]);
  assert.equal(page.value.examined, 2);
  // An absent or null `model_provider` is Codex's default `openai`: the litellm thread is still refused.
  for (const provider of ['absent', null]) {
    const fallback = server(dir, { ...direct, provider });
    assert.deepEqual(await codexSessions.prepareResume({ ...access(fallback), reference: openai }),
      { kind: 'ok', value: { kind: 'ready', reference: openai, threadId: other, provider: 'openai' } }, String(provider));
    assert.deepEqual(await codexSessions.prepareResume({ ...access(fallback), reference: litellm }),
      { kind: 'error', error: { code: 'inaccessible' } }, String(provider));
  }
  // A thread with no readable provider is refused, and an unreadable `model_provider` binds nothing.
  for (const value of [{}, { modelProvider: null }, { modelProvider: 7 }]) {
    const missing = server(dir, { ...direct, threadProviders: { [other]: value } });
    assert.deepEqual(await codexSessions.inspect({ ...access(missing), reference: openai }),
      { kind: 'error', error: { code: 'inaccessible' } }, JSON.stringify(value));
  }
  for (const provider of [7, '', { id: 'openai' }]) {
    assert.deepEqual(await bind(server(dir, { ...direct, provider })), { kind: 'error', error: { code: 'native-failure' } });
  }
});

test('routed and direct references never resolve under each other', async (t) => {
  const dir = home(t);
  const direct = server(dir, { route: null, account: { account: { type: 'apiKey' } } });
  const viaRoute = server(dir);
  const ready = { kind: 'ok', value: { kind: 'ready', reference: reference(dir, principal), threadId, provider: 'litellm' } };
  const prepare = (fake, account) => codexSessions.prepareResume({ ...options(fake), binding: binding(dir, account),
    reference: reference(dir, account) });
  assert.deepEqual(await prepare(viaRoute, principal), ready);
  assert.deepEqual(await prepare(direct, principal), { kind: 'error', error: { code: 'binding-mismatch' } });
  assert.deepEqual(await prepare(viaRoute, 'apiKey'), { kind: 'error', error: { code: 'binding-mismatch' } });
  const inspect = await codexSessions.inspect({ ...options(direct), binding: binding(dir, principal), reference: reference(dir, principal) });
  assert.deepEqual(inspect, { kind: 'error', error: { code: 'inaccessible' } });
  const discover = await codexSessions.discover({ ...options(viaRoute), binding: binding(dir, 'apiKey') });
  assert.deepEqual(discover, { kind: 'error', error: { code: 'inaccessible' } });
});

test('the principal is stable per route, changes with provider, endpoint or host scope, and hides the endpoint', () => {
  const of = (changes) => codexRoutePrincipal(copyCodexRoute({ ...route, ...changes }));
  assert.equal(of({}), of({}));
  const variants = [of({ providerId: 'litellm2' }), of({ endpoint: 'http://127.0.0.1:4001/v1' }),
    of({ scope: { engine: 'codex', account: 'host-account-b' } }), of({ scope: { engine: 'codex2', account: 'host-account-a' } })];
  assert.equal(new Set([principal, ...variants]).size, 5);
  // The model is not in the principal: one route principal serves sessions on different models (each app-server
  // enforces its own), and ai7m principals are unchanged. A route without a valid model is not a route.
  assert.equal(of({ model: 'other-model' }), principal);
  for (const model of [undefined, '', ' m', 'a\nb', 'x'.repeat(257)]) assert.equal(copyCodexRoute({ ...route, model }), undefined);
  for (const value of [principal, ...variants]) {
    assert.match(value, /^litellm-proxy:sha256:[0-9a-f]{64}$/);
    assert(value !== 'apiKey' && !value.startsWith('chatgpt:'));
    assert(!value.includes('127.0.0.1') && !value.includes('4000'));
  }
  const long = of({ endpoint: `https://proxy.example/${'a'.repeat(8000)}/v1` });
  assert.equal(long.length, principal.length, 'The hash bounds the length of a long endpoint');
});

test('invalid routes are refused before any native request', async (t) => {
  const invalid = [{ endpoint: 'http://127.0.0.1:4000' }, { endpoint: 'http://127.0.0.1:4000/v1/' },
    { endpoint: 'ftp://127.0.0.1/v1' }, { endpoint: 'http://user:pw@127.0.0.1/v1' }, { endpoint: 'http://127.0.0.1/v1?x=1' },
    { endpoint: ` http://127.0.0.1/v1` }, { endpoint: 'HTTP://127.0.0.1/v1' }, { endpoint: 'http://127.0.0.1/x/../v1' },
    { endpoint: 'http://127.0.0.1:80/v1' }, { providerId: 'lite llm' }, { providerId: '' }, { providerId: 'a\nb' },
    { providerId: 'x'.repeat(65) }, { kind: 'direct' }, { credentialPurpose: 'other' }, { scope: { engine: 'codex' } },
    { scope: { engine: 'codex', account: ' ' } }, { scope: null }];
  for (const changes of invalid) {
    const value = { ...route, ...changes };
    assert.equal(copyCodexRoute(value), undefined, JSON.stringify(changes));
    const fake = server(home(t), { route: value });
    assert.deepEqual(await bind(fake), { kind: 'error', error: { code: 'invalid-input' } });
    assert.deepEqual(fake.calls, []);
  }
  assert.equal(copyCodexRoute(Object.defineProperty({}, 'kind', { get() { throw new Error('hostile'); } })), undefined);
  assert(Object.isFrozen(copyCodexRoute(route).scope));
});
