import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const src = new URL('../../../src/', import.meta.url).href;
const target = new URL('adapters/codex/sessions.ts', src).href;
// Broken control: a routed requester that falls back to the native login instead of refusing it.
const mutations = new Map([['native-fallback', ['if (run.route) {', 'if (run.route && account === null) {']]]);
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
const { codexRoutePrincipal, copyCodexRoute } = await import(new URL('adapters/codex/route.ts', src).href);
hook.deregister();

const route = Object.freeze({ kind: 'litellm-proxy', providerId: 'litellm', endpoint: 'http://127.0.0.1:4000/v1',
  credentialPurpose: 'litellm-proxy', scope: { engine: 'codex', account: 'host-account-a' } });
// SHA-256 of the UTF-8 of JSON.stringify([1, 'litellm', 'http://127.0.0.1:4000/v1', 'litellm-proxy', 'codex', 'host-account-a']).
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
/** Fake app-server: the native projections observed with provider command auth (codex-native-api.md). */
function server(dir, { provider = 'litellm', account = routed, route: scopeRoute = route, providers = { litellm: entry },
  threads = {} } = {}) {
  const calls = [];
  const request = async (call) => {
    calls.push(call.method);
    const id = call.params.threadId ?? threads[call.params.rolloutPath];
    const value = call.method === 'config/read'
      ? { config: { sqlite_home: '/private/index', log_dir: '/private/logs', model_provider: provider, model_providers: providers } }
      : call.method === 'account/read' ? account
        : call.method === 'getConversationSummary' ? { summary: { path: call.params.rolloutPath, conversationId: id } }
          : { thread: { id, historyMode: 'paginated', status: { type: 'notLoaded' }, modelProvider: id.endsWith('2') ? 'openai' : 'litellm' } };
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

test('routed and direct references never resolve under each other', async (t) => {
  const dir = home(t);
  const direct = server(dir, { route: null, account: { account: { type: 'apiKey' } } });
  const viaRoute = server(dir);
  const ready = { kind: 'ok', value: { kind: 'ready', reference: reference(dir, principal), threadId } };
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
