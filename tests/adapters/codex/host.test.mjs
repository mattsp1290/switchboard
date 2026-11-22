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
const { codexNativeError, createCodexErrorIntake } = await import(new URL('adapters/codex/native-errors.ts', src).href);
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
  f.attestExit = () => exit();
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
      f.turnIdentity = { threadId, turnId };
      if (params.input.some((input) => input.type === 'image')) {
        const item = { type: 'userMessage', id: `image-${turnId}`, content: params.input, metadata: f.echoMetadata };
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
    listen(sink) { f.sink = sink; return () => { f.gone = true; }; },
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
          f.onReply?.(message, hit);
          queueMicrotask(() => {
            send({ method: 'item/completed', params: { threadId: hit.threadId, turnId: hit.turnId, item: { id: hit.itemId, type: 'dynamicToolCall' } } });
            if (f.autoFinish !== false && ![...pending.values()].some((item) => item.turnId === hit.turnId)) finishTurn(hit.threadId, hit.turnId);
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

function subject(configure = () => {}) {
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
        configure(server);
        state.servers.push(server);
        return { channel: server.channel, processExit: server.processExit };
      } };
    },
    launches: () => ({ attempts: state.attempts, signals: state.signals }),
    nativeRequests: () => state.servers.reduce((count, server) => count + server.raw.length, 0),
    heldTurn: { interruptRequests: () => state.servers.reduce((count, server) => count + server.sent.filter((method) => method === 'turn/interrupt').length, 0) },
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
    environment: { ...made.environment, nativeConfig: { ...made.environment.nativeConfig, approvalPolicy: 'on-request', ...native } }, ...options }, signal);
  assert.equal(opened.kind, 'ok', JSON.stringify(opened));
  const adapter = opened.value;
  t.after(async () => { await adapter.close(); await made.dispose(); });
  return { made, signal, adapter, f: made.state.servers[0],
    run: (prompt = 'approval') => adapter.run({ prompt, signal, hostOperationId: randomUUID(), recordIntent: () => {} }),
    answer: (answers, recordIntent = () => {}) => adapter.continue({ answers, signal, hostOperationId: randomUUID(), recordIntent }) };
}
async function blockWriterBehindList(ctx) {
  const original = ctx.f.channel.write.bind(ctx.f.channel);
  const gate = Promise.withResolvers();
  ctx.f.handlers['model/list'] = () => ({ data: [], nextCursor: null });
  ctx.f.channel.write = (bytes) => { const message = JSON.parse(Buffer.from(bytes)); const written = original(bytes); return message.method === 'model/list' ? gate.promise : written; };
  await ctx.adapter.capabilities.models.api.list(ctx.signal);
  await tick();
  return gate.resolve;
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

test('aborting from a sent tool observation leaves the actual prefix outcome unknown', async (t) => {
  const ctx = await openHost(t);
  const pending = await ctx.run(prompts.toolCall);
  ctx.f.autoFinish = false;
  const controller = new AbortController();
  const result = await ctx.adapter.continue({ answers: [callAnswer(pending.calls[0])],
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
  assert.equal(pending.kind, 'pending');
  const settlements = [];
  const subscription = ctx.adapter.events.subscribe((event) => { if (event.kind === 'interaction-settled') settlements.push(event); });
  const closing = ctx.adapter.close();
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
  assert.equal((await closing).kind, 'ok');
  assert.equal(await subscription.value.ended, 'closed');
  assert(settlements.every((event) => event.target.nativeApprovalId === pending.approvals[0].target.nativeApprovalId));
});

for (const decision of ['accept', 'cancel']) test(`file-change ${decision} correlates public activity and the approval target`, async (t) => {
  const ctx = await openHost(t, { activity: 'items', approvalPolicy: 'on-request' });
  approvalTurns(ctx.f, { file: true });
  const original = ctx.f.handlers['turn/start'];
  const changes = [{ path: '/fixture/file.txt', kind: { type: 'update', move_path: null }, diff: '-old\n+new' }];
  ctx.f.handlers['turn/start'] = (params, id) => {
    const result = original(params, id);
    queueMicrotask(() => ctx.f.send({ method: 'item/started', params: { ...ctx.f.turnIdentity,
      item: { id: 'approval-item', type: 'fileChange', changes, status: 'inProgress' } } }));
    return result;
  };
  ctx.f.onReply = (reply) => {
    if (reply.id === 'approval-call') ctx.f.send({ method: 'item/completed', params: { ...ctx.f.turnIdentity,
      item: { id: 'approval-item', type: 'fileChange', changes, status: decision === 'accept' ? 'completed' : 'declined' } } });
  };
  const events = [];
  ctx.adapter.events.subscribe((e) => { events.push(e); });
  const pending = await ctx.run();
  await tick();
  const item = events.find((e) => e.kind === 'native-item' && e.item.data.method === 'item/started').item.data.params.item;
  assert.equal(pending.approvals[0].target.tool.nativeToolCallId, item.id);
  assert.deepEqual(item.changes, changes);
  assert.deepEqual(pending.approvals[0].choices.map((c) => c.nativeChoiceId), ['accept', 'acceptForSession', 'decline', 'cancel']);
  assert.equal((await ctx.answer([approvalAnswer(pending.approvals[0], decision)])).kind, 'complete');
  await tick();
  assert.equal(ctx.f.replies.find((r) => r.id === 'approval-call').result.decision, decision);
  assert.equal(events.find((e) => e.kind === 'native-item' && e.item.data.method === 'item/completed').item.data.params.item.status,
    decision === 'accept' ? 'completed' : 'declined');
});

test('activity crosses segment boundaries exactly once and excludes other threads and user echoes', async (t) => {
  const ctx = await openHost(t, { activity: 'items' });
  const identities = [];
  for (let i = 0; i < 3; i++) { await ctx.run(prompts.text); identities.push(ctx.f.turnIdentity); }
  const events = [];
  ctx.adapter.events.subscribe((e) => { events.push(e); });
  const methods = ['item/started', 'item/completed', 'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated'];
  for (const [index, identity] of identities.entries()) {
    for (const method of methods) ctx.f.send({ method, params: { ...identity, itemId: `item-${index}`, delta: 'output',
      changes: [{ path: '/fixture/f', kind: { type: 'add' }, diff: '+line' }],
      item: { type: index === 1 ? 'fileChange' : 'commandExecution', id: `item-${index}`, status: index === 1 ? 'failed' : 'completed' } } });
  }
  const identity = identities[0];
  for (const params of [{ ...identity, threadId: randomUUID(), item: { type: 'commandExecution' } },
    { ...identity, item: { type: 'userMessage', content: [{ type: 'image', url: 'not-forwarded' }] } }]) ctx.f.send({ method: 'item/completed', params });
  ctx.f.send({ method: 'item/commandExecution/outputDelta', params: identity });
  ctx.f.send({ method: 'item/reasoning/textDelta', params: { ...identity, itemId: 'reason', delta: 'hidden' } });
  await tick(8);
  const items = events.filter((e) => e.kind === 'native-item');
  assert.equal(items.length, 12);
  assert(items.every((e) => e.item.namespace === 'codex-app-server/item'));
  for (const method of methods) assert.equal(items.filter((e) => e.item.data.method === method).length, 3);
});

test('activity overflow retires only the lagging observer', async (t) => {
  const ctx = await openHost(t, { activity: 'items' });
  await ctx.run(prompts.text);
  const stuck = ctx.adapter.events.subscribe(() => new Promise(() => {}));
  const items = [];
  ctx.adapter.events.subscribe((e) => { if (e.kind === 'native-item') items.push(e); });
  for (let i = 0; i < 65; i++) {
    ctx.f.send({ method: 'item/commandExecution/outputDelta', params: { ...ctx.f.turnIdentity, itemId: `c-${i}`, delta: 'x' } });
    await tick();
  }
  assert.equal(await stuck.value.ended, 'overflow');
  assert.equal(items.length, 65);
});

function failTurn(f, { rpc, terminal, notification, beforeAck = false, noTerminal = false, retry = false } = {}) {
  f.handlers['turn/start'] = (params, id) => {
    if (rpc) return { error: rpc };
    const turnId = randomUUID();
    const identity = { threadId: params.threadId, turnId };
    f.turnIdentity = identity;
    queueMicrotask(() => {
      const notify = () => { if (notification) f.send({ method: 'error', params: { ...identity, error: notification, willRetry: retry } }); };
      if (beforeAck) notify();
      f.send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
      if (!beforeAck) notify();
      if (!noTerminal) f.send({ method: 'turn/completed', params: { threadId: identity.threadId, turn: { id: turnId, status: 'failed', error: terminal ?? null } } });
    });
    return { deferred: true };
  };
}

test('native failure causes preserve their source without changing generic errors or write certainty', async (t) => {
  const ctx = await openHost(t);
  const error = { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: 'omitted', misalignment: 'omitted' };
  for (const [config, source, code, info] of [
    [{ rpc: { code: -32600, message: 'bad input', data: { secret: 'omitted' } } }, 'turn/start-reply', -32600, null],
    [{ terminal: error }, 'turn.error', null, 'usageLimitExceeded'],
    [{ notification: error, beforeAck: true }, 'error-notification', null, 'usageLimitExceeded'],
    [{ notification: error, retry: true }, undefined, undefined, undefined],
  ]) {
    failTurn(ctx.f, config);
    const result = await ctx.run('fail');
    assert.equal(result.kind, 'failed');
    assert.equal(result.write.kind, 'accepted');
    assert.equal(result.error.code, 'native-failure');
    assert.equal(result.nativeError?.source, source);
    assert.equal(result.nativeError?.code, code);
    assert.equal(result.nativeError?.info, info);
    if (result.nativeError) assert.deepEqual(Object.keys(result.nativeError).sort(), ['code', 'info', 'message', 'source', 'truncated']);
  }
});

for (const ending of ['abort', 'process-loss']) test(`matching nonretry error survives ${ending} without a native terminal`, async (t) => {
  const ctx = await openHost(t);
  failTurn(ctx.f, { notification: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }, beforeAck: true, noTerminal: true });
  const controller = new AbortController();
  const running = ctx.adapter.run({ prompt: 'fail', hostOperationId: ending, signal: controller.signal, recordIntent: () => {} });
  while (!ctx.f.turnIdentity) await tick();
  await tick();
  if (ending === 'abort') controller.abort(); else ctx.f.sink.ended('eof');
  const result = await running;
  assert.equal(result.nativeError.source, 'error-notification');
  assert.equal(result.nativeError.info, 'usageLimitExceeded');
  if (ending === 'abort') {
    assert.equal(result.write.kind, 'accepted');
    ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
  }
});

test('old-turn and retryable error evidence never contaminates a new dispatch', async (t) => {
  const ctx = await openHost(t);
  await ctx.run(prompts.text);
  const previous = ctx.f.turnIdentity;
  failTurn(ctx.f, { noTerminal: true });
  const running = ctx.run('new');
  await tick();
  ctx.f.send({ method: 'error', params: { ...previous, willRetry: false, error: { message: 'old' } } });
  ctx.f.send({ method: 'error', params: { ...ctx.f.turnIdentity, willRetry: true, error: { message: 'retry' } } });
  ctx.f.send({ method: 'turn/completed', params: { threadId: previous.threadId, turn: { id: ctx.f.turnIdentity.turnId, status: 'failed', error: null } } });
  assert.equal((await running).nativeError, undefined);
});

test('error mapping bounds Unicode and info, and identity staging stays bounded and total', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const codexErrorInfo of [cyclic, Symbol('unsupported'), 'x'.repeat(1025)]) {
    const result = codexNativeError('turn.error', { message: '雪'.repeat(1000), codexErrorInfo, additionalDetails: 'omit' });
    assert.equal(result.truncated, true);
    assert.equal(result.info, null);
    assert.equal(Buffer.byteLength(result.message), 2046);
    assert(!result.message.includes('\ufffd'));
  }
  const intake = createCodexErrorIntake();
  intake.begin();
  for (let i = 0; i < 9; i++) intake.notification({ threadId: 'thread', turnId: `t${i}`, willRetry: false, error: { message: `m${i}` } }, 'thread');
  assert.equal(intake.current(), undefined);
  intake.accepted('t8');
  assert.equal(intake.current(), undefined, 'overflow never attaches another turn cause');
  intake.begin();
  intake.notification({ threadId: 'thread', turnId: 'current', willRetry: false, error: { message: 'first' } }, 'thread');
  intake.notification({ threadId: 'thread', turnId: 'current', willRetry: false, error: { message: 'latest' } }, 'thread');
  intake.accepted('current');
  assert.equal(intake.current().message, 'latest');
});

const catalogModel = (name) => ({ model: name, displayName: name, hidden: false, isDefault: false, inputModalities: ['text', 'image'], extra: 'omitted' });
test('model listing is sessionless, follows pages and keeps exactly native metadata', async (t) => {
  const ctx = await openHost(t);
  ctx.f.handlers['model/list'] = () => ({ data: [], nextCursor: null });
  assert.deepEqual(await ctx.adapter.capabilities.models.api.list(ctx.signal), { kind: 'ok', value: [] });
  const pages = [{ data: [catalogModel('a')], nextCursor: 'b' }, { data: [], nextCursor: 'c' }, { data: [catalogModel('z')], nextCursor: null }];
  ctx.f.handlers['model/list'] = () => pages.shift();
  const result = await ctx.adapter.capabilities.models.api.list(ctx.signal);
  assert.deepEqual(result.value.map((m) => m.model), ['a', 'z']);
  assert.equal(Object.hasOwn(result.value[0], 'extra'), false);
  assert(Object.isFrozen(result.value) && Object.isFrozen(result.value[0].inputModalities));
  assert.equal(ctx.f.sent.includes('thread/start'), false);
  const requests = ctx.f.params.filter((_, index) => ctx.f.sent[index] === 'model/list');
  assert.deepEqual(requests, [{ includeHidden: true }, { includeHidden: true }, { includeHidden: true, cursor: 'b' }, { includeHidden: true, cursor: 'c' }]);
});

for (const kind of ['repeat', 'ninth', 'malformed', 'modality', 'over-limit', 'rpc']) test(`model listing refuses ${kind} without partial success`, async (t) => {
  const ctx = await openHost(t);
  let page = 0;
  ctx.f.handlers['model/list'] = () => {
    page++;
    if (kind === 'rpc') return { error: { code: -1, message: 'unavailable' } };
    return { data: kind === 'malformed' ? [{ model: 'missing' }] : kind === 'modality' ? [{ ...catalogModel('x'), inputModalities: ['video'] }] : kind === 'over-limit' ? Array(1001).fill(catalogModel('x')) : [catalogModel('x')],
      nextCursor: kind === 'repeat' ? 'same' : kind === 'ninth' ? String(page) : null };
  };
  const result = await ctx.adapter.capabilities.models.api.list(ctx.signal);
  assert.equal(result.error.code, 'native-failure');
  if (kind === 'ninth') assert.equal(page, 8);
});

for (const ending of ['caller', 'close', 'deadline']) test(`model listing settles on ${ending} and never opens a thread`, async (t) => {
  const ctx = await openHost(t);
  ctx.f.handlers['model/list'] = () => ({ deferred: true });
  const controller = new AbortController();
  const pending = ctx.adapter.capabilities.models.api.list(controller.signal);
  await tick();
  if (ending === 'caller') controller.abort();
  if (ending === 'close') await ctx.adapter.close();
  const result = await pending;
  assert.equal(result.error.code, ending === 'deadline' ? 'unavailable' : 'closed');
  assert.equal(ctx.f.sent.includes('thread/start'), false);
  await ctx.adapter.close();
  assert.equal((await ctx.adapter.capabilities.models.api.list(ctx.signal)).error.code, 'closed');
});

test('routed capabilities refuse media/catalog and keep routed resume parameters unchanged', async () => {
  const endpoint = 'http://127.0.0.1:12345/';
  const made = subject((f) => {
    f.handlers['account/read'] = () => ({ account: null, requiresOpenaiAuth: false });
    const original = f.handlers['config/read'];
    f.handlers['config/read'] = () => { const result = original(); return { config: { ...result.config, model_provider: 'host',
      model_providers: { host: { base_url: endpoint, wire_api: 'responses', requires_openai_auth: false } } } }; };
    for (const method of ['thread/start', 'thread/resume']) {
      const handler = f.handlers[method];
      f.handlers[method] = (params) => { const result = handler(params); result.thread.modelProvider = 'host'; return { ...result, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', model: 'route-model' }; };
    }
    const read = f.handlers['thread/read'];
    f.handlers['thread/read'] = (params) => { const result = read(params); result.thread.modelProvider = 'host'; return result; };
  });
  const signal = AbortSignal.timeout(10000);
  const options = { environment: { ...made.environment, nativeConfig: { ...made.environment.nativeConfig,
    sqliteHome: '/codex-host-index', logDir: '/codex-host-logs', effort: 'high', loopbackRelay: true } },
    route: { config: { kind: 'host-route', endpoint, protocol: 'responses', credentialPurpose: 'host-route', credentialForm: 'none',
      principal: 'fixture', model: 'route-model', resolve: async () => ({ kind: 'ok', value: { form: 'none' } }) },
    scope: { engine: 'codex', account: 'fixture', adapterInstanceId: 'fixture', sessionId: 'fixture' } } };
  try {
    const opened = await made.registration.open({ ...options, launch: made.launch('allow') }, signal);
    assert.equal(opened.kind, 'ok', JSON.stringify(opened));
    assert.equal(opened.value.capabilities.models.kind, 'unavailable');
    assert.equal(opened.value.capabilities.imageInput.kind, 'unavailable');
    const input = { prompt: prompts.text, signal, hostOperationId: 'route', recordIntent: () => {} };
    const refused = await opened.value.run({ ...input, images: [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }] });
    assert.equal(refused.error.code, 'unsupported');
    assert.equal(refused.write.kind, 'not-attempted');
    const result = await opened.value.run(input);
    assert.equal(result.kind, 'complete');
    const f = made.state.servers[0];
    assert.equal(f.params[f.sent.indexOf('thread/start')].model, 'route-model');
    assert.equal(f.params[f.sent.indexOf('turn/start')].effort, 'high');
    f.request('route-approval', 'item/commandExecution/requestApproval', { ...f.turnIdentity, itemId: 'routed', command: 'synthetic', cwd: made.home });
    await tick();
    assert.equal(f.replies.find((reply) => reply.id === 'route-approval').error.code, -32601);
    assert.equal((await opened.value.capabilities.inspect.api.pending(signal)).value.approvals.length, 0);
    const largeRefusal = await opened.value.run({ ...input, prompt: 'x'.repeat(2097152), images: [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }] });
    assert.equal(largeRefusal.error.code, 'unsupported');
    await opened.value.close();
    const resumed = await made.registration.open({ ...options, launch: made.launch('allow'), resume: { session: result.session } }, signal);
    assert.equal(resumed.kind, 'ok', JSON.stringify(resumed));
    const later = made.state.servers.at(-1);
    assert.equal(Object.hasOwn(later.params[later.sent.indexOf('thread/resume')], 'excludeTurns'), false);
    await resumed.value.close();
  } finally { await made.dispose(); }
});

test('model listing multiplexes with a held turn and close interrupts pagination', async (t) => {
  const ctx = await openHost(t);
  approvalTurns(ctx.f);
  ctx.f.handlers['model/list'] = () => ({ data: [catalogModel('x')], nextCursor: null });
  const [pending, models] = await Promise.all([ctx.run(), ctx.adapter.capabilities.models.api.list(ctx.signal)]);
  assert.equal(pending.kind, 'pending');
  assert.equal(models.value[0].model, 'x');
  await ctx.answer([approvalAnswer(pending.approvals[0])]);
  let pages = 0;
  let closing;
  ctx.f.handlers['model/list'] = () => {
    if (++pages === 1) return { data: [], nextCursor: 'second' };
    closing = ctx.adapter.close();
    return { deferred: true };
  };
  assert.equal((await ctx.adapter.capabilities.models.api.list(ctx.signal)).error.code, 'closed');
  assert.equal(pages, 2);
  await closing;
});

test('error evidence without acknowledged identity is never attached after process loss', async (t) => {
  const ctx = await openHost(t);
  ctx.f.handlers['turn/start'] = (params) => {
    ctx.f.send({ method: 'error', params: { threadId: params.threadId, turnId: 'unverified', willRetry: false, error: { message: 'unbound' } } });
    queueMicrotask(() => ctx.f.sink.ended('eof'));
    return { deferred: true };
  };
  const result = await ctx.run();
  assert.equal(result.kind, 'failed');
  assert.equal(result.nativeError, undefined);
  assert.equal(result.write.kind, 'outcome-unknown');
});

test('the largest escaped text envelope accompanies 4 MiB and larger echo metadata', async (t) => {
  const ctx = await openHost(t);
  ctx.f.echoMetadata = 'x'.repeat(65536);
  const overhead = Buffer.byteLength(JSON.stringify({ id: `${'x'.repeat(36)}:${Number.MAX_SAFE_INTEGER}`, method: 'turn/start',
    params: { threadId: 'x'.repeat(36), input: [{ type: 'text', text: '', text_elements: [] }] } }));
  const prompt = '\u0000'.repeat(Math.floor((1048576 - overhead) / 6));
  const result = await ctx.adapter.run({ prompt, images: [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(4194304).toString('base64')}` }],
    signal: ctx.signal, hostOperationId: 'largest', recordIntent: () => {} });
  assert.equal(result.kind, 'complete');
  const checkpoint = await ctx.adapter.capabilities.fingerprint.api.read(ctx.signal);
  assert.equal(checkpoint.kind, 'ok');
  await ctx.adapter.close();
  const reopened = await ctx.made.registration.open({ launch: ctx.made.launch('allow'), tools: [ctx.made.tool],
    resume: { session: result.session, expectedHistory: checkpoint.value } }, ctx.signal);
  assert.equal(reopened.kind, 'ok', JSON.stringify(reopened));
  await reopened.value.close();
});

test('omitted new options preserve the pre-parity thread and text frame bytes', async () => {
  const made = subject(); const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow') }, signal);
    const events = []; opened.value.events.subscribe((event) => { events.push(event); });
    await opened.value.run({ prompt: prompts.text, signal, hostOperationId: 'default', recordIntent() {} });
    const frames = made.state.servers[0].raw.filter((line) => ['thread/start', 'turn/start'].includes(JSON.parse(line).method))
      .map((line) => { const frame = JSON.parse(line); return line.replaceAll(JSON.stringify(frame.id), JSON.stringify('<request>'))
        .replaceAll(JSON.stringify(made.home), JSON.stringify('<cwd>'))
        .replaceAll(JSON.stringify(frame.params.threadId ?? '<thread>'), JSON.stringify('<thread>')); });
    const baseline = JSON.parse(readFileSync(new URL('../../qualification/codex-host-default-frames.json', import.meta.url), 'utf8'));
    assert.deepEqual(frames, baseline);
    assert.equal(events.some((event) => event.kind === 'native-item'), false);
    await opened.value.close();
  } finally { await made.dispose(); }
});

test('regression: missing answers', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); await ctx.run(); let intents = 0;
  const result = await ctx.adapter.continue({ signal: ctx.signal, hostOperationId: 'missing', recordIntent() { intents++; } });
  assert.equal(result.kind, 'failed'); assert.equal(result.error.code, 'invalid-input'); assert.equal(intents, 0); assert.equal(ctx.f.replies.length, 0);
  await ctx.adapter.interrupt({ timeoutMs: 1000 });
});
test('regression: terminal during interrupt', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); await ctx.run();
  ctx.f.handlers['turn/interrupt'] = (params) => { queueMicrotask(() => ctx.f.finishTurn(params.threadId, params.turnId)); return { deferred: true }; };
  const result = await ctx.adapter.interrupt({ timeoutMs: 30 });
  assert.equal(result.kind, 'terminal-observed');
});

test('regression: mutable prompt preflight', async (t) => {
  const ctx = await openHost(t); let reads=0; let intents=0;
  const result = await ctx.adapter.run({ get prompt() { return ++reads < 3 ? 'short' : 'x'.repeat(2097152); },
    images:[{mediaType:'image/png',dataUrl:'data:image/png;base64,YQ=='}],signal:ctx.signal,hostOperationId:'prompt-race',recordIntent(){intents++;} });
  const actual=ctx.f.params[ctx.f.sent.lastIndexOf('turn/start')].input[0].text.length;
  assert.equal(result.kind,'complete');assert.equal(actual,5);assert.equal(reads,1);assert.equal(intents,1);
});
test('regression: cyclic second tool reply after approval', async (t) => {
  const ctx=await openHost(t);approvalTurns(ctx.f,{mixed:true});const pending=await ctx.run();let intents=0;
  const cycle=[];cycle.push(cycle);const answer=callAnswer(pending.calls[0]);answer.outcome.result.value.data={contentItems:cycle};
  const result=await ctx.answer([approvalAnswer(pending.approvals[0]),answer],()=>{intents++;});await tick();
  const decisions=ctx.f.replies.filter((r)=>r.result?.decision).length;
  assert.equal(decisions,0);assert.equal(intents,0);assert.equal(result.error.code,'invalid-input');
});
test('regression: join before first reply', async (t) => {
  const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();
  const result=await ctx.adapter.continue({answers:[approvalAnswer(pending.approvals[0])],signal:ctx.signal,hostOperationId:'join',recordIntent(){},
    onObservation(event){if(event.kind==='run-started'){
      ctx.f.pending.set('new-approval',{...ctx.f.turnIdentity,itemId:'new-item'});
      ctx.f.request('new-approval','item/fileChange/requestApproval',{...ctx.f.turnIdentity,itemId:'new-item'});
    }}});
  await tick();const decisions=ctx.f.replies.filter((r)=>r.result?.decision).length;
  assert.equal(decisions,0);assert.equal(result.write.kind,'not-dispatched');await ctx.adapter.interrupt({timeoutMs:1000});
});
test('regression: continuation passes close', async (t) => {
  const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();const gate=Promise.withResolvers();
  const continued=ctx.answer([approvalAnswer(pending.approvals[0])],()=>gate.promise);await tick();const closing=ctx.adapter.close();
  while(!ctx.f.sent.includes('turn/interrupt'))await tick();await tick();gate.resolve();const result=await continued;await closing;
  const decisions=ctx.f.replies.filter((r)=>r.result?.decision).length;
  assert.equal(decisions,0);assert.equal(result.write.kind,'not-dispatched');
});
test('regression: capacity loss across segments', async (t) => {
  const ctx=await openHost(t);approvalTurns(ctx.f);await ctx.run();
  for(let i=0;i<7;i++)ctx.f.arm(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId,[{id:`more-${i}`,frame:{id:`more-${i}`,method:'item/fileChange/requestApproval',params:{...ctx.f.turnIdentity,itemId:`more-item-${i}`}}}]);
  await tick();ctx.f.request('ninth','item/fileChange/requestApproval',{...ctx.f.turnIdentity,itemId:'ninth'});await tick();
  const pending=(await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value;
  const result=await ctx.answer(pending.approvals.map((a)=>approvalAnswer(a)));
  assert.equal(result.kind,'failed');assert.equal(result.error.code,'pending-limit');assert.equal(result.write.kind,'accepted');
});
test('regression: reply certainty before writer entry', async (t) => {
  const ctx=await openHost(t);const pending=await ctx.run(prompts.toolCall);const gate=Promise.withResolvers();const entered=Promise.withResolvers();const original=ctx.f.channel.write;
  ctx.f.handlers['model/list']=()=>({deferred:true});
  ctx.f.channel.write=(bytes,signal)=>{const frame=JSON.parse(Buffer.from(bytes).toString());if(frame.method==='model/list'){original(bytes,signal);entered.resolve();return gate.promise;}return original(bytes,signal);};
  const listing=ctx.adapter.capabilities.models.api.list(ctx.signal);await entered.promise;const controller=new AbortController();
  const observed=[];const continuing=ctx.adapter.continue({answers:[callAnswer(pending.calls[0])],signal:controller.signal,hostOperationId:'queued-reply',recordIntent(){},onObservation(e){observed.push(e);}});
  await tick();assert.equal(observed.some(e=>e.kind==='tool'&&e.phase==='completed'),false);controller.abort();const result=await continuing;
  const replies=ctx.f.replies.length;ctx.f.sink.ended('eof');gate.resolve();await listing;
  assert.equal(replies,0);assert.equal(result.write.kind,'not-dispatched');
});
test('regression: preack activity and error order', async (t) => {
  const ctx=await openHost(t,{activity:'items'});const events=[];ctx.adapter.events.subscribe((e)=>events.push(e));let request;
  ctx.f.handlers['turn/start']=(params,id)=>{request={params,id,turnId:randomUUID()};return {deferred:true};};const running=ctx.run('early');while(!request)await tick();
  const identity={threadId:request.params.threadId,turnId:request.turnId};
  ctx.f.send({method:'item/started',params:{...identity,item:{type:'commandExecution',id:'command',status:'inProgress'}}});
  ctx.f.send({method:'error',params:{...identity,willRetry:false,error:{message:'old'}}});
  for(let i=0;i<30;i++)ctx.f.send({method:'fixture/padding',params:identity});
  ctx.f.send({method:'item/completed',params:{...identity,item:{type:'commandExecution',id:'command',status:'completed'}}});
  ctx.f.send({method:'error',params:{...identity,willRetry:false,error:{message:'new'}}});await tick(8);
  ctx.f.send({id:request.id,result:{turn:{id:request.turnId,status:'inProgress'}}});await tick(8);
  ctx.f.send({method:'turn/completed',params:{threadId:identity.threadId,turn:{id:identity.turnId,status:'failed',error:null}}});
  const result=await running;const order=events.filter((e)=>e.kind==='native-item').map((e)=>e.item.data.method);
  assert.deepEqual(order,['item/started','item/completed']);assert.equal(result.nativeError.message,'new');
});
test('regression: late acknowledgement past private cleanup', async (t) => {
 const ctx=await openHost(t);approvalTurns(ctx.f);await ctx.run();let replyId;
 ctx.f.handlers['turn/interrupt']=(_,id)=>{replyId=id;return {deferred:true};};
 const waiting=ctx.adapter.interrupt({timeoutMs:8000});await new Promise((resolve)=>setTimeout(resolve,5200));ctx.f.send({id:replyId,result:{}});const result=await waiting;
await tick();const pending=(await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length;
 assert.equal(pending,0);assert(['interrupted','terminal-observed'].includes(result.kind));
 ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);
});

for (const size of [1048576, 1048577]) test(`a mixed batch refuses a ${size}-byte tool result before any decision`, async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f, { mixed: true }); const pending = await ctx.run();
  const tool = callAnswer(pending.calls[0]); tool.outcome.result.value.data = { contentItems: [{ type: 'inputText', text: 'x'.repeat(size) }] };
  let intents = 0;
  const result = await ctx.answer([approvalAnswer(pending.approvals[0]), tool], () => { intents++; });
  assert.equal(result.error.code, 'invalid-input'); assert.equal(intents, 0); assert.equal(ctx.f.replies.length, 0);
  await ctx.adapter.interrupt({ timeoutMs: 100 }); ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

test('requests for a completed turn remain withdrawn after five newer terminals', async (t) => {
  const ctx = await openHost(t); await ctx.run(prompts.text); const first = ctx.f.turnIdentity;
  for (let i = 0; i < 5; i++) await ctx.run(prompts.text);
  ctx.f.request('late-old', 'item/commandExecution/requestApproval', { ...first, itemId: 'old', command: 'synthetic', cwd: ctx.made.home, availableDecisions: ['accept', 'cancel'] });
  await tick();
  assert.equal(ctx.f.replies.find((r) => r.id === 'late-old').error.code, -32000);
  assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length, 0);
});

for (const depth of [7, 8, 9]) test(`pending selection retains its snapshot when terminal delivery follows ${depth} microtasks later`, async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); const original = ctx.f.handlers['turn/start'];
  ctx.f.handlers['turn/start'] = (params, id) => {
    const result = original(params, id);
    const later = (left) => queueMicrotask(() => left ? later(left - 1) : ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId));
    later(depth); return result;
  };
  const result = await ctx.run();
  assert(['complete', 'pending'].includes(result.kind));
  if (result.kind === 'pending') assert(result.calls.length + result.approvals.length > 0);
});

test('a withdrawn pending notification cannot end a continuation before its terminal', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); const first = await ctx.run();
  ctx.f.onReply = () => {
    ctx.f.request('transient', 'item/fileChange/requestApproval', { ...ctx.f.turnIdentity, itemId: 'transient' });
    ctx.f.send({ method: 'serverRequest/resolved', params: { ...ctx.f.turnIdentity, requestId: 'transient' } });
  };
  const result = await ctx.answer([approvalAnswer(first.approvals[0])]);
  assert.equal(result.kind, 'complete');
});

test('withdrawal during run-started prevents the first native decision', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); const pending = await ctx.run();
  const result = await ctx.adapter.continue({ answers: [approvalAnswer(pending.approvals[0])], signal: ctx.signal,
    hostOperationId: 'withdraw-at-start', recordIntent() {}, onObservation(event) {
      if (event.kind === 'run-started') ctx.f.send({ method: 'serverRequest/resolved', params: { ...ctx.f.turnIdentity, requestId: 'approval-call' } });
    } });
  assert.equal(result.write.kind, 'not-dispatched'); assert.equal(ctx.f.replies.filter((r) => r.result?.decision).length, 0);
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

test('capacity refused during run-started prevents every decision in the batch', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); await ctx.run();
  for (let i = 0; i < 7; i++) ctx.f.arm(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId, [{ id: `extra-${i}`, frame: {
    id: `extra-${i}`, method: 'item/fileChange/requestApproval', params: { ...ctx.f.turnIdentity, itemId: `extra-${i}` } } }]);
  await tick(); const pending = (await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value;
  const result = await ctx.adapter.continue({ answers: pending.approvals.map((a) => approvalAnswer(a)), signal: ctx.signal,
    hostOperationId: 'capacity-at-start', recordIntent() {}, onObservation(event) {
      if (event.kind === 'run-started') ctx.f.request('ninth-at-start', 'item/fileChange/requestApproval', { ...ctx.f.turnIdentity, itemId: 'ninth' });
    } });
  assert.equal(result.error.code, 'pending-limit'); assert.equal(result.write.kind, 'accepted');
  assert.equal(ctx.f.replies.filter((r) => r.result?.decision).length, 0);
  await ctx.adapter.interrupt({ timeoutMs: 100 }); ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

test('a continuation getter cannot claim a segment already claimed by its nested continuation', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); const pending = await ctx.run();
  const gate = Promise.withResolvers(); let nested; let intents = 0;
  const answer = approvalAnswer(pending.approvals[0]);
  const input = { ...answer, get nativeChoiceId() {
    nested = ctx.answer([answer], () => { intents++; return gate.promise; }); return 'accept';
  } };
  const outer = ctx.answer([input], () => { intents++; });
  try { await tick(); assert.equal(intents, 1); const refused = await outer; assert.equal(refused.error.code, 'busy'); }
  finally { gate.resolve(); await nested; await outer; }
});

test('terminal observation retires unanswered interrupt exchanges across successive turns', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f);
  ctx.f.handlers['turn/interrupt'] = (params) => { queueMicrotask(() => ctx.f.finishTurn(params.threadId, params.turnId)); return { deferred: true }; };
  for (let i = 0; i < 10; i++) {
    assert.equal((await ctx.run()).kind, 'pending');
    assert.equal((await ctx.adapter.interrupt({ timeoutMs: 100 })).kind, 'terminal-observed');
  }
  ctx.f.handlers['model/list'] = () => ({ data: [], nextCursor: null });
  assert.equal((await ctx.adapter.capabilities.models.api.list(ctx.signal)).kind, 'ok');
});

test('empty and omitted media share the oversized text path exactly', async (t) => {
  const results = [];
  for (const media of [{}, { images: [] }]) {
    const ctx = await openHost(t); let intents = 0;
    const result = await ctx.adapter.run({ ...media, prompt: 'x'.repeat(1048577), signal: ctx.signal,
      hostOperationId: 'empty-text', recordIntent() { intents++; } });
    results.push({ kind: result.kind, write: result.write, error: result.error.code, intents, sent: ctx.f.sent });
  }
  assert.deepEqual(results[1], results[0]);
});

test('late text and usage from a previous turn cannot replace the current segment', async (t) => {
  const ctx = await openHost(t); await ctx.run(prompts.text); const old = ctx.f.turnIdentity;
  failTurn(ctx.f, { noTerminal: true }); const running = ctx.run('current'); await tick(); const current = ctx.f.turnIdentity;
  ctx.f.send({ method: 'item/agentMessage/delta', params: { ...old, itemId: 'old', delta: 'OLD' } });
  ctx.f.send({ method: 'item/agentMessage/delta', params: { ...current, itemId: 'current', delta: 'CURRENT' } });
  ctx.f.send({ method: 'thread/tokenUsage/updated', params: { ...current, tokenUsage: { total: usage, last: usage, modelContextWindow: 1000 } } });
  ctx.f.send({ method: 'thread/tokenUsage/updated', params: { ...old, tokenUsage: { total: { ...usage, totalTokens: 999 }, last: usage, modelContextWindow: 1000 } } });
  ctx.f.send({ method: 'turn/completed', params: { threadId: current.threadId, turn: { id: current.turnId, status: 'completed', error: null } } });
  const result = await running; assert.equal(result.kind, 'complete'); assert.equal(result.text, 'CURRENT');
  assert.equal(result.usage.native.data.total.totalTokens, 3);
});

test('a limit discovered after local replies never borrows the originating turn write evidence', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); const pending = await ctx.run(); let fired = false;
  ctx.f.onReply = () => {
    if (fired) return; fired = true;
    ctx.f.arm(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId, Array.from({ length: 9 }, (_, i) => ({ id: `later-${i}`, frame: {
      id: `later-${i}`, method: 'item/tool/call', params: { ...ctx.f.turnIdentity, callId: `later-${i}`, namespace: 'application', tool: toolName, arguments: {} } } })));
  };
  const result = await ctx.answer([approvalAnswer(pending.approvals[0])]);
  assert.equal(result.kind, 'failed'); assert.equal(result.write.kind, 'outcome-unknown');
  await ctx.adapter.interrupt({ timeoutMs: 100 }); ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

for (const ending of ['serverRequest/resolved', 'turn/completed', 'item/completed']) test(`same-chunk request and ${ending} cannot revive a native interaction`, async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); await ctx.run();
  const request = { id: 'already-ended', method: 'item/fileChange/requestApproval', params: { ...ctx.f.turnIdentity, itemId: 'already-ended' } };
  const notification = { method: ending, params: ending === 'turn/completed'
    ? { threadId: ctx.f.turnIdentity.threadId, turn: { id: ctx.f.turnIdentity.turnId, status: 'completed', error: null } }
    : { ...ctx.f.turnIdentity, ...(ending === 'item/completed' ? { item: { id: 'already-ended', type: 'fileChange', status: 'completed' } } : { requestId: 'already-ended' }) } };
  ctx.f.sink.data(Buffer.from(`${JSON.stringify(request)}\n${JSON.stringify(notification)}\n`)); await tick();
  const pending = (await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value;
  assert(!pending.approvals.some((a) => a.target.tool.nativeToolCallId === 'already-ended'));
  assert.equal(ctx.f.replies.find((reply) => reply.id === 'already-ended').error.code, -32000);
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

test('a pre-ack withdrawal stays on the bounded request lease until identity is known', async (t) => {
  const ctx = await openHost(t); let start;
  ctx.f.handlers['turn/start'] = (params, id) => { start = { params, id, turnId: randomUUID() }; return { deferred: true }; };
  const running = ctx.run('early-request'); while (!start) await tick();
  const identity = { threadId: start.params.threadId, turnId: start.turnId };
  ctx.f.sink.data(Buffer.from(`${JSON.stringify({ id: 'early-request', method: 'item/fileChange/requestApproval', params: { ...identity, itemId: 'early' } })}\n${JSON.stringify({ method: 'serverRequest/resolved', params: { ...identity, requestId: 'early-request' } })}\n`));
  await tick(); ctx.f.send({ id: start.id, result: { turn: { id: start.turnId, status: 'inProgress' } } }); await tick();
  assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length, 0);
  assert.equal(ctx.f.replies.find((r) => r.id === 'early-request').error.code, -32000);
  ctx.f.finishTurn(identity.threadId, identity.turnId); assert.equal((await running).kind, 'complete');
});

test('acknowledged interruption refuses later interactions for the captured turn', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); await ctx.run();
  ctx.f.autoFinish = false;
  assert.equal((await ctx.adapter.interrupt({ timeoutMs: 100 })).kind, 'interrupted');
  ctx.f.request('after-interrupt', 'item/fileChange/requestApproval', { ...ctx.f.turnIdentity, itemId: 'after-interrupt' });
  ctx.f.request('tool-after-interrupt', 'item/tool/call', { ...ctx.f.turnIdentity, callId: 'after-tool', namespace: 'application', tool: toolName, arguments: {} });
  await tick(); const pending = (await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value;
  assert.equal(pending.approvals.length + pending.calls.length, 0);
  assert.equal(ctx.f.replies.find((r) => r.id === 'after-interrupt').error.code, -32000);
  assert.equal(ctx.f.replies.find((r) => r.id === 'tool-after-interrupt').error.code, -32000);
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId); await tick();
  assert.equal((await ctx.run()).kind, 'pending');
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

test('host-attested exit alone withdraws mixed pending work without a channel end', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f, { mixed: true }); const pending = await ctx.run();
  const events = []; ctx.adapter.events.subscribe((event) => events.push(event));
  ctx.f.attestExit(); await tick();
  const current = (await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value;
  assert.equal(current.calls.length + current.approvals.length, 0);
  const lost = events.filter((e) => e.kind === 'interaction-settled'); assert.equal(lost.length, 2);
  assert(lost.every((e) => e.settlement.data.kind === 'lost' && e.settlement.data.cause === 'process-exit'));
  assert.equal((await ctx.answer([...pending.calls.map(callAnswer), ...pending.approvals.map((a) => approvalAnswer(a))])).write.kind, 'not-attempted');
  assert.equal(ctx.f.replies.some((r) => r.result?.decision), false);
});

test('EOF without a terminal or process exit cannot establish a terminal interrupt result', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); await ctx.run(); ctx.f.sink.ended('eof'); await tick();
  assert.equal((await ctx.adapter.interrupt({ timeoutMs: 100 })).kind, 'unconfirmed-within-bound');
  ctx.f.attestExit(); await tick(); assert.equal((await ctx.adapter.interrupt({ timeoutMs: 100 })).kind, 'terminal-observed');
});

for (const count of [31, 33]) test(`pre-ack result projection accounts for ${count} text notifications`, async (t) => {
  const ctx = await openHost(t); let start;
  ctx.f.handlers['turn/start'] = (params, id) => { start = { params, id, turnId: randomUUID() }; return { deferred: true }; };
  const running = ctx.run('early-text'); while (!start) await tick();
  const identity = { threadId: start.params.threadId, turnId: start.turnId };
  for (let i = 0; i < count; i++) ctx.f.send({ method: 'item/agentMessage/delta', params: { ...identity, itemId: 'text', delta: `${i},` } });
  if (count === 31) ctx.f.send({ method: 'thread/tokenUsage/updated', params: { ...identity, tokenUsage: { total: usage, last: usage, modelContextWindow: 1000 } } });
  ctx.f.send({ method: 'turn/completed', params: { threadId: identity.threadId, turn: { id: identity.turnId, status: 'completed', error: null } } });
  await tick(); ctx.f.send({ id: start.id, result: { turn: { id: start.turnId, status: 'inProgress' } } });
  const result = await running;
  if (count === 31) { assert.equal(result.kind, 'complete'); assert.equal(result.text, Array.from({ length: count }, (_, i) => `${i},`).join('')); assert.equal(result.usage.native.data.total.totalTokens, 3); }
  else { assert.equal(result.kind, 'failed'); assert.equal(result.write.kind, 'accepted'); assert.match(result.error.message, /discarded/); }
});

test('matching native cause survives acknowledgement and clean EOF in one callback', async (t) => {
  const ctx = await openHost(t);
  ctx.f.handlers['turn/start'] = (params, id) => {
    const turnId = randomUUID();
    ctx.f.send({ method: 'error', params: { threadId: params.threadId, turnId, willRetry: false, error: { message: 'known cause' } } });
    ctx.f.send({ id, result: { turn: { id: turnId, status: 'inProgress' } } }); ctx.f.sink.ended('eof');
    return { deferred: true };
  };
  const result = await ctx.run(); assert.equal(result.kind, 'failed');
  assert.equal(result.nativeError?.source, 'error-notification'); assert.equal(result.nativeError.message, 'known cause');
});

for (const contentItems of [[null], [{}], [{ type: 'inputImage', imageUrl: 7 }], [{ type: 'inputAudio', audioUrl: null }]]) test('a malformed native tool item refuses its whole mixed batch', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f, { mixed: true }); const pending = await ctx.run(); let intents = 0;
  const answer = callAnswer(pending.calls[0]); answer.outcome.result.value.data = { contentItems };
  const result = await ctx.answer([approvalAnswer(pending.approvals[0]), answer], () => { intents++; });
  assert.equal(result.error.code, 'invalid-input'); assert.equal(intents, 0); assert.equal(ctx.f.replies.length, 0);
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});

test('public rejection evidence omits RPC data and bounds every exposed message', async (t) => {
  const ctx = await openHost(t); failTurn(ctx.f, { rpc: { code: -1, message: '雪'.repeat(4000), data: { secret: 'RPC-DATA-SENTINEL' } } });
  const result = await ctx.run(); assert.equal(result.write.kind, 'accepted'); assert(!JSON.stringify(result).includes('RPC-DATA-SENTINEL'));
  assert(Buffer.byteLength(result.write.evidence.observation.data.message) <= 2048);
});

test('new native configuration fields are captured once before launch', async () => {
  const made = subject(); let reads = 0; const signal = AbortSignal.timeout(10000);
  try {
    const opened = await made.registration.open({ launch: made.launch('allow'), environment: { ...made.environment,
      nativeConfig: { ...made.environment.nativeConfig, get approvalsReviewer() { reads++; return reads === 1 ? 'user' : 'invalid'; } } } }, signal);
    assert.equal(opened.kind, 'ok'); assert.equal(reads, 1);
    await opened.value.run({ prompt: prompts.text, signal, hostOperationId: 'captured-config', recordIntent() {} });
    const server = made.state.servers[0]; assert.equal(server.params[server.sent.indexOf('thread/start')].approvalsReviewer, 'user');
    await opened.value.close();
  } finally { await made.dispose(); }
});

test('a later segment cannot borrow turn-start evidence after an earlier reply', async (t) => {
  const ctx = await openHost(t); approvalTurns(ctx.f); const first = await ctx.run(); let added = false;
  ctx.f.onReply = () => {
    if (added) return; added = true;
    ctx.f.arm(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId, [{ id: 'second', frame: { id: 'second',
      method: 'item/fileChange/requestApproval', params: { ...ctx.f.turnIdentity, itemId: 'second' } } }]);
  };
  assert.equal((await ctx.answer([approvalAnswer(first.approvals[0])])).kind, 'pending');
  for (let i = 0; i < 8; i++) ctx.f.request(`later-${i}`, 'item/fileChange/requestApproval', { ...ctx.f.turnIdentity, itemId: `later-${i}` });
  await tick(); const current = (await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value;
  const result = await ctx.answer(current.approvals.map((a) => approvalAnswer(a)));
  assert.equal(result.kind, 'failed'); assert.equal(result.write.kind, 'outcome-unknown');
  ctx.f.finishTurn(ctx.f.turnIdentity.threadId, ctx.f.turnIdentity.turnId);
});



test('forged signals are refused before native catalog or segment admission', async (t) => {
  const ctx = await openHost(t); const before = ctx.f.raw.length;
  const signal = Object.create(AbortSignal.prototype);
  assert.equal((await ctx.adapter.capabilities.models.api.list(signal)).error.code, 'invalid-input');
  const result = await ctx.adapter.run({ prompt: 'invalid signal', signal, hostOperationId: 'bad-signal', recordIntent() { assert.fail('must not record'); } });
  assert.equal(result.error.code, 'invalid-input'); assert.equal(result.write.kind, 'not-attempted');
  assert.equal(ctx.f.raw.length, before);
});

test('a terminal preceding a late request closes turn admission before asynchronous projection', async (t) => {
 const ctx=await openHost(t); let running;
 ctx.f.handlers['turn/start']=(params)=>{ctx.f.turnIdentity={threadId:params.threadId,turnId:randomUUID()};return {turn:{id:ctx.f.turnIdentity.turnId,status:'inProgress'}};};
 running=ctx.run(); await tick();
 const {threadId,turnId}=ctx.f.turnIdentity;
 ctx.f.sink.data(Buffer.from(JSON.stringify({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}})+'\n'+JSON.stringify({id:'too-late',method:'item/fileChange/requestApproval',params:{threadId,turnId,itemId:'too-late'}})+'\n'));
 await tick();const pending=(await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value;
 assert.equal(pending.approvals.length,0);assert.equal(ctx.f.replies.find(r=>r.id==='too-late').error.code,-32000); assert.equal((await running).kind,'complete');
});

test('parsed final text and terminal survive immediate clean EOF', async (t) => {
 const ctx=await openHost(t);
 ctx.f.handlers['turn/start']=(params)=>{ctx.f.turnIdentity={threadId:params.threadId,turnId:randomUUID()};return {turn:{id:ctx.f.turnIdentity.turnId,status:'inProgress'}};};
 const running=ctx.run();await tick(); const {threadId,turnId}=ctx.f.turnIdentity;
 ctx.f.sink.data(Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'last',delta:'last text'}})+'\n'+JSON.stringify({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}})+'\n'));
 ctx.f.sink.ended('eof'); const result=await running; assert.equal(result.kind,'complete');assert.equal(result.text,'last text');
});

test('an interrupt acknowledgement during run-started prevents every decision', async (t) => {
 const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();let interruptId;
 ctx.f.handlers['turn/interrupt']=(_,id)=>{interruptId=id;return {deferred:true};};
 assert.equal((await ctx.adapter.interrupt({timeoutMs:1})).kind,'unconfirmed-within-bound');assert(interruptId);
 const result=await ctx.adapter.continue({answers:[approvalAnswer(pending.approvals[0])],signal:ctx.signal,hostOperationId:'ack-at-start',recordIntent(){},onObservation(event){if(event.kind==='run-started')ctx.f.send({id:interruptId,result:{}});}});
 assert.equal(result.write.kind,'not-dispatched');assert.equal(ctx.f.replies.filter(r=>r.result?.decision).length,0);
 ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);
});

test('old terminal candidates cannot displace the acknowledged turn terminal', async (t) => {
 const ctx=await openHost(t);let start;
 ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return {deferred:true};};
 const running=ctx.run();while(!start)await tick();const identity={threadId:start.threadId,turnId:start.turnId};
 for(let i=0;i<32;i++)ctx.f.send({method:'item/agentMessage/delta',params:{...identity,itemId:'m',delta:'x'}});
 for(const id of ['older-than-previous',start.turnId])ctx.f.send({method:'turn/completed',params:{threadId:start.threadId,turn:{id,status:'completed',error:null}}});
 await tick();ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});
 const result=await running;assert.equal(result.kind,'complete');assert.equal(result.text,'x'.repeat(32));
});
test('an unwritten interrupt can be attempted after transport capacity is released', async (t) => {
 const ctx=await openHost(t);approvalTurns(ctx.f);await ctx.run();
 ctx.f.handlers['model/list']=()=>({deferred:true});const controls=Array.from({length:8},()=>new AbortController());
 const lists=controls.map(c=>ctx.adapter.capabilities.models.api.list(c.signal));await tick();
 assert.equal((await ctx.adapter.interrupt({timeoutMs:100})).kind,'unconfirmed-within-bound');
 controls.forEach(c=>c.abort());await Promise.all(lists);await tick();
 assert(['interrupted','terminal-observed'].includes((await ctx.adapter.interrupt({timeoutMs:1000})).kind));
 assert.equal(ctx.f.sent.filter(m=>m==='turn/interrupt').length,1);
});
test('a terminal stays definitive while a continuation is still recording intent', async (t) => {
 const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();let release;
 const gate=new Promise(r=>{release=r;});const continuing=ctx.answer([approvalAnswer(pending.approvals[0])],()=>gate);await tick();
 ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);await tick();
 const before=ctx.f.sent.filter(m=>m==='turn/interrupt').length;
 assert.equal((await ctx.adapter.interrupt({timeoutMs:100})).kind,'terminal-observed');
 assert.equal(ctx.f.sent.filter(m=>m==='turn/interrupt').length,before);release();assert.equal((await continuing).write.kind,'not-dispatched');
});
test('settlement projection precedes later activity after repeated native observations', async (t) => {
 const ctx=await openHost(t,{activity:'items'});approvalTurns(ctx.f);const first=await ctx.run();await ctx.answer([approvalAnswer(first.approvals[0])]);
 const old=ctx.f.turnIdentity;
 for(let i=0;i<65;i++)ctx.f.send({method:'item/completed',params:{...old,item:{id:'approval-item',type:'fileChange',status:'completed'}}});
 await tick();const second=await ctx.run();const events=[];ctx.adapter.events.subscribe(e=>events.push(e));
 ctx.f.sink.data(Buffer.from(JSON.stringify({method:'serverRequest/resolved',params:{...ctx.f.turnIdentity,requestId:'approval-call'}})+'\n'+JSON.stringify({method:'item/started',params:{...ctx.f.turnIdentity,item:{id:'next',type:'commandExecution',status:'inProgress'}}})+'\n'));
 await tick();assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length,0);
 const settled=events.findIndex(e=>e.kind==='interaction-settled'&&e.target.nativeApprovalId===second.approvals[0].target.nativeApprovalId);
 const activity=events.findIndex(e=>e.kind==='native-item'&&e.item.data.params.item?.id==='next');
 assert(settled>=0&&activity>settled);
});

test('exhausted early terminal candidates fail the segment promptly without inventing termination',async(t)=>{
 const ctx=await openHost(t);let start;
 ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return {deferred:true};};
 const running=ctx.run();while(!start)await tick();
 for(let i=0;i<33;i++)ctx.f.send({method:'turn/completed',params:{threadId:start.threadId,turn:{id:'unrelated-'+i,status:'completed',error:null}}});
 ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});
 const result=await running;assert.equal(result.kind,'failed');assert.equal(result.write.kind,'accepted');assert.match(result.error.message,/discarded/);
 assert.equal((await ctx.adapter.interrupt({timeoutMs:1000})).kind,'interrupted');
 ctx.f.finishTurn(start.threadId,start.turnId);
});

test('an RPC rejection followed immediately by EOF retains bounded rejection evidence',async(t)=>{
 const ctx=await openHost(t);ctx.f.handlers['turn/start']=(_,id)=>{ctx.f.send({id,error:{code:-32001,message:'rejected',data:{sentinel:true}}});ctx.f.sink.ended('eof');return {deferred:true};};
 const result=await ctx.run();assert.equal(result.kind,'failed');assert.equal(result.write.kind,'accepted');assert.equal(result.nativeError?.source,'turn/start-reply');assert.equal(result.nativeError?.message,'rejected');
});

for(const activity of [false,true])test(`a healthy observer survives a same-callback burst (${activity?'activity':'text'}) while a lagging observer overflows`,async(t)=>{
 const ctx=await openHost(t,activity?{activity:'items'}:{});ctx.f.handlers['turn/start']=(params)=>{ctx.f.turnIdentity={threadId:params.threadId,turnId:randomUUID()};return {turn:{id:ctx.f.turnIdentity.turnId,status:'inProgress'}};};
 const events=[];let ended;const healthy=ctx.adapter.events.subscribe(e=>events.push(e));healthy.value.ended.then(reason=>{ended=reason;});
 let release;const gate=new Promise(r=>{release=r;});const slow=ctx.adapter.events.subscribe(()=>gate);
 const running=ctx.run();await tick();
 for(let i=0;i<70;i++)ctx.f.send({method:activity?'item/commandExecution/outputDelta':'item/agentMessage/delta',params:{...ctx.f.turnIdentity,itemId:'burst',delta:String(i)}});
 ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);assert.equal((await running).kind,'complete');await tick();
 assert.equal(events.filter(e=>e.kind===(activity?'native-item':'text-delta')).length,70);assert.equal(ended,undefined);assert.equal(await slow.value.ended,'overflow');release();
});
test('a queued decision is withheld if native resolves its request before writer entry',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();ctx.f.autoFinish=false;
 const original=ctx.f.channel.write.bind(ctx.f.channel);let release;const gate=new Promise(r=>{release=r;});
 ctx.f.handlers['model/list']=()=>({data:[],nextCursor:null});ctx.f.channel.write=(bytes)=>{const message=JSON.parse(Buffer.from(bytes));const written=original(bytes);return message.method==='model/list'?gate:written;};
 await ctx.adapter.capabilities.models.api.list(ctx.signal);await tick();
 const continuing=ctx.answer([approvalAnswer(pending.approvals[0])]);await tick();
 ctx.f.send({method:'serverRequest/resolved',params:{...ctx.f.turnIdentity,requestId:'approval-call'}});await tick();release();await tick();
 assert.equal(ctx.f.replies.some(r=>r.result?.decision),false);ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);const result=await continuing;assert.equal(result.kind,'failed');assert.equal(result.write.kind,'not-dispatched');
});
test('close takes over an interrupt cancelled before writer entry without retrying a written request',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f);await ctx.run();const original=ctx.f.channel.write.bind(ctx.f.channel);
 let release;const gate=new Promise(r=>{release=r;});ctx.f.handlers['model/list']=()=>({data:[],nextCursor:null});
 ctx.f.channel.write=(bytes)=>{const message=JSON.parse(Buffer.from(bytes));const written=original(bytes);return message.method==='model/list'?gate:written;};
 await ctx.adapter.capabilities.models.api.list(ctx.signal);await tick();assert.equal((await ctx.adapter.interrupt({timeoutMs:1})).kind,'unconfirmed-within-bound');
 const closed=ctx.adapter.close();await tick();release();assert.equal((await closed).kind,'ok');assert.equal(ctx.f.sent.filter(m=>m==='turn/interrupt').length,1);
});
test('repeated settlement observations cannot settle a segment before its native terminal',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();ctx.f.autoFinish=false;
 let settled=false;const continuing=ctx.answer([approvalAnswer(pending.approvals[0])]).then(value=>{settled=true;return value;});
 await tick();for(let i=0;i<65;i++)ctx.f.send({method:'serverRequest/resolved',params:{...ctx.f.turnIdentity,requestId:'approval-call'}});
 await tick();assert.equal(settled,false);ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);assert.equal((await continuing).kind,'complete');
});
test('terminal candidate overflow refuses later interactions without inventing a terminal',async(t)=>{
 const ctx=await openHost(t);let start;ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return {deferred:true};};
 const running=ctx.run();while(!start)await tick();
 for(let i=0;i<32;i++)ctx.f.send({method:'turn/completed',params:{threadId:start.threadId,turn:{id:'other-'+i,status:'completed',error:null}}});
 ctx.f.send({method:'turn/completed',params:{threadId:start.threadId,turn:{id:start.turnId,status:'completed',error:null}}});await tick();
 ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});assert.equal((await running).kind,'failed');
 ctx.f.request('too-late-after-overflow','item/fileChange/requestApproval',{threadId:start.threadId,turnId:start.turnId,itemId:'late'});await tick();
 assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length,0);assert.equal(ctx.f.replies.find(r=>r.id==='too-late-after-overflow').error.code,-32000);
 ctx.f.finishTurn(start.threadId,start.turnId);
});
test('an acknowledged fresh turn keeps acceptance through EOF without claiming completion',async(t)=>{
 const ctx=await openHost(t);ctx.f.handlers['turn/start']=(params)=>{ctx.f.turnIdentity={threadId:params.threadId,turnId:randomUUID()};return {turn:{id:ctx.f.turnIdentity.turnId,status:'inProgress'}};};
 const observations=[];const running=ctx.adapter.run({prompt:'EOF',signal:ctx.signal,hostOperationId:'acknowledged-eof',recordIntent(){},onObservation(e){observations.push(e);}});await tick();ctx.f.sink.ended('eof');const result=await running;
 assert.equal(result.kind,'failed');assert.equal(observations.findLast(e=>e.kind==='terminal').outcome,'outcome-unknown');assert.equal(result.write.kind,'accepted');assert.equal(result.write.evidence.nativeOperation.id,ctx.f.turnIdentity.turnId);assert.equal((await ctx.adapter.interrupt({timeoutMs:100})).kind,'unconfirmed-within-bound');
});
test('a native terminal stays definitive during fresh-run public event delivery',async(t)=>{
 const ctx=await openHost(t);let interrupted;
 ctx.adapter.events.subscribe(e=>{if(e.kind==='text-delta')interrupted=ctx.adapter.interrupt({timeoutMs:100});});
 assert.equal((await ctx.run(prompts.text)).kind,'complete');await tick();assert.equal((await interrupted).kind,'terminal-observed');assert.equal(ctx.f.sent.includes('turn/interrupt'),false);
});
test('overflow retains the matching failed terminal cause when that terminal was staged',async(t)=>{
 const ctx=await openHost(t);let start;ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return {deferred:true};};
 const running=ctx.run();while(!start)await tick();
 for(let i=0;i<33;i++)ctx.f.send({method:'item/agentMessage/delta',params:{threadId:start.threadId,turnId:start.turnId,itemId:'m',delta:'x'}});
 ctx.f.send({method:'turn/completed',params:{threadId:start.threadId,turn:{id:start.turnId,status:'failed',error:{message:'direct cause'}}}});await tick();ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});
 const result=await running;assert.equal(result.kind,'failed');assert.equal(result.write.kind,'accepted');assert.equal(result.nativeError.source,'turn.error');assert.equal(result.nativeError.message,'direct cause');
});

test('reasoning requires the thread and turn identity in the pinned native notification DTO',async(t)=>{
 const ctx=await openHost(t);let start;const observed=[];
 ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return {deferred:true};};
 const running=ctx.adapter.run({prompt:'reasoning',signal:ctx.signal,hostOperationId:'reasoning-identity',recordIntent(){},onObservation(e){observed.push(e);}});while(!start)await tick();
 const malformed={threadId:start.threadId,itemId:'reason',delta:'unscoped',contentIndex:0};ctx.f.send({method:'item/reasoning/textDelta',params:malformed});await tick();
 ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});await tick();ctx.f.send({method:'item/reasoning/textDelta',params:malformed});
 ctx.f.send({method:'item/reasoning/textDelta',params:{thread:{id:start.threadId},turnId:start.turnId,itemId:'reason',delta:'nested',contentIndex:0}});
 ctx.f.send({method:'item/agentMessage/delta',params:{threadId:'wrong-thread',thread:{id:start.threadId},turnId:start.turnId,itemId:'m',delta:'foreign'}});
 ctx.f.send({method:'item/reasoning/textDelta',params:{...malformed,turnId:start.turnId,delta:'scoped'}});ctx.f.finishTurn(start.threadId,start.turnId);
 const result=await running;assert.equal(result.kind,'complete');assert.equal(result.text,'');assert.deepEqual(observed.filter(e=>e.kind==='reasoning').map(e=>e.text),['scoped']);
});

test('an approval withdrawn in the same intake drain cannot pause a waiting continuation',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();ctx.f.autoFinish=false;
 let settled=false;const continuing=ctx.answer([approvalAnswer(pending.approvals[0])]).then(value=>{settled=true;return value;});await tick();
 const request={id:'transient',method:'item/fileChange/requestApproval',params:{...ctx.f.turnIdentity,itemId:'transient'}};
 ctx.f.sink.data(Buffer.from(JSON.stringify(request)+'\n'+JSON.stringify({method:'serverRequest/resolved',params:{...ctx.f.turnIdentity,requestId:'transient'}})+'\n'));
 await tick();assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length,0);assert.equal(settled,false);
 ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);assert.equal((await continuing).kind,'complete');
});
test('the entire queued mixed batch is refused if another member withdraws before its first writer entry',async(t)=>{
 const ctx=await openHost(t);const events=[];ctx.adapter.events.subscribe(e=>events.push(e));approvalTurns(ctx.f,{mixed:true});const pending=await ctx.run();ctx.f.autoFinish=false;
 const release=await blockWriterBehindList(ctx);const continuing=ctx.answer([approvalAnswer(pending.approvals[0]),callAnswer(pending.calls[0])]);await tick();
 ctx.f.send({method:'serverRequest/resolved',params:{...ctx.f.turnIdentity,requestId:'host-call'}});await tick();release();const result=await continuing;await tick();
 assert.equal(result.kind,'failed');assert.equal(result.write.kind,'not-dispatched');assert.equal(ctx.f.replies.filter(r=>r.result).length,0);
 const settlements=events.filter(e=>e.kind==='interaction-settled');assert.equal(settlements.length,2);assert.deepEqual(settlements.map(e=>e.settlement.data.kind).sort(),['lost','withdrawn']);assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.calls.length,0);
 ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);
});
test('public approval redaction cannot change native withdrawal correlation',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f);const pending=await ctx.run();ctx.f.autoFinish=false;
 const release=await blockWriterBehindList(ctx);const continuing=ctx.answer([approvalAnswer(pending.approvals[0])]);await tick();
 pending.approvals[0].request.data.params.threadId='[redacted]';ctx.f.send({method:'serverRequest/resolved',params:{...ctx.f.turnIdentity,requestId:'approval-call'}});await tick();release();const result=await continuing;await tick();
 assert.equal(result.write.kind,'not-dispatched');assert.equal(ctx.f.replies.filter(r=>r.result).length,0);ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);
});
test('failure after a selected reply actually enters the writer stays outcome-unknown',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f,{mixed:true});const pending=await ctx.run();ctx.f.autoFinish=false;
 const original=ctx.f.channel.write.bind(ctx.f.channel);const entered=Promise.withResolvers();let release;const gate=new Promise(r=>{release=r;});let positive=0;
 ctx.f.channel.write=(bytes)=>{const message=JSON.parse(Buffer.from(bytes));const written=original(bytes);if(message.result&&++positive===1){entered.resolve();return gate;}return written;};
 const continuing=ctx.answer([callAnswer(pending.calls[0]),approvalAnswer(pending.approvals[0])]);await entered.promise;
 ctx.f.send({method:'serverRequest/resolved',params:{...ctx.f.turnIdentity,requestId:'approval-call'}});ctx.f.send({method:'turn/completed',params:{threadId:ctx.f.turnIdentity.threadId,turn:{id:ctx.f.turnIdentity.turnId,status:'interrupted',error:null}}});release();
 const result=await continuing;await tick();assert.equal(result.kind,'failed');assert.equal(result.write.kind,'outcome-unknown');assert.equal(ctx.f.replies.filter(r=>r.result).length,1);
});
test('an outstanding interrupt observes host-attested exit without inventing the prior outcome',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f);await ctx.run();ctx.f.handlers['turn/interrupt']=()=>({deferred:true});
 const interrupted=ctx.adapter.interrupt({timeoutMs:1000});while(!ctx.f.sent.includes('turn/interrupt'))await tick();ctx.f.attestExit();
 assert.equal((await interrupted).kind,'terminal-observed');assert.equal(ctx.f.replies.some(r=>r.result?.decision),false);
});

test('queued mixed targets emit loss on EOF before positive writer admission', async (t) => {
 const ctx=await openHost(t);approvalTurns(ctx.f,{mixed:true});const events=[];ctx.adapter.events.subscribe(e=>events.push(e));
 const pending=await ctx.run();ctx.f.autoFinish=false;const release=await blockWriterBehindList(ctx);
 const continuing=ctx.answer([approvalAnswer(pending.approvals[0]),callAnswer(pending.calls[0])]);await tick();
 ctx.f.sink.ended('eof');const result=await continuing;release();await tick();
 assert.equal(result.write.kind,'not-dispatched');assert.equal(ctx.f.replies.filter(r=>r.result).length,0);
 const settlements=events.filter(e=>e.kind==='interaction-settled');assert.equal(settlements.length,2);assert.ok(settlements.every(e=>e.settlement.data.kind==='lost'&&e.settlement.data.cause==='eof'));
});
for (const activityMethod of ['item/commandExecution/outputDelta', 'item/fileChange/patchUpdated']) test(`old lifetime activity ${activityMethod} before a new acknowledgement cannot poison the new segment`,async(t)=>{
 const ctx=await openHost(t,{activity:'items'});let start;ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return{deferred:true};};
 const events=[];ctx.adapter.events.subscribe(e=>events.push(e));const running=ctx.run('text');while(!start)await tick();
 const old= randomUUID();for(let i=0;i<40;i++)ctx.f.send({method:activityMethod,params:{threadId:start.threadId,turnId:old,itemId:'old',delta:'old output'}});
 ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});ctx.f.finishTurn(start.threadId,start.turnId);
 assert.equal((await running).kind,'complete');await tick();assert.equal(events.filter(e=>e.kind==='native-item').length,40);
});
test('an unanswerable composite native tool identity is refused before becoming pending',async(t)=>{
 const ctx=await openHost(t);let start;ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return{deferred:true};};
 const running=ctx.run('text');while(!start)await tick();ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});await tick();
 ctx.f.send({id:'oversized-call',method:'item/tool/call',params:{threadId:start.threadId,turnId:start.turnId,callId:'x'.repeat(1024),namespace:'application',tool:toolName,arguments:{}}});await tick();
 assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.calls.length,0);assert.ok(ctx.f.replies.find(r=>r.id==='oversized-call')?.error);
 ctx.f.finishTurn(start.threadId,start.turnId);assert.equal((await running).kind,'complete');
});
test('bounded retained native error info cannot be changed through a public result',()=>{
 const cause=codexNativeError('turn.error',{message:'failed',codexErrorInfo:{nested:{message:'original'}}});
 assert.throws(()=>{cause.info.nested.message='x'.repeat(2000);},TypeError);assert.equal(cause.info.nested.message,'original');
});
test('native catalog ignores a late final page even before the timeout callback runs',async(t)=>{
 const ctx=await openHost(t);let now=0;t.mock.method(performance,'now',()=>now);ctx.f.handlers['model/list']=()=>{now=5001;return{data:[],nextCursor:null};};
 assert.equal((await ctx.adapter.capabilities.models.api.list(ctx.signal)).error.code,'unavailable');
});

test('native turn withdrawal classifies every staged mixed target before batch refusal',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f,{mixed:true});const events=[];ctx.adapter.events.subscribe(e=>events.push(e));const pending=await ctx.run();ctx.f.autoFinish=false;
 const release=await blockWriterBehindList(ctx);const continuing=ctx.answer([approvalAnswer(pending.approvals[0]),callAnswer(pending.calls[0])]);await tick();
 ctx.f.send({method:'turn/completed',params:{threadId:ctx.f.turnIdentity.threadId,turn:{id:ctx.f.turnIdentity.turnId,status:'interrupted',error:null}}});release();
 assert.equal((await continuing).write.kind,'not-dispatched');await tick();const settled=events.filter(e=>e.kind==='interaction-settled');assert.equal(settled.length,2);assert.ok(settled.every(e=>e.settlement.data.kind==='withdrawn'&&e.settlement.data.by==='turn/completed'));
});
test('one item completion withdraws all unanswered approvals for that native item',async(t)=>{
 const ctx=await openHost(t);approvalTurns(ctx.f);const events=[];ctx.adapter.events.subscribe(e=>events.push(e));await ctx.run();ctx.f.autoFinish=false;
 ctx.f.send({id:'second-same-item',method:'item/commandExecution/requestApproval',params:{...ctx.f.turnIdentity,itemId:'approval-item',availableDecisions:['accept','cancel']}});await tick();
 assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length,2);
 ctx.f.send({method:'item/completed',params:{...ctx.f.turnIdentity,item:{id:'approval-item',type:'commandExecution',status:'declined'}}});await tick();
 assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length,0);assert.equal(events.filter(e=>e.kind==='interaction-settled').length,2);ctx.f.finishTurn(ctx.f.turnIdentity.threadId,ctx.f.turnIdentity.turnId);
});
for(const policy of [undefined,'never'])test(`direct policy ${policy??'omitted'} refuses unexpected native approval requests`,async(t)=>{
 const ctx=await openHost(t,{approvalPolicy:policy});approvalTurns(ctx.f);const result=await ctx.run();await tick();assert.equal(result.kind,'complete');
 assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length,0);assert.ok(ctx.f.replies.find(r=>r.id==='approval-call')?.error);assert.equal(ctx.f.replies.some(r=>r.result?.decision),false);
});
test('ordinary pre-ack data overflow refuses later approval admission for the failed turn',async(t)=>{
 const ctx=await openHost(t);let start;ctx.f.handlers['turn/start']=(params,id)=>{start={...params,id,turnId:randomUUID()};return{deferred:true};};const running=ctx.run();while(!start)await tick();
 for(let i=0;i<33;i++)ctx.f.send({method:'item/agentMessage/delta',params:{threadId:start.threadId,turnId:start.turnId,itemId:'text',delta:'x'}});
 ctx.f.send({id:start.id,result:{turn:{id:start.turnId,status:'inProgress'}}});ctx.f.send({id:'late-after-overflow',method:'item/commandExecution/requestApproval',params:{threadId:start.threadId,turnId:start.turnId,itemId:'late',availableDecisions:['accept']}});
 assert.equal((await running).kind,'failed');await tick();assert.equal((await ctx.adapter.capabilities.inspect.api.pending(ctx.signal)).value.approvals.length,0);assert.ok(ctx.f.replies.find(r=>r.id==='late-after-overflow')?.error);ctx.f.finishTurn(start.threadId,start.turnId);
});
