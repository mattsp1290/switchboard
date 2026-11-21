import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const src = new URL('../../../src/', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (!url.startsWith(src) || !url.endsWith('.ts')) return next(url, context);
  return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    shortCircuit: true };
} });
const { codexHostAdapter, CODEX_HOST_NATIVE_VERSION } = await import(new URL('adapters/codex/index.ts', src).href);
const { checkCodexHostRoute, codexHostRoutePrincipal, copyCodexHostRoute } = await import(new URL('adapters/codex/route.ts', src).href);
const { hostAdapterContracts } = await import(new URL('testkit/host-contracts.ts', src).href);
hook.deregister();

const usage = { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 };
const toolName = 'lookup';
const prompts = { text: 'say hello', toolCall: 'call the tool', twoToolCalls: 'call the tool twice', ask: 'ask the user' };

function routeOf(endpoint, extra = {}) {
  return { kind: 'host-route', providerId: 'host', endpoint, protocol: 'responses', credentialForm: 'none', principal: 'crew',
    loopbackRelay: true, model: 'gpt', scope: { engine: 'codex', account: 'acct' }, sqliteHome: '/codex-host-index',
    logDir: '/codex-host-logs', ...extra };
}

test('a loopback relay keeps one principal when only the port changes', () => {
  const first = copyCodexHostRoute(routeOf('http://127.0.0.1:4000/'));
  const second = copyCodexHostRoute(routeOf('http://127.0.0.1:4001/'));
  assert.ok(first && second);
  assert.equal(codexHostRoutePrincipal(first), codexHostRoutePrincipal(second));
  const left = copyCodexHostRoute(routeOf('http://127.0.0.1:4000/', { loopbackRelay: false, credentialForm: 'bearer', envKey: 'TOKEN' }));
  const right = copyCodexHostRoute(routeOf('http://127.0.0.1:4001/', { loopbackRelay: false, credentialForm: 'bearer', envKey: 'TOKEN' }));
  assert.ok(left && right);
  assert.notEqual(codexHostRoutePrincipal(left), codexHostRoutePrincipal(right));
  assert.equal(codexHostRoutePrincipal(first).startsWith('host-route:sha256:'), true);
});

test('bearer and no-auth endpoints follow the host rules', () => {
  assert.equal('problem' in checkCodexHostRoute(routeOf('http://127.0.0.1:9')), true);
  assert.equal('route' in checkCodexHostRoute(routeOf('http://127.0.0.1:9/')), true);
  assert.equal('problem' in checkCodexHostRoute(routeOf('https://chatgpt.com/backend-api/codex')), true);
  const subscription = checkCodexHostRoute(routeOf('https://chatgpt.com/backend-api/codex', {
    credentialForm: 'bearer', loopbackRelay: false, envKey: 'BIRBCREW_CODEX_BEARER',
    headerEnv: { 'ChatGPT-Account-Id': 'BIRBCREW_CODEX_ACCOUNT' } }));
  assert.equal('route' in subscription, true);
  assert.equal('problem' in checkCodexHostRoute(routeOf('https://chatgpt.com/backend-api/codex', { credentialForm: 'bearer', envKey: 'TOKEN' })), true);
});

test('the recorded Crew options are admitted host routes', () => {
  const recorded = JSON.parse(readFileSync(new URL('../../qualification/codex-host-crew-options.json', import.meta.url), 'utf8'));
  for (const form of Object.values(recorded.forms)) {
    const checked = checkCodexHostRoute({ ...form, scope: { engine: 'codex', account: 'crew' }, ...recorded.storage });
    assert.equal('route' in checked, true, JSON.stringify(checked));
  }
  assert.equal(recorded.approvalPolicy, 'never');
  assert.equal(recorded.sandbox, 'read-only');
});

function fakeServer(home, tool) {
  const f = { sent: [], replies: [], params: [], raw: [], problems: [] };
  let exit = () => {};
  f.processExit = new Promise((resolve) => { exit = resolve; });
  const send = (value) => { if (f.sink && !f.gone) f.sink.data(Buffer.from(`${JSON.stringify(value)}\n`)); };
  const pending = new Map();
  const finishTurn = (threadId, turnId) => {
    send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 1000 } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null } } });
  };
  const arm = (threadId, turnId, calls) => {
    for (const call of calls) pending.set(call.id, { threadId, turnId, itemId: call.frame.params.callId ?? call.frame.params.itemId });
    queueMicrotask(() => { for (const call of calls) send(call.frame); });
  };
  const answer = {
    initialize: () => ({ codexHome: home, userAgent: 'fake/0.169.0' }),
    'config/read': () => ({ config: { sqlite_home: '/codex-host-index', log_dir: '/codex-host-logs',
      features: { shell_tool: false, unified_exec: false, shell_snapshot: false, view_image: false, request_user_input: false, default_mode_request_user_input: false,
        multi_agent: false, multi_agent_v2: false } } }),
    'account/read': () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: false }),
    'thread/start': () => {
      const id = randomUUID();
      writeFileSync(join(home, 'sessions', `rollout-${id}.jsonl`), `${JSON.stringify({ threadId: id })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-stable' } })}\n`);
      return { thread: { id, historyMode: 'paginated', ephemeral: false, modelProvider: 'openai', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' } };
    },
    'thread/read': ({ threadId }) => ({ thread: { id: threadId, historyMode: 'paginated', modelProvider: 'openai', status: { type: 'notLoaded' } } }),
    'thread/resume': ({ threadId }) => ({ thread: { id: threadId, historyMode: 'paginated', ephemeral: false, modelProvider: 'openai', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' } }),
    'turn/start': (params, id) => {
      const turnId = randomUUID();
      const text = params.input?.[0]?.text;
      const threadId = params.threadId;
      queueMicrotask(() => send({ id, result: { turn: { id: turnId, status: 'inProgress' } } }));
      if (text === prompts.toolCall) {
        arm(threadId, turnId, [{ id: `call-${turnId}`, frame: { id: `call-${turnId}`, method: 'item/tool/call', params: { threadId, turnId, callId: 'call-1', namespace: 'application', tool, arguments: { city: 'Paris' } } } }]);
      } else if (text === prompts.twoToolCalls) {
        arm(threadId, turnId, ['call-1', 'call-2'].map((callId) => ({ id: `${callId}-${turnId}`, frame: { id: `${callId}-${turnId}`, method: 'item/tool/call', params: { threadId, turnId, callId, namespace: 'application', tool, arguments: { city: 'Paris' } } } })));
      } else if (text === prompts.ask) {
        arm(threadId, turnId, [{ id: `ask-${turnId}`, frame: { id: `ask-${turnId}`, method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'question-1', questions: [{ id: 'q1', prompt: 'Go?' }] } } }]);
      } else {
        queueMicrotask(() => {
          // Pinned 0.169.0 ServerNotification names `item/reasoning/textDelta` { itemId, delta }; `ThreadItem` has no separate reasoning-text item to classify.
          send({ method: 'item/reasoning/textDelta', params: { threadId, turnId, itemId: 'think-1', delta: 'hmm', contentIndex: 0 } });
          send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: 'think-1', delta: 'sum', summaryIndex: 1 } });
          send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item-1', delta: 'hello' } });
          finishTurn(threadId, turnId);
        });
      }
      return { deferred: true };
    },
    'turn/interrupt': () => ({}),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  };
  f.channel = {
    listen(sink) { f.sink = sink; return () => { f.gone = true; exit(); }; },
    write(bytes) {
      const text = Buffer.from(bytes).toString();
      f.raw.push(text);
      let message;
      try { message = JSON.parse(text); } catch (error) { f.problems.push(String(error)); return Promise.resolve(); }
      if (message.method === undefined) {
        f.replies.push(message);
        const hit = pending.get(message.id);
        if (hit) {
          pending.delete(message.id);
          queueMicrotask(() => {
            send({ method: 'item/completed', params: { threadId: hit.threadId, turnId: hit.turnId, item: { id: hit.itemId, type: 'dynamicToolCall' } } });
            if (![...pending.values()].some((item) => item.turnId === hit.turnId)) finishTurn(hit.threadId, hit.turnId);
          });
        }
        return Promise.resolve();
      }
      f.sent.push(message.method);
      f.params.push(message.params);
      if (message.id === undefined) return Promise.resolve();
      const value = answer[message.method]?.(message.params, message.id);
      if (value?.deferred) return Promise.resolve();
      const body = value?.error ? { id: message.id, error: value.error } : { id: message.id, result: value ?? {} };
      queueMicrotask(() => send(body));
      return Promise.resolve();
    },
  };
  f.request = (id, method, params) => send({ id, method, params });
  return f;
}

function subject() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-host-')));
  mkdirSync(join(home, 'sessions'));
  const sentinel = 'LEAK-SENTINEL-config';
  for (const name of ['config.toml', 'auth.json', 'AGENTS.md']) writeFileSync(join(home, name), sentinel);
  const state = { attempts: 0, signals: 0, spawned: [], servers: [] };
  const environment = { variables: { PATH: '/usr/bin' }, nativeConfig: { home, cwd: home, executable: '/usr/bin/codex', sandbox: 'read-only' } };
  return { home, sentinel, state, environment,
    registration: { identity: codexHostAdapter.identity, open: (options, signal) => codexHostAdapter.open({ environment, ...options }, signal) },
    launch(mode) {
      return { kind: 'spawn', spawn: (request) => {
        state.attempts += 1;
        state.spawned.push(request);
        if (mode === 'deny') throw new Error('denied');
        const server = fakeServer(home, toolName);
        state.servers.push(server);
        return { channel: server.channel, processExit: server.processExit };
      } };
    },
    launches: () => ({ attempts: state.attempts, signals: state.signals }),
    tool: { name: toolName, description: 'Look up a city', inputSchema: { type: 'object' } },
    prompts, async dispose() { rmSync(home, { recursive: true, force: true }); } };
}

test('the Codex host adapter satisfies the host contract', async () => {
  assert.equal(CODEX_HOST_NATIVE_VERSION, '0.169.0');
  const signal = AbortSignal.timeout(20000);
  for (const name of ['segments', 'interaction', 'history', 'interrupt', 'host-launcher']) {
    await hostAdapterContracts[name](subject, signal);
  }
});

test('ambient files and a patch attempt do not reach the model', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool] }, signal);
    assert.equal(opened.kind, 'ok', JSON.stringify({ opened, raw: made.state.servers.at(-1)?.raw, sent: made.state.servers.at(-1)?.sent, problems: made.state.servers.at(-1)?.problems }));
    const adapter = opened.value;
    await adapter.run({ prompt: prompts.text, signal, hostOperationId: 'ambient', recordIntent: () => {} });
    const request = made.state.spawned[0];
    const encoded = JSON.stringify(request);
    assert.equal(encoded.includes(made.sentinel), false);
    assert.deepEqual(request.env, { PATH: '/usr/bin' });
    assert.equal(request.args.includes('features.shell_tool=false'), true);
    assert.equal(request.args.includes('features.view_image=false'), true);
    const thread = made.state.servers[0].params.find((params) => params?.sandbox === 'read-only');
    assert.equal(thread.sandbox, 'read-only');
    assert.equal(thread.approvalPolicy, 'never');
    assert.equal(JSON.stringify(made.state.servers[0].params).includes(made.sentinel), false);
    made.state.servers[0].request('patch-1', 'applyPatchApproval', { threadId: 'none' });
    await new Promise((resolve) => setImmediate(resolve));
    const reply = made.state.servers[0].replies.find((item) => item.id === 'patch-1');
    assert.equal(reply.error.code, -32601);
    await adapter.close();
  } finally { await made.dispose(); }
});

test('request_user_input is answered with the host answers object', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool], builtInTools: ['request_user_input'] }, signal);
    assert.equal(opened.kind, 'ok', JSON.stringify(opened));
    const pending = await opened.value.run({ prompt: prompts.ask, signal, hostOperationId: 'ask', recordIntent: () => {} });
    assert.equal(pending.kind, 'pending', JSON.stringify(pending));
    const answers = { q1: { answers: ['yes'] } };
    const continued = await opened.value.continue({ answers: [{ formatVersion: 1, kind: 'tool', outcome: { target: pending.calls[0].pending.target,
      result: { kind: 'ok', value: { namespace: 'host', schemaVersion: 1, data: { answers } } }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } }],
    signal, hostOperationId: 'answer', recordIntent: () => {} });
    assert.equal(continued.kind, 'complete', JSON.stringify({ continued, replies: made.state.servers[0].replies, sent: made.state.servers[0].sent }));
    const reply = made.state.servers[0].replies.find((item) => item.result?.answers);
    assert.deepEqual(reply.result.answers, answers);
    await opened.value.close();
  } finally { await made.dispose(); }
});

test('close keeps the tool declaration, so a different resume is refused before thread/resume', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool] }, signal);
    assert.equal(opened.kind, 'ok', JSON.stringify(opened));
    const ran = await opened.value.run({ prompt: prompts.text, signal, hostOperationId: 'first', recordIntent: () => {} });
    assert.equal(ran.kind, 'complete', JSON.stringify(ran));
    await opened.value.close();
    const same = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool], resume: { session: ran.session } }, signal);
    assert.equal(same.kind, 'ok', JSON.stringify({ same, sent: made.state.servers.at(-1)?.sent }));
    await same.value.close();
    const again = await made.registration.open({ launch: made.launch('allow'),
      tools: [{ name: 'other', description: 'different', inputSchema: { type: 'object' } }],
      resume: { session: ran.session } }, signal);
    assert.equal(again.kind, 'error');
    assert.equal(again.error.code, 'invalid-input');
    assert.equal(made.state.servers.at(-1).sent.includes('thread/resume'), false);
  } finally { await made.dispose(); }
});

test('a continue whose second answer has no native body writes nothing', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool] }, signal);
    assert.equal(opened.kind, 'ok', JSON.stringify(opened));
    const pending = await opened.value.run({ prompt: prompts.twoToolCalls, signal, hostOperationId: 'two', recordIntent: () => {} });
    assert.equal(pending.kind, 'pending', JSON.stringify(pending));
    const answer = (call, data) => ({ formatVersion: 1, kind: 'tool', outcome: { target: call.pending.target,
      result: { kind: 'ok', value: { namespace: 'host', schemaVersion: 1, data } },
      effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } });
    const continued = await opened.value.continue({ answers: [answer(pending.calls[0], { text: 'one' }), answer(pending.calls[1], { nope: true })],
      signal, hostOperationId: 'bad-body', recordIntent: () => {} });
    assert.equal(continued.kind, 'failed', JSON.stringify(continued));
    assert.equal(continued.error.code, 'invalid-input');
    assert.deepEqual(continued.write, { kind: 'not-attempted' });
    assert.equal(made.state.servers[0].replies.some((item) => item.result?.contentItems), false);
    await opened.value.close();
  } finally { await made.dispose(); }
});

test('a host that cannot run a helper is unavailable and launches nothing', async () => {
  const made = subject();
  let attempts = 0;
  const signal = AbortSignal.timeout(5000);
  try {
    const opened = await codexHostAdapter.open({
      launch: { kind: 'spawn', spawn: () => { attempts += 1; throw new Error('launched'); } },
      environment: { variables: { PATH: '/usr/bin' }, nativeConfig: { ...made.environment.nativeConfig, helper: 'unavailable' } },
      route: { config: { kind: 'host-route', credentialForm: 'helper', endpoint: 'http://127.0.0.1:9/v1', protocol: 'responses', principal: 'p', model: 'm' },
        scope: { engine: 'codex', account: 'a', sessionId: 's', adapterInstanceId: 'codex-host' } },
    }, signal);
    assert.equal(opened.kind, 'error');
    assert.equal(opened.error.code, 'unavailable');
    assert.equal(opened.error.feature, 'helper');
    assert.equal(attempts, 0);
  } finally { await made.dispose(); }
});

const toolAnswer = (target, result) => ({ formatVersion: 1, kind: 'tool', outcome: { target, result, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } });
const unsupported = ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents'];

test('a listener receives the observations of a text segment, a pending segment, and its continuation', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool] }, signal);
    assert.equal(opened.kind, 'ok', JSON.stringify(opened));
    const adapter = opened.value;
    const text = [];
    const complete = await adapter.run({ prompt: prompts.text, signal, hostOperationId: 'text', recordIntent: () => {}, onObservation: (o) => text.push(o) });
    assert.equal(complete.kind, 'complete');
    assert.equal(text[0].kind, 'run-started');
    assert.deepEqual(text.filter((o) => o.kind === 'unsupported').map((o) => o.family), unsupported);
    assert.deepEqual(text.find((o) => o.kind === 'text'), { kind: 'text', messageId: 'item-1', mode: 'delta', text: 'hello' });
    assert.deepEqual(text.find((o) => o.kind === 'reasoning'), { kind: 'reasoning', messageId: 'think-1:text', mode: 'delta', text: 'hmm' });
    assert.deepEqual(text.find((o) => o.kind === 'reasoning' && o.messageId.includes('summary')),
      { kind: 'reasoning', messageId: 'think-1:summary:1', mode: 'delta', text: 'sum' });
    assert.deepEqual(text.find((o) => o.kind === 'usage'), { kind: 'usage', rows: [{ inputTokens: 2, outputTokens: 1, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, reasoningTokens: 0, totalTokens: 3 }] });
    assert.equal(text.some((o) => o.kind === 'model-boundary'), false);
    assert.deepEqual(text.at(-1), { kind: 'terminal', outcome: 'success' });
    assert.equal(text.filter((o) => o.kind === 'terminal').length, 1);

    const run = [];
    const pending = await adapter.run({ prompt: prompts.toolCall, signal, hostOperationId: 'tool', recordIntent: () => {}, onObservation: (o) => run.push(o) });
    assert.equal(pending.kind, 'pending', JSON.stringify(pending));
    const callId = pending.calls[0].pending.target.nativeToolCallId;
    assert.deepEqual(run.filter((o) => o.kind === 'tool'), [
      { kind: 'tool', callId, name: toolName, phase: 'started' },
      { kind: 'tool', callId, name: toolName, phase: 'arguments-ended', argumentsJson: '{"city":"Paris"}' }]);
    assert.deepEqual(run.at(-1), { kind: 'terminal', outcome: 'success', pendingTools: [callId] });

    const next = [];
    const done = await adapter.continue({ answers: [toolAnswer(pending.calls[0].pending.target, { kind: 'ok', value: { namespace: 'host', schemaVersion: 1, data: { text: 'sunny' } } })],
      signal, hostOperationId: 'answer', recordIntent: () => {}, onObservation: (o) => next.push(o) });
    assert.equal(done.kind, 'complete', JSON.stringify(done));
    assert.equal(next[0].kind, 'run-started');
    assert.deepEqual(next.filter((o) => o.kind === 'tool'), [
      { kind: 'tool', callId, name: toolName, phase: 'started' },
      { kind: 'tool', callId, name: toolName, phase: 'arguments-ended', argumentsJson: '{"city":"Paris"}' },
      { kind: 'tool', callId, name: toolName, phase: 'completed', resultJson: '{"text":"sunny"}' }]);
    assert.deepEqual(next.at(-1), { kind: 'terminal', outcome: 'success' });
    await adapter.close();
  } finally { await made.dispose(); }
});

test('a failed host answer is a failed tool observation without resultJson', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool] }, signal);
    const adapter = opened.value;
    const pending = await adapter.run({ prompt: prompts.toolCall, signal, hostOperationId: 'tool', recordIntent: () => {} });
    assert.equal(pending.kind, 'pending', JSON.stringify(pending));
    const seen = [];
    const done = await adapter.continue({ answers: [toolAnswer(pending.calls[0].pending.target, { kind: 'error', error: { namespace: 'host', schemaVersion: 1, data: { text: 'no' } } })],
      signal, hostOperationId: 'answer', recordIntent: () => {}, onObservation: (o) => seen.push(o) });
    assert.equal(done.kind, 'complete', JSON.stringify(done));
    const failedTool = seen.find((o) => o.kind === 'tool' && o.phase === 'failed');
    assert.deepEqual(failedTool, { kind: 'tool', callId: pending.calls[0].pending.target.nativeToolCallId, name: toolName, phase: 'failed' });
    await adapter.close();
  } finally { await made.dispose(); }
});

test('a throwing or invalid listener does not change a segment', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool] }, signal);
    const adapter = opened.value;
    const events = [];
    adapter.events.subscribe((event) => events.push(event.kind));
    const result = await adapter.run({ prompt: prompts.text, signal, hostOperationId: 'throws', recordIntent: () => {}, onObservation: () => { throw new Error('boom'); } });
    assert.equal(result.kind, 'complete');
    assert.equal(result.text, 'hello');
    assert.equal(events.includes('text-delta'), true);
    const intents = [];
    const invalid = await adapter.run({ prompt: prompts.text, signal, hostOperationId: 'invalid', recordIntent: (i) => intents.push(i), onObservation: 'nope' });
    assert.equal(invalid.kind, 'failed');
    assert.equal(invalid.error.code, 'invalid-input');
    assert.equal(invalid.write.kind, 'not-attempted');
    assert.equal(intents.length, 0);
    await adapter.close();
  } finally { await made.dispose(); }
});
