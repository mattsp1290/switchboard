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
  ['no-experimental', ['gated.length > 0 && !experimentalApi', 'false']],
  ['no-permission-gate', ["merged.permissions != null ? 'permissions' : '', record(merged.approvalPolicy) ? 'approvalPolicy.granular' : ''",
    "'', ''"]],
  ['no-resume-features', ["resolveCodexFeatures('thread/resume', access.features", "resolveCodexFeatures('thread/resume', undefined"]],
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
const noPermissionGate = await import(`${featuresUrl}?mutant=no-permission-gate`);
const executionUrl = new URL('adapters/codex/execution.ts', src).href;
const execution = await import(executionUrl);
const noResumeFeatures = await import(`${executionUrl}?mutant=no-resume-features`);
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
const reference = (opaque) => ({ kind: 'session', formatVersion: 1, binding, opaque });

/** Minimal inert app-server: answers what open, create and one turn send; records every request. */
function appServer() {
  const f = { sent: [], requests: [] };
  const send = (value) => f.sink?.data(Buffer.from(`${JSON.stringify(value)}\n`));
  const answer = {
    'initialize': () => ({ codexHome: home, userAgent: 'fake/0.169.0' }),
    'config/read': () => ({ config: { sqlite_home: '/private/index', log_dir: '/private/logs' } }),
    'account/read': () => ({ account: { type: 'apiKey' } }),
    'thread/start': () => ({ thread: { id: randomUUID(), historyMode: 'paginated', ephemeral: false, status: { type: 'idle' } } }),
    'thread/read': ({ threadId }) => ({ thread: { id: threadId, historyMode: 'paginated', status: { type: 'notLoaded' } } }),
    'thread/resume': ({ threadId }) => ({ thread: { id: threadId, turns: [] } }),
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
async function open(t, initialize = experimental, module = execution) {
  const f = appServer();
  const opened = await module.openCodexExecution({ channel: f.channel, home, initialize, writers: module.createCodexWriters(4),
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
const resolve = (target, chosen, raw = {}, experimentalApi = false) =>
  features.resolveCodexFeatures(target, chosen, raw, experimentalApi);
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
  assert.deepEqual(resolve('turn/start', { model: undefined }, { custom: 1 }), { kind: 'ok', value: { custom: 1 } });
});

test('chosen settings reach thread/resume exactly, and the resume wiring is load-bearing', async (t) => {
  const chosen = { model: 'gpt-fixture', cwd: '/work/project', sandbox: 'read-only', approvalPolicy: 'never' };
  for (const [module, reaches] of [[execution, true], [noResumeFeatures, false]]) {
    const { f, execution: codex } = await open(t, plain, module);
    const id = randomUUID();
    const result = await codex.resume({ ...access, binding, reference: reference(id), params: { model: 'gpt-fixture' }, features: chosen });
    assert.equal(result.kind, 'ok', JSON.stringify(result));
    assert.equal(result.value.kind, 'resumed', JSON.stringify(result.value));
    const { threadId, ...sent } = f.params('thread/resume');
    assert.equal(threadId, id);
    assert.deepEqual(sent, reaches ? chosen : { model: 'gpt-fixture' });
    await result.value.session.close();
  }
});

test('each conflict fails visibly with a message and sends nothing', async (t) => {
  const { f, execution: codex } = await open(t, plain);
  const before = [...f.sent];
  rejected(await codex.create({ ...access, params: { sandbox: 'read-only' }, features: { sandbox: 'danger-full-access' } }),
    /feature "sandbox" conflicts with raw params\.sandbox; remove it from raw params or make the values equal/);
  rejected(await codex.create({ ...access, features: { sandbox: 'read-only', permissions: 'locked' } }), /cannot combine "sandbox"/);
  rejected(await codex.create({ ...access, features: { dynamicTools: [tool('show_card')] } }), /dynamicTools requires .*experimentalApi/);
  rejected(await codex.create({ ...access, params: { dynamicTools: [tool('show_card')] }, features: {} }), /experimentalApi/);
  rejected(await codex.create({ ...access, features: { approvalPolicy: 'always' } }),
    /feature approvalPolicy must be one of untrusted, on-request, never or \{ granular \}/);
  rejected(await codex.create({ ...access, features: { cwd: 'relative/dir' } }), /feature cwd must be an absolute path/);
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
  rejected(created.value.turn({ hostOperationId: 'op4', input, signal: new AbortController().signal, recordIntent: () => {},
    features: { permissions: 'p' } }), /turn\/start permissions requires .*experimentalApi/);
  assert.equal(f.sent.length, sentBeforeTurn);
  const after = created.value.turn({ hostOperationId: 'op3', input, signal: new AbortController().signal, recordIntent: () => {},
    features: { model: 'b' } });
  assert.equal(after.kind, 'ok', 'a rejected turn leaves the session free');
  await after.value.run();
  assert.equal(f.params('turn/start').model, 'b');
});

test('permissions and a granular approvalPolicy need experimentalApi on every target, typed or raw', () => {
  const granular = { granular: { sandbox_approval: true, rules: false, mcp_elicitations: false } };
  for (const target of ['thread/start', 'thread/resume', 'turn/start']) {
    rejected(resolve(target, { permissions: 'p' }), new RegExp(`^${target} permissions requires initialize capabilities\\.experimentalApi === true$`));
    rejected(resolve(target, { approvalPolicy: granular }), /approvalPolicy\.granular requires .*experimentalApi/);
    rejected(resolve(target, {}, { permissions: 'p' }), /permissions requires/);
    assert.equal(resolve(target, { permissions: 'p', approvalPolicy: granular }, {}, true).kind, 'ok');
    assert.equal(resolve(target, undefined, { permissions: 'p' }).kind, 'ok', 'without features raw params are not gated');
    assert.equal(resolve(target, { permissions: null, approvalPolicy: 'never' }).kind, 'ok', 'null permissions is unset');
  }
});

test('the experimentalApi gate is read once at open; later host mutation cannot change it', async (t) => {
  const granted = structuredClone(experimental);
  const { f, execution: codex } = await open(t, granted);
  granted.capabilities.experimentalApi = false;
  assert.equal((await codex.create({ ...access, features: { dynamicTools: [tool('a')] } })).kind, 'ok');
  assert.deepEqual(f.requests.find((request) => request.method === 'initialize').params, experimental, 'initialize is sent unchanged');
  const denied = { ...plain, capabilities: { experimentalApi: false } };
  const { execution: other } = await open(t, denied);
  denied.capabilities.experimentalApi = true;
  rejected(await other.create({ ...access, features: { permissions: 'p' } }), /experimentalApi/);
});

test('typed values outside the protocol set are refused with the exact path', () => {
  const cases = [['thread/start', { approvalsReviewer: 'admin' }, /approvalsReviewer must be one of user, auto_review/],
    ['thread/start', { model: '' }, /model must be a non-empty string/], ['turn/start', { effort: '' }, /effort must be/],
    ['thread/start', { approvalPolicy: { granular: { sandbox_approval: true } } }, /approvalPolicy\.granular\.rules is required/],
    ['thread/start', { approvalPolicy: { granular: { sandbox_approval: true, rules: 1, mcp_elicitations: true } } },
      /approvalPolicy\.granular\.rules must be a boolean$/],
    ['thread/start', { approvalPolicy: { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true, extra: true } } },
      /approvalPolicy\.granular\.extra is not a native field/],
    ['turn/start', { sandboxPolicy: { type: 'externalSandbox', networkAccess: true } },
      /sandboxPolicy\.externalSandbox\.networkAccess must be one of restricted, enabled/],
    ['turn/start', { sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/ok', 'rel'] } },
      /feature sandboxPolicy\.workspaceWrite\.writableRoots\[1\] must be an absolute path$/],
    ['turn/start', { sandboxPolicy: { type: 'workspaceWrite', excludeSlashTmp: null } }, /excludeSlashTmp must be a boolean/],
    ['turn/start', { sandboxPolicy: { type: 'readOnly', networkAccess: false, extra: 1 } }, /sandboxPolicy\.readOnly\.extra is not a native field/],
    ['turn/start', { sandboxPolicy: { type: 'open' } }, /sandboxPolicy\.type must be one of dangerFullAccess/]];
  for (const [target, chosen, pattern] of cases) rejected(resolve(target, chosen), pattern);
});

test('defaulted schema fields may be omitted and are sent exactly as given', () => {
  const policies = [{ type: 'readOnly' }, { type: 'externalSandbox' }, { type: 'workspaceWrite' },
    { type: 'workspaceWrite', writableRoots: [] }, { type: 'externalSandbox', networkAccess: 'enabled' }];
  for (const sandboxPolicy of policies) {
    assert.deepEqual(resolve('turn/start', { sandboxPolicy }), { kind: 'ok', value: { sandboxPolicy } });
  }
  const approvalPolicy = { granular: { sandbox_approval: false, rules: true, mcp_elicitations: false } };
  assert.deepEqual(resolve('thread/start', { approvalPolicy }, {}, true), { kind: 'ok', value: { approvalPolicy } });
});

test('without features raw params pass unchanged, null is unset on either side, and uncloneable values are named', () => {
  const raw = { sandbox: 'read-only', permissions: 'p', dynamicTools: [], futureKey: 1 };
  assert.deepEqual(resolve('thread/start', undefined, raw), { kind: 'ok', value: raw });
  assert.deepEqual(resolve('turn/start', { model: 'm' }, { model: null }), { kind: 'ok', value: { model: 'm' } });
  assert.deepEqual(resolve('turn/start', { model: null }, { custom: 1 }), { kind: 'ok', value: { custom: 1 } });
  rejected(resolve('turn/start', { model: null }, { model: 'm' }), /"model" conflicts with raw params\.model/);
  rejected(resolve('thread/start', { dynamicTools: [tool('a', { inputSchema: { check: () => true } })] }, {}, true),
    /^thread\/start feature dynamicTools is not cloneable$/);
});

test('dynamic tool names follow the native 0.169.0 rules', () => {
  const tools = (dynamicTools) => resolve('thread/start', { dynamicTools }, {}, true);
  rejected(tools([tool('a'), tool('a')]), /duplicate dynamic tool name "a"/);
  rejected(tools([tool(' a')]), /whitespace/);
  rejected(tools([tool('')]), /non-empty name/);
  rejected(tools([tool('a', { deferLoading: true })]), /outside a namespace/);
  const ns = (name, inner) => ({ type: 'namespace', name, description: 'n', tools: inner });
  rejected(tools([ns('ui', [tool('a')]), ns('ui', [tool('b')])]), /duplicate dynamic tool namespace "ui"/);
  rejected(tools([ns('ui', [tool('a'), tool('a')])]), /duplicate dynamic tool name "a" in namespace "ui"/);
  rejected(tools([ns('ui', [])]), /has no tools/);
  assert.equal(tools([tool('a'), ns('ui', [tool('a')])]).kind, 'ok');
});

test('raw dynamicTools, including the legacy form, are not re-validated; only the gate and conflicts apply', () => {
  const legacy = [{ name: 'show_card', description: 'card', inputSchema: { type: 'object' } }, { name: ' odd' }];
  assert.deepEqual(resolve('thread/start', {}, { dynamicTools: legacy }, true), { kind: 'ok', value: { dynamicTools: legacy } });
  rejected(resolve('thread/start', {}, { dynamicTools: legacy }), /dynamicTools requires/);
  rejected(resolve('thread/start', { dynamicTools: [tool('a')] }, { dynamicTools: legacy }, true), /"dynamicTools" conflicts/);
  const raw = { dynamicTools: 'engine-owned', approvalPolicy: 'never' };
  assert.deepEqual(resolve('thread/resume', { approvalPolicy: 'never' }, raw), { kind: 'ok', value: raw });
});

test('the capability table labels evidence honestly, with carriers per target and unsupported gaps', () => {
  const table = features.codexFeatureCapabilities;
  assert.ok(Object.isFrozen(table));
  assert.equal(table['command-approval-decline'].api.qualification, 'qualified');
  const dynamic = table['dynamic-tools'].api;
  assert.equal(dynamic.qualification, 'fixture-only');
  assert.deepEqual(dynamic.carriers, { 'thread/start': ['dynamicTools'] });
  assert.match(dynamic.note, /experimentalApi.*switchboard-bd21.*frontend-restore\.ts:168-169.*not production qualification/);
  for (const name of ['sandbox', 'approval-policy']) assert.match(table[name].api.note, /experimentalApi/);
  assert.deepEqual(table.sandbox.api.carriers, { 'thread/start': ['sandbox', 'permissions'], 'thread/resume': ['sandbox', 'permissions'],
    'turn/start': ['sandboxPolicy', 'permissions'] });
  assert.deepEqual(table.model.api.carriers['turn/start'], ['model', 'effort']);
  assert.equal(table.model.api.carriers['thread/start'].includes('effort'), false);
  assert.equal(table['dynamic-tools-after-start'].kind, 'unsupported');
  assert.deepEqual(table.routing, { kind: 'unsupported', reason: 'Provider, endpoint and model mapping are owned by switchboard-me4l.' });
  for (const name of ['config-overrides', 'plugins-and-capability-roots', 'environments', 'opaque-events']) {
    assert.equal(table[name].api.qualification, 'passthrough-unqualified', name);
  }
});

test('broken controls: removing the conflict, combination or experimentalApi checks lets the bad request through', () => {
  const conflict = ['thread/start', { sandbox: 'danger-full-access' }, { sandbox: 'read-only' }, false];
  rejected(features.resolveCodexFeatures(...conflict), /conflicts/);
  assert.equal(noConflict.resolveCodexFeatures(...conflict).kind, 'ok');
  const gated = ['thread/start', { dynamicTools: [tool('a')] }, {}, false];
  rejected(features.resolveCodexFeatures(...gated), /experimentalApi/);
  assert.equal(noExperimental.resolveCodexFeatures(...gated).kind, 'ok');
  for (const chosen of [{ permissions: 'p' }, { approvalPolicy: { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true } } }]) {
    const request = ['turn/start', chosen, {}, false];
    rejected(features.resolveCodexFeatures(...request), /experimentalApi/);
    assert.equal(noPermissionGate.resolveCodexFeatures(...request).kind, 'ok');
  }
  const combined = ['turn/start', { permissions: 'p' }, { sandboxPolicy: { type: 'dangerFullAccess' } }, true];
  rejected(features.resolveCodexFeatures(...combined), /cannot combine/);
  assert.equal(noCombination.resolveCodexFeatures(...combined).kind, 'ok');
});
