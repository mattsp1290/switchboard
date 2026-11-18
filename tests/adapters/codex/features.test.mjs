import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Runtime tests live in .test.mjs: *.test.ts files in this repository are consumer type fixtures, not runtime tests.
const src = new URL('../../../src/', import.meta.url).href;
const featuresUrl = new URL('adapters/codex/features.ts', src).href;
// Broken controls are source mutations of the real module (precedent: execution.test.mjs).
const mutations = new Map([
  ['no-conflict', ['params[key] != null && !isDeepStrictEqual', 'false && !isDeepStrictEqual']],
  ['no-combination', ['merged[sandboxKey] != null && merged.permissions != null', 'false']],
  ['no-experimental', ['!record(capabilities) || capabilities.experimentalApi !== true', 'false']],
]);
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
const features = await import(featuresUrl);
const noConflict = await import(`${featuresUrl}?mutant=no-conflict`);
const noExperimental = await import(`${featuresUrl}?mutant=no-experimental`);
const noCombination = await import(`${featuresUrl}?mutant=no-combination`);
const execution = await import(new URL('adapters/codex/execution.ts', src).href);
hook.deregister();

const home = '/fixture/codex-home';
const experimental = { clientInfo: { name: 'z8tq-test', title: null, version: '0' },
  capabilities: { experimentalApi: true, requestAttestation: false } };
const plain = { clientInfo: { name: 'z8tq-test', title: null, version: '0' }, capabilities: null };
const access = { bounds: { maxResults: 10, maxExamined: 10, maxDurationMs: 5000 }, signal: new AbortController().signal };
const tool = (name, extra = {}) => ({ type: 'function', name, description: `${name} tool`,
  inputSchema: { type: 'object', properties: {} }, ...extra });
const binding = { engine: 'codex', nativeVersion: '0.169.0', account: 'apiKey', authorizedScope: home,
  nativeFormat: 'codex-thread/paginated' };
const input = [{ type: 'text', text: 'Fixture only.', text_elements: [] }];

/** Minimal inert app-server: answers what open, create and one turn send; records every request. */
function appServer() {
  const f = { sent: [], requests: [] };
  const send = (value) => f.sink?.data(Buffer.from(`${JSON.stringify(value)}\n`));
  const answer = {
    'initialize': () => ({ codexHome: home, userAgent: 'fake/0.169.0' }),
    'config/read': () => ({ config: { sqlite_home: '/private/index', log_dir: '/private/logs' } }),
    'account/read': () => ({ account: { type: 'apiKey' } }),
    'thread/start': () => ({ thread: { id: randomUUID(), historyMode: 'paginated', ephemeral: false, status: { type: 'idle' } } }),
    'turn/start': ({ threadId }) => {
      const id = randomUUID();
      queueMicrotask(() => send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [], error: null } } }));
      return { turn: { id, status: 'inProgress', items: [], error: null } };
    },
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  };
  f.channel = {
    listen(sink) { f.sink = sink; return () => {}; },
    write(bytes) {
      const message = JSON.parse(Buffer.from(bytes).toString());
      if (message.method === undefined || message.id === undefined) return Promise.resolve();
      f.sent.push(message.method);
      f.requests.push(message);
      const value = answer[message.method]?.(message.params) ?? { error: { code: -32601, message: 'unsupported' } };
      queueMicrotask(() => send(value.error ? { id: message.id, error: value.error } : { id: message.id, result: value }));
      return Promise.resolve();
    },
  };
  f.params = (method) => f.requests.findLast((request) => request.method === method)?.params;
  return f;
}
async function open(t, initialize = experimental) {
  const f = appServer();
  const opened = await execution.openCodexExecution({ channel: f.channel, home, initialize, writers: execution.createCodexWriters(4),
    transport: { maxFrameBytes: 65536, maxChunkBytes: 131072, maxDiagnosticBytes: 64, maxPending: 8, maxHandlers: 2,
      maxWrites: 8, observationCapacity: 64, handlerTimeoutMs: 60000, observationTimeoutMs: 60000, writeTimeoutMs: 60000 },
    bounds: { maxSessions: 4, maxObservers: 2, eventCapacity: 32, maxEarlyNotifications: 8, cleanupTimeoutMs: 60000,
      acknowledgementTimeoutMs: 60000 },
    onServerRequest: () => ({ kind: 'error', error: { code: -32601, message: 'test host', data: null } }),
    signal: new AbortController().signal, processExit: new Promise(() => {}) });
  assert.equal(opened.kind, 'ok', JSON.stringify(opened));
  t.after(() => opened.value.close());
  return { f, execution: opened.value };
}
const rejected = (outcome, pattern) => {
  assert.equal(outcome.kind, 'error', JSON.stringify(outcome));
  assert.equal(outcome.error.code, 'invalid-input');
  assert.match(outcome.error.message, pattern);
};

test('chosen thread settings and dynamic tools reach thread/start exactly, beside raw engine-specific keys', async (t) => {
  const { f, execution: codex } = await open(t);
  const chosen = { model: 'gpt-fixture', cwd: '/work/project', approvalPolicy: { granular: { sandbox_approval: true, rules: false,
    skill_approval: true, request_permissions: false, mcp_elicitations: true } }, approvalsReviewer: 'user', sandbox: 'workspace-write',
  dynamicTools: [tool('show_card'), { type: 'namespace', name: 'ui', description: 'UI', tools: [tool('pick', { deferLoading: true })] }] };
  const raw = { config: { mcp_servers: { docs: { command: '/bin/docs' } }, features: { web_search: true } },
    selectedCapabilityRoots: [], futureEngineKey: { opaque: 1 }, model: 'gpt-fixture' };
  const created = await codex.create({ ...access, params: raw, features: chosen });
  assert.equal(created.kind, 'ok', JSON.stringify(created));
  assert.deepEqual(f.params('thread/start'), { ...raw, ...chosen });

  const turn = created.value.turn({ hostOperationId: 'op', input, signal: new AbortController().signal, recordIntent: () => {},
    params: { outputSchema: { type: 'object' } }, features: { approvalPolicy: 'on-request', effort: 'high',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/project'], networkAccess: false, excludeTmpdirEnvVar: true,
        excludeSlashTmp: false } } });
  assert.equal(turn.kind, 'ok', JSON.stringify(turn));
  await turn.value.run();
  const { threadId, ...sent } = f.params('turn/start');
  assert.equal(threadId, created.value.threadId);
  assert.deepEqual(sent, { outputSchema: { type: 'object' }, approvalPolicy: 'on-request', effort: 'high',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/project'], networkAccess: false, excludeTmpdirEnvVar: true,
      excludeSlashTmp: false }, input });
});

test('omitted settings add nothing: no approval, sandbox, model or tool default is forced', async (t) => {
  const { f, execution: codex } = await open(t, plain);
  assert.equal((await codex.create({ ...access, features: {} })).kind, 'ok');
  assert.deepEqual(f.params('thread/start'), {});
  assert.deepEqual(features.resolveCodexFeatures('turn/start', { model: undefined }, { custom: 1 }, plain), { kind: 'ok', value: { custom: 1 } });
});

test('each conflict fails visibly with a message and sends nothing', async (t) => {
  const { f, execution: codex } = await open(t, plain);
  const before = [...f.sent];
  rejected(await codex.create({ ...access, params: { sandbox: 'read-only' }, features: { sandbox: 'danger-full-access' } }),
    /"sandbox" conflicts with the raw params value/);
  rejected(await codex.create({ ...access, features: { sandbox: 'read-only', permissions: 'locked' } }), /cannot combine "sandbox"/);
  rejected(await codex.create({ ...access, features: { dynamicTools: [tool('show_card')] } }), /experimentalApi/);
  rejected(await codex.create({ ...access, params: { dynamicTools: [tool('show_card')] }, features: {} }), /experimentalApi/);
  rejected(await codex.create({ ...access, features: { approvalPolicy: 'always' } }), /"approvalPolicy" is not an allowed/);
  rejected(await codex.create({ ...access, features: { cwd: 'relative/dir' } }), /"cwd" is not an allowed/);
  rejected(await codex.create({ ...access, features: { routing: 'litellm' } }), /no typed feature "routing"/);
  rejected(await codex.resume({ ...access, binding, reference: {}, features: { dynamicTools: [] } }), /thread\/resume has no typed feature/);
  assert.deepEqual(f.sent, before);
  const created = await codex.create(access);
  assert.equal(created.kind, 'ok');
  const sentBeforeTurn = f.sent.length;
  const turn = created.value.turn({ hostOperationId: 'op', input, signal: new AbortController().signal, recordIntent: () => {},
    params: { model: 'a' }, features: { model: 'b' } });
  rejected(turn, /"model" conflicts/);
  rejected(created.value.turn({ hostOperationId: 'op2', input, signal: new AbortController().signal, recordIntent: () => {},
    features: { sandboxPolicy: { type: 'dangerFullAccess' }, permissions: 'p' } }), /cannot combine "sandboxPolicy"/);
  assert.equal(f.sent.length, sentBeforeTurn);
  const after = created.value.turn({ hostOperationId: 'op3', input, signal: new AbortController().signal, recordIntent: () => {},
    features: { model: 'b' } });
  assert.equal(after.kind, 'ok', 'a rejected turn leaves the session free');
  await after.value.run();
  assert.equal(f.params('turn/start').model, 'b');
});

test('typed values outside the protocol set are refused', () => {
  const cases = [['thread/start', { approvalsReviewer: 'admin' }], ['thread/start', { model: '' }], ['turn/start', { effort: '' }],
    ['thread/start', { approvalPolicy: { granular: { sandbox_approval: true } } }],
    ['turn/start', { sandboxPolicy: { type: 'externalSandbox', networkAccess: true } }],
    ['turn/start', { sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['rel'], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false } }],
    ['turn/start', { sandboxPolicy: { type: 'readOnly', networkAccess: false, extra: 1 } }]];
  for (const [target, chosen] of cases) rejected(features.resolveCodexFeatures(target, chosen, {}, plain), /not an allowed native value/);
});

test('without features raw params pass unchanged, and a raw null is no conflict', () => {
  const raw = { sandbox: 'read-only', permissions: 'p', dynamicTools: [], futureKey: 1 };
  assert.deepEqual(features.resolveCodexFeatures('thread/start', undefined, raw, plain), { kind: 'ok', value: raw });
  assert.deepEqual(features.resolveCodexFeatures('turn/start', { model: 'm' }, { model: null }, plain), { kind: 'ok', value: { model: 'm' } });
});

test('dynamic tool names follow the native 0.169.0 rules', () => {
  const resolve = (dynamicTools) => features.resolveCodexFeatures('thread/start', { dynamicTools }, {}, experimental);
  rejected(resolve([tool('a'), tool('a')]), /duplicate dynamic tool name "a"/);
  rejected(resolve([tool(' a')]), /whitespace/);
  rejected(resolve([tool('')]), /non-empty name/);
  rejected(resolve([tool('a', { deferLoading: true })]), /outside a namespace/);
  const ns = (name, tools) => ({ type: 'namespace', name, description: 'n', tools });
  rejected(resolve([ns('ui', [tool('a')]), ns('ui', [tool('b')])]), /duplicate dynamic tool namespace "ui"/);
  rejected(resolve([ns('ui', [tool('a'), tool('a')])]), /duplicate dynamic tool name "a" in namespace "ui"/);
  rejected(resolve([ns('ui', [])]), /has no tools/);
  assert.equal(resolve([tool('a'), ns('ui', [tool('a')])]).kind, 'ok');
});

test('raw resume and turn keys are not reinterpreted, and equal typed and raw values agree', () => {
  const raw = { dynamicTools: 'engine-owned', approvalPolicy: 'never' };
  assert.deepEqual(features.resolveCodexFeatures('thread/resume', { approvalPolicy: 'never' }, raw, plain), { kind: 'ok', value: raw });
});

test('the capability table labels qualified, fixture-only and passthrough features without claiming unsupported', () => {
  const table = features.codexFeatureCapabilities;
  assert.ok(Object.isFrozen(table));
  assert.equal(table['command-approval-decline'].api.qualification, 'qualified');
  assert.equal(table['dynamic-tools'].api.qualification, 'fixture-only');
  assert.match(table['dynamic-tools'].api.note, /experimentalApi/);
  for (const name of ['config-overrides', 'plugins-and-capability-roots', 'environments', 'opaque-events']) {
    assert.equal(table[name].api.qualification, 'passthrough-unqualified', name);
  }
  for (const [name, entry] of Object.entries(table)) assert.equal(entry.kind, 'supported', name);
});

test('broken controls: removing the conflict or experimentalApi check lets the bad request through', () => {
  const conflict = ['thread/start', { sandbox: 'danger-full-access' }, { sandbox: 'read-only' }, plain];
  rejected(features.resolveCodexFeatures(...conflict), /conflicts/);
  assert.equal(noConflict.resolveCodexFeatures(...conflict).kind, 'ok');
  const gated = ['thread/start', { dynamicTools: [tool('a')] }, {}, plain];
  rejected(features.resolveCodexFeatures(...gated), /experimentalApi/);
  assert.equal(noExperimental.resolveCodexFeatures(...gated).kind, 'ok');
  const combined = ['turn/start', { permissions: 'p' }, { sandboxPolicy: { type: 'dangerFullAccess' } }, plain];
  rejected(features.resolveCodexFeatures(...combined), /cannot combine/);
  assert.equal(noCombination.resolveCodexFeatures(...combined).kind, 'ok');
});
