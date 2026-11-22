import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      if (params.input.some((input) => input.type === 'image')) {
        const item = { type: 'userMessage', id: `image-${turnId}`, content: params.input };
        const frames = ['item/started', 'item/completed'].map((method) => `${JSON.stringify({ method, params: { threadId, turnId, item } })}\n`);
        queueMicrotask(() => f.sink.data(Buffer.from(frames.join(''))));
        appendFileSync(join(home, 'sessions', `rollout-${threadId}.jsonl`), `${JSON.stringify({ type: 'response_item', payload: item })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } })}\n`);
      }
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
  Object.assign(f, { handlers: answer, send, arm, finishTurn, pending });
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

test('a failed host answer is a failed tool observation carrying the error payload', async () => {
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
    assert.deepEqual(failedTool, { kind: 'tool', callId: pending.calls[0].pending.target.nativeToolCallId, name: toolName, phase: 'failed', resultJson: '{"text":"no"}' });
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

test('4 MiB images survive paired native echoes, history and direct resume', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow') }, signal);
    assert.equal(opened.kind, 'ok');
    const adapter = opened.value;
    assert.equal(adapter.capabilities.imageInput.kind, 'supported');
    const events = [];
    adapter.events.subscribe((event) => { events.push(event); });
    for (const mediaType of ['image/png', 'image/jpeg']) {
      const dataUrl = `data:${mediaType};base64,${Buffer.alloc(4194304).toString('base64')}`;
      const result = await adapter.run({ prompt: prompts.text, images: [{ mediaType, dataUrl }], signal,
        hostOperationId: mediaType, recordIntent: () => {} });
      assert.equal(result.kind, 'complete');
      const f = made.state.servers[0];
      const turn = f.params[f.sent.lastIndexOf('turn/start')];
      assert.deepEqual(turn.input[1], { type: 'image', url: dataUrl });
    }
    assert.equal(events.some((event) => event.kind === 'native-item'), false);
    const checkpoint = await adapter.capabilities.fingerprint.api.read(signal);
    assert.equal(checkpoint.kind, 'ok');
    const fingerprint = JSON.parse(checkpoint.value.opaque);
    assert(fingerprint[1] > 8 * 1024 * 1024);
    const complete = await adapter.run({ prompt: prompts.text, signal, hostOperationId: 'text', recordIntent: () => {} });
    await adapter.close();
    const resumed = await made.registration.open({ launch: made.launch('allow'), resume: { session: complete.session,
      expectedHistory: checkpoint.value } }, signal);
    assert.equal(resumed.kind, 'ok', JSON.stringify(resumed));
    const f = made.state.servers.at(-1);
    assert.equal(f.params[f.sent.indexOf('thread/resume')].excludeTurns, true);
    assert.equal((await resumed.value.run({ prompt: prompts.text, signal, hostOperationId: 'resume', recordIntent: () => {} })).kind, 'complete');
    await resumed.value.close();
  } finally { await made.dispose(); }
});

test('invalid image calls write nothing and never record intent', async () => {
  const made = subject();
  const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow') }, signal);
    const f = made.state.servers[0];
    const image = { mediaType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(4194305).toString('base64')}` };
    const before = f.sent.length;
    for (const images of [[image], null, {}, [{ mediaType: 'image/jpeg', dataUrl: 'data:image/png;base64,YQ==' }],
      [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YR==' }], Array(17).fill({ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' })]) {
      const result = await opened.value.run({ prompt: prompts.text, images, signal, hostOperationId: 'invalid-image',
        recordIntent: () => assert.fail('invalid images record no intent') });
      assert.equal(result.error.code, 'invalid-input');
      assert.equal(result.write.kind, 'not-attempted');
    }
    const escaped = await opened.value.run({ prompt: '\u0000'.repeat(180000), images: [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }],
      signal, hostOperationId: 'escaped', recordIntent: () => assert.fail('escaped frame exceeds text budget') });
    assert.equal(escaped.write.kind, 'not-attempted');
    assert.equal(f.sent.length, before);
    assert.equal((await opened.value.run({ prompt: prompts.text, images: [], signal, hostOperationId: 'empty', recordIntent: () => {} })).kind, 'complete');
    await opened.value.close();
  } finally { await made.dispose(); }
});

const tick = async (count = 3) => { for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve)); };
async function openHost(t, native = {}, options = {}) {
  const made = subject();
  const signal = AbortSignal.timeout(15000);
  const opened = await made.registration.open({ launch: made.launch('allow'), tools: [made.tool],
    environment: { ...made.environment, nativeConfig: { ...made.environment.nativeConfig, ...native } }, ...options }, signal);
  assert.equal(opened.kind, 'ok', JSON.stringify(opened));
  const adapter = opened.value;
  t.after(async () => { await adapter.close(); await made.dispose(); });
  return { made, signal, adapter, f: made.state.servers[0],
    run: (prompt = 'approval') => adapter.run({ prompt, signal, hostOperationId: randomUUID(), recordIntent: () => {} }),
    answer: (answers, recordIntent = () => {}) => adapter.continue({ answers, signal, hostOperationId: randomUUID(), recordIntent }) };
}
function approvalTurns(f, { mixed = false, file = false, offered = ['accept', 'cancel'] } = {}) {
  f.handlers['turn/start'] = (params, id) => {
    const turnId = randomUUID();
    const threadId = params.threadId;
    f.turnIdentity = { threadId, turnId };
    queueMicrotask(() => f.send({ id, result: { turn: { id: turnId, status: 'inProgress' } } }));
    f.arm(threadId, turnId, [
      ...(mixed ? [{ id: 'host-call', frame: { id: 'host-call', method: 'item/tool/call',
        params: { threadId, turnId, callId: 'tool-item', namespace: 'application', tool: toolName, arguments: { city: 'Paris' } } } }] : []),
      { id: 'approval-call', frame: { id: 'approval-call', method: file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'approval-item', reason: 'fixture',
          ...(file ? { grantRoot: '/fixture' } : { command: 'touch marker', cwd: '/fixture', availableDecisions: offered }) } } },
    ]);
    return { deferred: true };
  };
}
const approvalAnswer = (approval, nativeChoiceId = 'accept') => ({ formatVersion: 1, kind: 'approval', target: approval.target, nativeChoiceId });
const callAnswer = (call) => ({ formatVersion: 1, kind: 'tool', outcome: { target: call.pending.target,
  result: { kind: 'ok', value: { namespace: 'host', schemaVersion: 1, data: { text: 'done' } } },
  effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } });

test('direct settings reach start, resume and turns; invalid or routed overrides never spawn', async (t) => {
  const native = { approvalPolicy: 'on-request', approvalsReviewer: 'user', model: 'selected', effort: 'high' };
  const ctx = await openHost(t, native);
  const first = await ctx.run(prompts.text);
  const start = ctx.f.params[ctx.f.sent.indexOf('thread/start')];
  assert.equal(start.approvalPolicy, native.approvalPolicy);
  assert.equal(start.approvalsReviewer, native.approvalsReviewer);
  assert.equal(start.model, native.model);
  assert.equal(ctx.f.params[ctx.f.sent.indexOf('turn/start')].effort, 'high');
  await ctx.adapter.close();
  const opened = await ctx.made.registration.open({ launch: ctx.made.launch('allow'), tools: [ctx.made.tool],
    environment: { ...ctx.made.environment, nativeConfig: { ...ctx.made.environment.nativeConfig, ...native } },
    resume: { session: first.session } }, ctx.signal);
  assert.equal(opened.kind, 'ok');
  const f = ctx.made.state.servers.at(-1);
  assert.equal(f.params[f.sent.indexOf('thread/resume')].model, 'selected');
  assert.equal(f.params[f.sent.indexOf('thread/resume')].approvalsReviewer, 'user');
  await opened.value.run({ prompt: prompts.text, signal: ctx.signal, hostOperationId: 'resume-options', recordIntent: () => {} });
  assert.equal(f.params[f.sent.indexOf('turn/start')].effort, 'high');
  await opened.value.close();
  const route = { config: { kind: 'host-route', endpoint: 'http://127.0.0.1:12345', protocol: 'responses',
    credentialForm: 'none', credentialPurpose: 'host-route', principal: 'fixture', model: 'routed', resolve: async () => ({ kind: 'ok', value: { form: 'none' } }) },
    scope: { engine: 'codex', account: 'fixture', adapterInstanceId: 'fixture', sessionId: 'fixture' } };
  for (const [fields, routed] of [[{ approvalPolicy: 'granular' }, false], [{ approvalPolicy: {} }, false],
    [{ approvalsReviewer: 'unknown' }, false], [{ effort: '' }, false], [{ activity: true }, false],
    [{ approvalPolicy: 'on-request' }, true], [{ approvalsReviewer: 'user' }, true], [{ model: 'direct' }, true]]) {
    const before = ctx.made.state.attempts;
    const refused = await ctx.made.registration.open({ launch: ctx.made.launch('allow'), ...(routed ? { route } : {}),
      environment: { ...ctx.made.environment, nativeConfig: { ...ctx.made.environment.nativeConfig, ...fields } } }, ctx.signal);
    assert.equal(refused.error.code, 'invalid-input');
    assert.equal(ctx.made.state.attempts, before);
  }
});

test('approval-only pending is prompt, inspect matches and offered object decisions remain exact', async (t) => {
  const ctx = await openHost(t);
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'marker'] } };
  approvalTurns(ctx.f, { offered: ['accept', amendment, 'cancel'] });
  const start = Date.now();
  const result = await ctx.run();
  assert.equal(result.kind, 'pending');
  assert(Date.now() - start < 1000);
  assert.deepEqual(result.calls, []);
  assert.equal(result.approvals.length, 1);
  assert.deepEqual((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value,
    { calls: result.calls, approvals: result.approvals });
  const pending = result.approvals[0];
  assert.deepEqual(pending.choices.map((c) => c.nativeChoiceId), ['accept', 'acceptWithExecpolicyAmendment:1', 'cancel']);
  const before = ctx.f.replies.length;
  for (const answers of [[], [approvalAnswer(pending), approvalAnswer(pending)], [approvalAnswer(pending, 'decline')],
    [approvalAnswer({ ...pending, target: { ...pending.target, session: { ...pending.target.session, opaque: 'other' } } })]]) {
    assert.equal((await ctx.answer(answers, () => assert.fail('invalid answer recorded intent'))).write.kind, 'not-attempted');
  }
  assert.equal(ctx.f.replies.length, before);
  assert.equal((await ctx.answer([approvalAnswer(pending, 'acceptWithExecpolicyAmendment:1')])).kind, 'complete');
  assert.deepEqual(ctx.f.replies.find((r) => r.id === 'approval-call').result, { decision: amendment });
  assert.equal((await ctx.answer([approvalAnswer(pending)])).write.kind, 'not-attempted');
});

test('a mixed pending set requires complete coverage and rechecks it after intent', async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f, { mixed: true });
  const result = await ctx.run();
  assert.equal(result.calls.length, 1);
  assert.equal(result.approvals.length, 1);
  assert.equal((await ctx.answer([callAnswer(result.calls[0])])).write.kind, 'not-attempted');
  const answers = [callAnswer(result.calls[0]), approvalAnswer(result.approvals[0])];
  const changed = await ctx.answer(answers, async () => {
    ctx.f.request('new-approval', 'item/fileChange/requestApproval', { ...ctx.f.turnIdentity, itemId: 'new-item' });
    await tick();
  });
  assert.equal(changed.write.kind, 'not-dispatched');
  assert.equal(ctx.f.replies.length, 0);
  await ctx.adapter.interrupt({ timeoutMs: 1000 });
  await tick();
  assert.deepEqual((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value, { calls: [], approvals: [] });
});

for (const mixed of [false, true]) test(`held ${mixed ? 'mixed' : 'approval'} interrupt withdraws between segments`, async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f, { mixed });
  const events = [];
  ctx.adapter.events.subscribe((e) => { events.push(e); });
  const result = await ctx.run();
  const interrupted = await ctx.adapter.interrupt({ timeoutMs: 1000 });
  assert(['interrupted', 'terminal-observed'].includes(interrupted.kind));
  await tick();
  assert(ctx.f.sent.includes('turn/interrupt'));
  const settlements = events.filter((e) => e.kind === 'interaction-settled');
  assert.equal(settlements.length, mixed ? 2 : 1);
  for (const event of settlements) assert.deepEqual(event.settlement.data, { kind: 'withdrawn', by: 'turn/interrupt' });
  assert.deepEqual((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value, { calls: [], approvals: [] });
  assert.equal((await ctx.answer([approvalAnswer(result.approvals[0])])).write.kind, 'not-attempted');
});

test('held host tool interrupt works without an approval', async (t) => {
  const ctx = await openHost(t);
  const result = await ctx.run(prompts.toolCall);
  assert.equal(result.kind, 'pending');
  const events = [];
  ctx.adapter.events.subscribe((e) => { events.push(e); });
  await ctx.adapter.interrupt({ timeoutMs: 1000 });
  await tick();
  assert.equal(events.filter((e) => e.kind === 'interaction-settled').length, 1);
  assert.deepEqual((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value, { calls: [], approvals: [] });
});

test('late interrupt acknowledgement settles only its captured turn', async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f);
  const events = [];
  ctx.adapter.events.subscribe((e) => { events.push(e); });
  await ctx.run();
  let interruptId;
  ctx.f.handlers['turn/interrupt'] = (_, id) => { interruptId = id; return { deferred: true }; };
  assert.equal((await ctx.adapter.interrupt({ timeoutMs: 5 })).kind, 'unconfirmed-within-bound');
  assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length, 1);
  ctx.f.send({ id: interruptId, result: {} });
  await tick();
  assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length, 0);
  const original = events.filter((e) => e.kind === 'interaction-settled');
  assert.equal(original.length, 1);
  await ctx.run();
  assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length, 1);
  assert.equal(events.filter((e) => e.kind === 'interaction-settled').length, 1);
  ctx.f.handlers['turn/interrupt'] = () => ({});
  await ctx.adapter.interrupt({ timeoutMs: 1000 });
});

for (const cause of ['process-exit', 'eof', 'handler-timeout', 'serverRequest/resolved']) test(`between-segment ${cause} settles exactly once`, async (t) => {
  const ctx = await openHost(t, cause === 'handler-timeout' ? { handlerTimeoutMs: 60 } : {});
  approvalTurns(ctx.f);
  const result = await ctx.run();
  const events = [];
  ctx.adapter.events.subscribe((e) => { events.push(e); });
  if (cause === 'serverRequest/resolved') ctx.f.send({ method: cause, params: { ...ctx.f.turnIdentity, requestId: 'approval-call' } });
  else if (cause !== 'handler-timeout') ctx.f.sink.ended(cause);
  else await new Promise((resolve) => setTimeout(resolve, 100));
  await tick();
  const settlements = events.filter((e) => e.kind === 'interaction-settled');
  assert.equal(settlements.length, 1);
  assert.deepEqual(settlements[0].settlement.data, cause === 'serverRequest/resolved'
    ? { kind: 'withdrawn', by: cause } : { kind: 'lost', cause });
  assert.equal((await ctx.answer([approvalAnswer(result.approvals[0])])).write.kind, 'not-attempted');
});

test('interrupt rejection preserves bounded evidence and no approval decision', async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f);
  await ctx.run();
  ctx.f.handlers['turn/interrupt'] = () => ({ error: { code: -32001, message: '雪'.repeat(1000), data: { omitted: true } } });
  const result = await ctx.adapter.interrupt({ timeoutMs: 1000 });
  assert.equal(result.kind, 'unconfirmed-within-bound');
  assert.equal(result.evidence.data.code, -32001);
  assert.equal(result.evidence.data.truncated, true);
  assert(Buffer.byteLength(result.evidence.data.message) <= 2048);
  assert(!result.evidence.data.message.endsWith('\ufffd'));
  assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length, 1);
  // The execution shares the rejected interrupt for this turn. Finish explicitly for bounded test cleanup.
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

test('a batch interrupted after its first reply stays outcome-unknown', async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f, { mixed: true });
  const pending = await ctx.run();
  const controller = new AbortController();
  const result = await ctx.adapter.continue({ answers: [callAnswer(pending.calls[0]), approvalAnswer(pending.approvals[0])],
    signal: controller.signal, hostOperationId: 'partial', recordIntent: () => {},
    onObservation: (event) => { if (event.kind === 'tool' && event.phase === 'completed') controller.abort(); } });
  assert.equal(result.write.kind, 'outcome-unknown');
  await tick();
  assert.equal(ctx.f.replies.filter((r) => r.result).length, 1);
  await ctx.adapter.interrupt({ timeoutMs: 1000 });
});

test('withdrawal during intent preserves a not-dispatched result', async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f);
  const pending = await ctx.run();
  const result = await ctx.answer([approvalAnswer(pending.approvals[0])], async () => {
    ctx.f.send({ method: 'serverRequest/resolved', params: { ...ctx.f.turnIdentity, requestId: 'approval-call' } });
    await tick();
  });
  assert.equal(result.write.kind, 'not-dispatched');
  assert.equal(ctx.f.replies.some((r) => r.result?.decision), false);
});

test('close-before-loss retires event streams without requiring host pending cleanup events', async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f);
  const pending = await ctx.run();
  const hostPending = new Set(pending.approvals.map((a) => a.target.nativeApprovalId));
  const subscription = ctx.adapter.events.subscribe(() => {});
  const closing = ctx.adapter.close();
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
  await closing;
  hostPending.clear();
  assert.equal(hostPending.size, 0);
  assert.equal(await subscription.value.ended, 'closed');
});
