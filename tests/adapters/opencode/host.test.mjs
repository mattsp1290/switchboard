import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { setImmediate } from 'node:timers/promises';
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
const { opencodeHostAdapter, OPENCODE_HOST_ACP_VERSION } = await import(new URL('adapters/opencode/index.ts', src).href);
const { openOpenCodeProtocol } = await import(new URL('adapters/opencode/protocol.ts', src).href);
hook.deregister();

const executable = '/usr/bin/opencode';
const cwd = '/work';
const model = 'provider/model-id';
const account = 'account';
const rejectedUpdate = 'OpenCode sent an update this session cannot accept.';
const incompleteTurn = 'OpenCode turn did not complete.';
const authenticationRequired = 'OpenCode authentication is required.';
const inspectReason = 'OpenCode text sessions do not expose pending host calls.';
const fingerprintReason = 'OpenCode text sessions do not expose a history fingerprint.';

function createAgent() {
  const state = { requests: [], notifications: [], responses: [], attempts: 0, signals: 0, stdinEnded: 0, spawned: [] };
  const options = { auto: true, eofOnEndInput: true, resolveOnEndInput: true, sessionId: 'session-1' };
  let sink;
  let resolveExit = () => {};
  let rejectExit = () => {};
  const processExit = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  let releaseClose = () => {};
  function deliver(bytes) {
    if (typeof sink !== 'function') throw new Error('the channel is not listening');
    sink(bytes);
  }
  function push(value) {
    deliver(Buffer.from(`${JSON.stringify(value)}\n`));
  }
  function note(message) {
    assert.equal(message.jsonrpc, '2.0');
    if (message.method !== undefined && message.id !== undefined) {
      assert.equal(typeof message.id, 'number');
      state.requests.push(message);
    } else if (message.method !== undefined) {
      assert.equal(Object.hasOwn(message, 'id'), false);
      state.notifications.push(message);
    } else state.responses.push(message);
  }
  function autoRespond(message) {
    if (message.id === undefined || message.method === undefined) return;
    if (message.method === 'session/close') {
      push({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (!options.auto) return;
    if (message.method === 'initialize') push({ jsonrpc: '2.0', id: message.id, result: options.initializeResult ?? { protocolVersion: 1 } });
    else if (message.method === 'session/new') {
      if (options.newResult) {
        push({ jsonrpc: '2.0', id: message.id, ...options.newResult });
        return;
      }
      push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: options.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } });
      push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: options.sessionId, update: {
        sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'dir/default' }] } } });
      push({ jsonrpc: '2.0', id: message.id, result: { sessionId: options.sessionId, configOptions: [
        { id: 'model', type: 'select', currentValue: 'dir/default', options: [{ group: 'provider' }] }] } });
    } else if (message.method === 'session/set_config_option') {
      push({ jsonrpc: '2.0', id: message.id, ...(options.configResult ?? { result: { configOptions: [
        { id: 'model', currentValue: message.params.value, options: [{ group: 'provider', options: ['ignored'] }] }] } }) });
    }
  }
  const channel = {
    listen(next) { sink = next; return () => {}; },
    write(frame) {
      const text = Buffer.from(frame).toString('utf8');
      assert.equal(text.endsWith('\n'), true);
      const recorded = [];
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        const message = JSON.parse(line);
        note(message);
        recorded.push(message);
      }
      const respond = () => { for (const message of recorded) autoRespond(message); };
      if (options.deferCloseWrite && recorded.some((message) => message.method === 'session/close')) {
        return new Promise((resolve) => { releaseClose = () => { respond(); resolve(); }; });
      }
      respond();
      return Promise.resolve();
    },
    endInput() {
      state.stdinEnded += 1;
      if (options.eofOnEndInput && typeof sink?.ended === 'function') sink.ended();
      if (options.resolveOnEndInput) resolveExit();
    },
  };
  return { state, channel, processExit, resolveExit, rejectExit, options, push, deliver, releaseClose() { releaseClose(); }, endOutput() { sink.ended(); } };
}

function launchOf(agent, deny = false) {
  return { kind: 'spawn', spawn(request, spawnSignal) {
    agent.state.attempts += 1;
    agent.state.spawnSignal = spawnSignal;
    agent.state.spawned.push(request);
    if (deny) throw new Error('denied');
    return { channel: agent.channel, processExit: agent.processExit, kill() { agent.state.signals += 1; } };
  } };
}

async function openReady(extra = {}) {
  const agent = extra.agent ?? createAgent();
  const signal = extra.signal ?? AbortSignal.timeout(10000);
  const variables = extra.variables ?? { PATH: '/host/bin', SWITCHBOARD_HOST_ONLY: 'kept' };
  const opened = await opencodeHostAdapter.open({
    ...(extra.omitModel ? {} : { model: extra.model ?? model }),
    environment: extra.environment ?? { variables, nativeConfig: {
      cwd: extra.cwd ?? cwd, executable: extra.executable ?? executable, account: extra.account ?? account } },
    ...(extra.omitLaunch ? {} : { launch: extra.launch ?? launchOf(agent, extra.deny === true) }),
    ...extra.fields,
  }, signal);
  return { agent, opened, signal, variables };
}

async function untilRequest(agent, method, after = 0) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = agent.state.requests.find((message) => message.method === method && message.id > after);
    if (found) return found;
    await setImmediate();
  }
  throw new Error(`no ${method} request`);
}

function collect(adapter) {
  const events = [];
  const subscribed = adapter.events.subscribe((event) => { events.push(event); });
  assert.equal(subscribed.kind, 'ok');
  return events;
}

function textUpdate(text, messageId = 'm', extra = {}) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: {
    sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text }, ...extra } } };
}

async function withSession(fn) {
  const ready = await openReady();
  assert.equal(ready.opened.kind, 'ok', JSON.stringify(ready.opened));
  try { await fn({ ...ready, adapter: ready.opened.value }); }
  finally {
    ready.agent.options.resolveOnEndInput = true;
    ready.agent.options.eofOnEndInput = true;
    await ready.opened.value.close();
  }
}

test('the OpenCode host identity is ACP version 1', () => {
  assert.equal(OPENCODE_HOST_ACP_VERSION, '1');
  assert.deepEqual(opencodeHostAdapter.identity, { engine: 'opencode', adapter: 'opencode-host', version: '1', contractVersion: 1 });
});

test('spawn receives the host argv, cwd, env, and open signal', async () => {
  const signal = AbortSignal.timeout(10000);
  const ready = await openReady({ signal });
  assert.equal(ready.opened.kind, 'ok', JSON.stringify(ready.opened));
  assert.equal(ready.agent.state.spawnSignal, signal);
  assert.deepEqual(ready.agent.state.spawned[0].args, [executable, 'acp']);
  assert.equal(ready.agent.state.spawned[0].executable, executable);
  assert.equal(ready.agent.state.spawned[0].cwd, cwd);
  assert.deepEqual(ready.agent.state.spawned[0].env, ready.variables);
  assert.equal(Object.hasOwn(ready.agent.state.spawned[0].env, 'HOME'), false);
  assert.equal(process.env.SWITCHBOARD_HOST_ONLY, undefined);
  assert.deepEqual(ready.agent.state.requests.map((message) => message.method), ['initialize', 'session/new', 'session/set_config_option']);
  assert.deepEqual(ready.agent.state.requests[1].params, { cwd, mcpServers: [] });
  assert.equal(ready.agent.state.requests[2].params.value, model);
  assert.equal(ready.agent.state.requests.some((message) => message.method === 'session/prompt'), false);
  await ready.opened.value.close();
});

test('a split line is parsed and a setup notification does not replace the model check', async () => {
  const agent = createAgent();
  agent.options.auto = false;
  const signal = AbortSignal.timeout(10000);
  const opening = opencodeHostAdapter.open({
    model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } }, launch: launchOf(agent),
  }, signal);
  const init = await untilRequest(agent, 'initialize');
  const payload = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } })}\n`);
  agent.deliver(payload.subarray(0, 5));
  await setImmediate();
  assert.equal(agent.state.requests.some((message) => message.method === 'session/new'), false);
  agent.deliver(payload.subarray(5));
  const created = await untilRequest(agent, 'session/new');
  agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'available_commands_update' } } });
  agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: {
    sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'dir/default' }] } } });
  agent.push({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'session-1', configOptions: [{ id: 'model', type: 'select', currentValue: 'dir/default' }] } });
  const configured = await untilRequest(agent, 'session/set_config_option');
  assert.deepEqual(configured.params, { sessionId: 'session-1', configId: 'model', value: model });
  agent.push({ jsonrpc: '2.0', id: configured.id, result: { configOptions: [{ id: 'model', currentValue: model }] } });
  const opened = await opening;
  assert.equal(opened.kind, 'ok', JSON.stringify(opened));
  assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
  await opened.value.close();
});

test('open fails when the model option is missing, rejected, or different', async () => {
  const cases = [
    { newResult: { result: { sessionId: 'session-1', configOptions: [] } }, code: 'unavailable', feature: 'model', close: true },
    { configResult: { error: { code: -32602, message: 'RAW secret option' } }, code: 'native-failure', close: true },
    { configResult: { result: { configOptions: [{ id: 'model', currentValue: 'other/model' }] } }, code: 'native-failure', close: true },
  ];
  for (const item of cases) {
    const agent = createAgent();
    if (item.newResult) agent.options.newResult = item.newResult;
    if (item.configResult) agent.options.configResult = item.configResult;
    const ready = await openReady({ agent });
    assert.equal(ready.opened.kind, 'error', JSON.stringify(ready.opened));
    assert.equal(ready.opened.error.code, item.code);
    if (item.feature) assert.equal(ready.opened.error.feature, item.feature);
    assert.equal(JSON.stringify(ready.opened).includes('RAW secret'), false);
    assert.equal(JSON.stringify(ready.opened).includes('other/model'), false);
    assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
    assert.equal(agent.state.stdinEnded, 1);
    if (item.close) assert.equal(agent.state.requests.some((message) => message.method === 'session/close'), true);
  }
});

test('illegal open input fails before a session', async () => {
  const relative = await openReady({ cwd: 'work' });
  assert.equal(relative.opened.kind, 'error');
  assert.equal(relative.opened.error.code, 'invalid-input');
  assert.equal(relative.agent.state.attempts, 0);
  const blank = await openReady({ model: ' ' });
  assert.equal(blank.opened.error.code, 'invalid-input');
  assert.equal(blank.agent.state.attempts, 0);
  const spaced = await openReady({ model: ' provider/model-id' });
  assert.equal(spaced.opened.error.code, 'invalid-input');
  const missingModel = await openReady({ omitModel: true });
  assert.equal(missingModel.opened.error.code, 'invalid-input');
  assert.equal(missingModel.agent.state.attempts, 0);
  const longCwd = `/${'a'.repeat(1024)}`;
  const long = await openReady({ cwd: longCwd });
  assert.equal(long.opened.error.code, 'invalid-input');
  assert.equal(long.agent.state.attempts, 0);
  const missingLaunch = await openReady({ omitLaunch: true });
  assert.equal(missingLaunch.opened.error.code, 'unsupported');
  assert.equal(missingLaunch.opened.error.feature, 'host-launcher');
  const denied = await openReady({ deny: true });
  assert.equal(denied.opened.error.code, 'unavailable');
  assert.equal(denied.opened.error.feature, 'host-launcher');
  assert.equal(denied.agent.state.attempts, 1);
});

test('requested controls that this slice cannot apply are refused before spawn', async () => {
  const cases = [
    [{ resume: { session: { kind: 'session' } } }, 'unsupported', 'session-load'],
    [{ route: { config: { kind: 'direct' }, scope: { engine: 'opencode', account } } }, 'unavailable', 'host-route'],
    [{ instructions: '' }, 'unavailable', 'instructions'],
    [{ tools: [{ name: 'lookup', description: 'look', inputSchema: {} }] }, 'unavailable', 'host-tools'],
    [{ builtInTools: [] }, 'unavailable', 'built-in-tools'],
    [{ subagents: 'off' }, 'unavailable', 'subagents'],
  ];
  for (const [fields, code, feature] of cases) {
    const ready = await openReady({ fields });
    assert.equal(ready.opened.kind, 'error', JSON.stringify(ready.opened));
    assert.equal(ready.opened.error.code, code);
    assert.equal(ready.opened.error.feature, feature);
    assert.equal(ready.agent.state.attempts, 0);
  }
});

test('a text turn keeps every delta and the caller stop reason', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const events = collect(adapter);
    assert.deepEqual(adapter.capabilities.inspect, { kind: 'unsupported', reason: inspectReason });
    assert.deepEqual(adapter.capabilities.fingerprint, { kind: 'unsupported', reason: fingerprintReason });
    let captured;
    const running = adapter.run({ prompt: 'hello\nworld', signal, hostOperationId: 'turn-1', recordIntent(identity) { captured = identity; } });
    const prompt = await untilRequest(agent, 'session/prompt');
    assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'hello\nworld' }]);
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'plan', entries: [{ content: 'PLAN_TEXT' }] } } });
    agent.push(textUpdate('hel'));
    agent.push(textUpdate('lo'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } } });
    const result = await running;
    assert.equal(result.kind, 'complete', JSON.stringify(result));
    assert.equal(result.text, 'hello');
    assert.equal(result.text.includes('PLAN_TEXT'), false);
    assert.deepEqual(events.map((event) => event.text), ['hel', 'lo']);
    assert.equal(result.usage.scope, 'segment');
    assert.equal(result.usage.native.namespace, 'opencode-acp/turn');
    assert.equal(result.usage.native.data.stopReason, 'end_turn');
    assert.deepEqual(result.usage.native.data.usage, { input_tokens: 2, output_tokens: 1 });
    assert.equal(captured.target.kind, 'session');
    assert.deepEqual(captured.target.reference, result.session);
    const again = adapter.run({ prompt: 'next', signal, hostOperationId: 'turn-2', recordIntent() {} });
    const second = await untilRequest(agent, 'session/prompt', prompt.id);
    agent.push({ jsonrpc: '2.0', id: second.id, result: { stopReason: 'max_tokens', usage: null } });
    const limited = await again;
    assert.equal(limited.kind, 'complete', JSON.stringify(limited));
    assert.equal(limited.usage.native.data.stopReason, 'max_tokens');
    assert.equal(limited.usage.native.data.usage, null);
  });
});

test('one chunk of more deltas than the event capacity is delivered in order', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const events = collect(adapter);
    const running = adapter.run({ prompt: 'burst', signal, hostOperationId: 'burst', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = Array.from({ length: 80 }, (_, index) => JSON.stringify(textUpdate(String(index), 'burst'))).join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    const result = await running;
    assert.equal(result.kind, 'complete', JSON.stringify({ kind: result.kind, events: events.length, text: result.kind === 'complete' ? result.text : result }));
    assert.equal(events.length, 80);
    assert.deepEqual(events.map((event) => event.text), Array.from({ length: 80 }, (_, index) => String(index)));
    assert.equal(result.text, Array.from({ length: 80 }, (_, index) => String(index)).join(''));
  });
});

test('ignored updates do not change the completed text', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'keep', signal, hostOperationId: 'keep', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(textUpdate('A'));
    for (const sessionUpdate of ['usage_update', 'agent_thought_chunk', 'user_message_chunk', 'session_info_update', 'current_mode_update']) {
      agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate, text: 'HIDDEN' } } });
    }
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: {
      sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: model }] } } });
    agent.push(textUpdate('B'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    const result = await running;
    assert.equal(result.kind, 'complete', JSON.stringify(result));
    assert.equal(result.text, 'AB');
    assert.equal(JSON.stringify(result).includes('HIDDEN'), false);
  });
});

test('a tool call, child session, or model change fails the segment', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const cases = [
      { update: { sessionUpdate: 'tool_call', title: 'SECRET_TOOL', rawInput: { command: 'rm -rf SECRET_TOOL' } }, sentinel: 'SECRET_TOOL' },
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECRET_CHILD' }, _meta: { 'opencode/child-session': { id: 'child' } } }, sentinel: 'SECRET_CHILD' },
      { update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'SECRET_MODEL' }] }, sentinel: 'SECRET_MODEL' },
    ];
    let after = 0;
    for (const item of cases) {
      let captured;
      const running = adapter.run({ prompt: 'go', signal, hostOperationId: `bad-${after}`, recordIntent(identity) { captured = identity; } });
      const prompt = await untilRequest(agent, 'session/prompt', after);
      after = prompt.id;
      const beforeCancel = agent.state.notifications.length;
      agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: item.update } });
      agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
      const result = await running;
      assert.equal(result.kind, 'failed', JSON.stringify(result));
      assert.equal(result.error.message, rejectedUpdate);
      assert.equal(result.write.kind, 'accepted');
      assert.deepEqual(result.write.evidence.identity, captured);
      assert.equal(JSON.stringify(result).includes(item.sentinel), false);
      assert.equal(agent.state.notifications.slice(beforeCancel).some((message) => message.method === 'session/cancel'), true);
    }
  });
});

test('permission is cancelled and filesystem or terminal requests are unknown', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'permit', signal, hostOperationId: 'permit', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: 70, method: 'session/request_permission', params: {
      sessionId: 'session-1', options: [{ optionId: 'allow', kind: 'allow_once' }] } });
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    const permitted = await running;
    assert.equal(permitted.kind, 'failed');
    assert.equal(permitted.write.kind, 'accepted');
    const answer = agent.state.responses.find((message) => message.id === 70);
    assert.deepEqual(answer.result, { outcome: { outcome: 'cancelled' } });
    assert.equal(JSON.stringify(answer).includes('optionId'), false);
    assert.equal(agent.state.notifications.some((message) => message.method === 'session/cancel'), true);
    let after = prompt.id;
    for (const [method, id] of [['fs/read_text_file', 71], ['fs/write_text_file', 72], ['terminal/create', 73]]) {
      const next = adapter.run({ prompt: method, signal, hostOperationId: `req-${id}`, recordIntent() {} });
      const request = await untilRequest(agent, 'session/prompt', after);
      after = request.id;
      agent.push({ jsonrpc: '2.0', id, method, params: { path: '/secret/file', command: 'bash -c secret-command' } });
      agent.push({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });
      const result = await next;
      assert.equal(result.kind, 'failed', JSON.stringify(result));
      assert.equal(result.error.message, rejectedUpdate);
      assert.equal(JSON.stringify(result).includes('/secret/file'), false);
      assert.equal(JSON.stringify(result).includes('secret-command'), false);
      assert.equal(agent.state.responses.find((message) => message.id === id).error.code, -32601);
    }
    assert.equal(JSON.stringify(agent.state.responses).includes('allow_once'), false);
    assert.equal(JSON.stringify(agent.state.responses).includes('selected'), false);
  });
});

function update(sessionUpdate, fields = {}) {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate, ...fields } } };
}
function observed(onObservation) {
  const rows = [];
  return { rows, listener(observation) { rows.push(observation); onObservation?.(observation); } };
}

test('a placeholder {} rawInput emits no arguments; the first real input does', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'tool-placeholder', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(update('tool_call', { toolCallId: 'call-1', kind: 'execute', status: 'pending', rawInput: {} }));
    agent.push(update('tool_call_update', { toolCallId: 'call-1', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } }));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    const tools = seen.rows.filter((row) => row.kind === 'tool');
    assert.equal(tools.some((row) => row.argumentsJson === '{}'), false, JSON.stringify(tools));
    assert.equal(tools[0].phase, 'started');
    for (const row of tools.slice(1)) if (row.phase === 'arguments') assert.equal(row.argumentsJson, '{"command":"ls"}');
  });
});

test('a listener sees a tool call first, named by kind, while the segment still fails and cancels', async () => {
  for (const [sessionUpdate, status] of [['tool_call', 'in_progress'], ['tool_call_update', 'completed'], ['tool_call_update', 'failed']]) {
    await withSession(async ({ adapter, agent, signal }) => {
      const seen = observed();
      const running = adapter.run({ prompt: 'go', signal, hostOperationId: `tool-${status}`, recordIntent() {}, onObservation: seen.listener });
      const prompt = await untilRequest(agent, 'session/prompt');
      const beforeCancel = agent.state.notifications.length;
      agent.push(update(sessionUpdate, { toolCallId: 'call-1', kind: 'execute', title: 'SECRET_TITLE', status,
        rawInput: { command: 'ls' }, rawOutput: { out: 'ok' } }));
      agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
      const result = await running;
      assert.equal(result.kind, 'failed', JSON.stringify(result));
      assert.equal(result.error.message, rejectedUpdate);
      assert.equal(agent.state.notifications.slice(beforeCancel).some((message) => message.method === 'session/cancel'), true);
      const tools = seen.rows.filter((row) => row.kind === 'tool');
      assert.equal(JSON.stringify(seen.rows).includes('SECRET_TITLE'), false);
      assert.equal(seen.rows[0].kind, 'run-started');
      assert.equal(seen.rows.findIndex((row) => row.kind === 'tool') < seen.rows.findIndex((row) => row.kind === 'terminal'), true);
      assert.equal(tools.every((row) => row.callId === 'call-1' && row.name === 'execute'), true);
      if (status === 'in_progress') {
        assert.deepEqual(tools.map((row) => row.phase), ['started', 'arguments']);
        assert.equal(tools[1].argumentsJson, '{"command":"ls"}');
      } else if (status === 'completed') {
        // a call first seen already closed still emits `started` before its closing phase
        assert.deepEqual(tools.map((row) => [row.phase, row.argumentsJson, row.resultJson]),
          [['started', undefined, undefined], ['arguments-ended', '{"command":"ls"}', '{"out":"ok"}']]);
      } else assert.deepEqual(tools.map((row) => row.phase), ['started', 'failed']);
      assert.deepEqual(seen.rows.at(-1), { kind: 'terminal', outcome: 'failed' });
    });
  }
});

test('only the first disallowed tool update is observed; later updates are gated after the failure', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'tool-kind-reuse', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(update('tool_call', { toolCallId: 'call-1', kind: 'execute', status: 'pending', rawInput: {} }));
    agent.push(update('tool_call_update', { toolCallId: 'call-1', status: 'in_progress', rawInput: { command: 'ls' } }));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    await running;
    const tools = seen.rows.filter((row) => row.kind === 'tool');
    assert.deepEqual(tools.map((row) => row.phase), ['started']);
    assert.equal(tools.every((row) => row.name === 'execute'), true, JSON.stringify(tools));
  });
});

test('a tool call without a kind is named other', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'nokind', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(update('tool_call', { toolCallId: 'call-2', title: 'SECRET_TITLE' }));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    assert.equal((await running).kind, 'failed');
    assert.deepEqual(seen.rows.find((row) => row.kind === 'tool'), { kind: 'tool', callId: 'call-2', name: 'other', phase: 'started' });
  });
});

test('a live thought and usage update are observed and do not fail the segment', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'live', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(update('agent_thought_chunk', { messageId: 't', content: { type: 'text', text: 'think' } }));
    agent.push(update('agent_thought_chunk', { content: { type: 'image', data: 'x' } }));
    agent.push(update('usage_update', { used: 5, size: 10, cost: { amount: 0.1, currency: 'USD' } }));
    agent.push(textUpdate('A'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    const result = await running;
    assert.equal(result.kind, 'complete', JSON.stringify(result));
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'reasoning'), [{ kind: 'reasoning', messageId: 't', mode: 'delta', text: 'think' }]);
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'usage'), []);
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'text'), [{ kind: 'text', messageId: 'm', mode: 'delta', text: 'A' }]);
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'unsupported').map((row) => row.family),
      ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents']);
    assert.deepEqual(seen.rows.at(-1), { kind: 'terminal', outcome: 'success' });
    assert.equal(seen.rows.filter((row) => row.kind === 'terminal').length, 1);
  });
});

test('thought and usage updates during setup do not fail open', async () => {
  const agent = createAgent();
  const original = agent.channel.write;
  agent.channel.write = (frame) => {
    const text = Buffer.from(frame).toString('utf8');
    const written = original(frame);
    if (text.includes('"session/new"')) {
      agent.push(update('agent_thought_chunk', { content: { type: 'text', text: 'early' } }));
      agent.push(update('usage_update', { inputTokens: 1 }));
    }
    return written;
  };
  const ready = await openReady({ agent });
  assert.equal(ready.opened.kind, 'ok', JSON.stringify(ready.opened));
  await ready.opened.value.close();
});

test('an idle thought or usage update is ignored without observation', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'idle', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    assert.equal((await running).kind, 'complete');
    agent.push(update('agent_thought_chunk', { content: { type: 'text', text: 'late' } }));
    agent.push(update('usage_update', { inputTokens: 1 }));
    await setImmediate();
    assert.equal(seen.rows.some((row) => row.kind === 'reasoning' || row.kind === 'usage'), false);
    const next = adapter.run({ prompt: 'next', signal, hostOperationId: 'idle-2', recordIntent() {} });
    const request = await untilRequest(agent, 'session/prompt', prompt.id);
    agent.push({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });
    assert.equal((await next).kind, 'complete');
  });
});

test('a permission request still fails the segment, is observed as an interrupt, and ends failed', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'permit', signal, hostOperationId: 'perm', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: 70, method: 'session/request_permission', params: {
      sessionId: 'session-1', toolCall: { toolCallId: 'call-9', title: 'SECRET_TITLE' }, options: [{ optionId: 'allow', kind: 'allow_once' }] } });
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    const result = await running;
    assert.equal(result.kind, 'failed');
    assert.deepEqual(agent.state.responses.find((message) => message.id === 70).result, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(seen.rows.find((row) => row.kind === 'interrupt'), { kind: 'interrupt', id: 'call-9', reason: 'permission' });
    assert.equal(JSON.stringify(seen.rows).includes('SECRET_TITLE'), false);
    assert.deepEqual(seen.rows.at(-1), { kind: 'terminal', outcome: 'failed' });
  });
});

test('a throwing listener changes no result and a non-function listener is invalid input', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'throws', recordIntent() {}, onObservation() { throw new Error('boom'); } });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(textUpdate('A'));
    agent.push(update('agent_thought_chunk', { content: { type: 'text', text: 't' } }));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    const result = await running;
    assert.equal(result.kind, 'complete', JSON.stringify(result));
    assert.equal(result.text, 'A');
    const bad = await adapter.run({ prompt: 'go', signal, hostOperationId: 'bad', recordIntent() {}, onObservation: 'nope' });
    assert.equal(bad.kind, 'failed');
    assert.equal(bad.error.code, 'invalid-input');
    assert.equal(bad.write.kind, 'not-attempted');
  });
});

test('authentication failures use the fixed message', async () => {
  for (const stage of ['session/new', 'session/set_config_option']) {
    const agent = createAgent();
    const body = { error: { code: -32000, message: 'https://secret.example/token' } };
    if (stage === 'session/new') agent.options.newResult = body;
    else agent.options.configResult = body;
    const ready = await openReady({ agent });
    assert.equal(ready.opened.kind, 'error');
    assert.equal(ready.opened.error.message, authenticationRequired);
    assert.equal(JSON.stringify(ready.opened).includes('secret.example'), false);
    assert.equal(ready.agent.state.stdinEnded, 1);
  }
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'auth', signal, hostOperationId: 'auth', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, error: { code: -32000, message: 'https://secret.example/token', data: { token: 'secret' } } });
    const result = await running;
    assert.equal(result.kind, 'failed');
    assert.equal(result.error.message, authenticationRequired);
    assert.equal(result.write.kind, 'accepted');
    assert.equal(JSON.stringify(result).includes('secret.example'), false);
  });
});

test('interrupt cancels only a written prompt and never signals the process', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    assert.equal((await adapter.interrupt({ timeoutMs: 20 })).kind, 'terminal-observed');
    assert.equal(agent.state.notifications.filter((message) => message.method === 'session/cancel').length, 0);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const events = collect(adapter);
    const held = adapter.run({ prompt: 'held', signal, hostOperationId: 'held', recordIntent: () => gate });
    await setImmediate();
    agent.push(textUpdate('EARLY'));
    await setImmediate();
    assert.deepEqual(events, []);
    assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
    assert.equal((await adapter.interrupt({ timeoutMs: 30 })).kind, 'unconfirmed-within-bound');
    assert.equal(agent.state.signals, 0);
    release();
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(textUpdate('LATE'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    const heldResult = await held;
    assert.equal(heldResult.kind, 'complete', JSON.stringify(heldResult));
    assert.equal(heldResult.text, 'LATE');
    const running = adapter.run({ prompt: 'cancel-me', signal, hostOperationId: 'cancel-me', recordIntent() {} });
    const active = await untilRequest(agent, 'session/prompt', prompt.id);
    const before = agent.state.notifications.length;
    const pending = adapter.interrupt({ timeoutMs: 1000 });
    await untilNotification(agent, before);
    assert.equal(agent.state.notifications.slice(before).every((message) => message.method === 'session/cancel'), true);
    assert.deepEqual(agent.state.notifications.at(-1).params, { sessionId: 'session-1' });
    agent.push({ jsonrpc: '2.0', id: active.id, result: { stopReason: 'cancelled' } });
    assert.equal((await pending).kind, 'terminal-observed');
    const cancelled = await running;
    assert.equal(cancelled.kind, 'failed');
    assert.equal(cancelled.error.message, incompleteTurn);
    assert.equal(agent.state.signals, 0);
    const quiet = adapter.run({ prompt: 'quiet', signal, hostOperationId: 'quiet', recordIntent() {} });
    const quietPrompt = await untilRequest(agent, 'session/prompt', active.id);
    const marks = agent.state.notifications.length;
    assert.equal((await adapter.interrupt({ timeoutMs: 0 })).kind, 'unconfirmed-within-bound');
    assert.equal(agent.state.notifications.length, marks);
    const slow = adapter.interrupt({ timeoutMs: 40 });
    assert.equal((await slow).kind, 'unconfirmed-within-bound');
    let settled = false;
    quiet.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    agent.push({ jsonrpc: '2.0', id: quietPrompt.id, result: { stopReason: 'end_turn', usage: {} } });
    assert.equal((await quiet).kind, 'complete');
    assert.equal(agent.state.signals, 0);
  });
});

function untilNotification(agent, before) {
  return (async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (agent.state.notifications.length > before) return agent.state.notifications.at(-1);
      await setImmediate();
    }
    throw new Error('no notification');
  })();
}

test('a slash prompt, a second run, and continue do not dispatch', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    let called = false;
    const slash = await adapter.run({ prompt: '/compact', signal, hostOperationId: 'slash', recordIntent() { called = true; } });
    assert.equal(slash.kind, 'failed');
    assert.equal(slash.error.code, 'invalid-input');
    assert.deepEqual(slash.write, { kind: 'not-attempted' });
    assert.equal(called, false);
    const prefixed = await adapter.run({ prompt: '/other', signal, hostOperationId: 'other', recordIntent() { called = true; } });
    assert.equal(prefixed.error.code, 'invalid-input');
    assert.equal(called, false);
    const running = adapter.run({ prompt: 'first', signal, hostOperationId: 'first', recordIntent() {} });
    await untilRequest(agent, 'session/prompt');
    const second = await adapter.run({ prompt: 'second', signal, hostOperationId: 'second', recordIntent() { called = true; } });
    assert.equal(second.error.code, 'busy');
    assert.deepEqual(second.write, { kind: 'not-attempted' });
    assert.equal(called, false);
    const continued = await adapter.continue({ answers: [], signal, hostOperationId: 'continue', recordIntent() { called = true; } });
    assert.equal(continued.error.code, 'unsupported');
    assert.equal(continued.error.feature, 'tool');
    assert.deepEqual(continued.write, { kind: 'not-attempted' });
    assert.equal(called, false);
    const prompt = agent.state.requests.find((message) => message.method === 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    await running;
  });
});

test('close ends stdin once and does not wait for the prompt', async () => {
  const ready = await openReady();
  assert.equal(ready.opened.kind, 'ok');
  const adapter = ready.opened.value;
  const running = adapter.run({ prompt: 'bye', signal: ready.signal, hostOperationId: 'bye', recordIntent() {} });
  await untilRequest(ready.agent, 'session/prompt');
  const closed = await adapter.close();
  assert.equal(closed.kind, 'ok', JSON.stringify(closed));
  assert.equal(ready.agent.state.stdinEnded, 1);
  const closes = ready.agent.state.requests.filter((message) => message.method === 'session/close');
  assert.equal(closes.length, 1);
  assert.deepEqual(closes[0].params, { sessionId: 'session-1' });
  await adapter.close();
  assert.equal(ready.agent.state.requests.filter((message) => message.method === 'session/close').length, 1);
  const result = await running;
  assert.equal(result.kind, 'failed');
  assert.equal(result.write.kind, 'outcome-unknown');
  assert.equal(ready.agent.state.signals, 0);
});

test('close reports an unobserved process exit', { timeout: 15000 }, async () => {
  const agent = createAgent();
  agent.options.resolveOnEndInput = false;
  const ready = await openReady({ agent });
  assert.equal(ready.opened.kind, 'ok');
  const running = ready.opened.value.run({ prompt: 'stuck', signal: ready.signal, hostOperationId: 'stuck', recordIntent() {} });
  await untilRequest(agent, 'session/prompt');
  const started = Date.now();
  const closed = await ready.opened.value.close();
  const elapsed = Date.now() - started;
  assert.equal(closed.kind, 'error');
  assert.deepEqual(closed.error, { code: 'native-failure', message: 'OpenCode process exit was not observed.' });
  assert.ok(elapsed >= 4800 && elapsed < 8000, `elapsed ${elapsed}`);
  assert.equal(agent.state.signals, 0);
  const result = await running;
  assert.equal(result.kind, 'failed');
  agent.resolveExit();
});

test('a cancelled prompt error does not copy the error body', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'gone', signal, hostOperationId: 'gone', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, error: { code: -32800, message: 'raw body secret', data: { body: 'raw body secret' } } });
    const result = await running;
    assert.equal(result.kind, 'failed');
    assert.equal(result.error.message, incompleteTurn);
    assert.equal(result.write.kind, 'accepted');
    assert.equal(JSON.stringify(result).includes('raw body secret'), false);
  });
});

test('aborting open after spawn ends stdin and does not signal', async () => {
  const agent = createAgent();
  agent.options.auto = false;
  const controller = new AbortController();
  const opening = opencodeHostAdapter.open({
    model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } }, launch: launchOf(agent),
  }, controller.signal);
  await untilRequest(agent, 'initialize');
  controller.abort();
  const opened = await opening;
  assert.equal(opened.kind, 'error', JSON.stringify(opened));
  assert.equal(opened.error.code, 'closed');
  assert.equal(agent.state.stdinEnded, 1);
  assert.equal(agent.state.signals, 0);
  assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
});

test('intent failure and an aborted run do not send the prompt', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const events = collect(adapter);
    const thrown = await adapter.run({ prompt: 'secret-intent', signal, hostOperationId: 'intent', recordIntent() { throw new Error('secret-intent'); } });
    assert.equal(thrown.write.kind, 'not-dispatched');
    assert.equal(thrown.write.reason, 'intent-failed');
    assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
    assert.equal(JSON.stringify(thrown).includes('secret-intent'), false);
    assert.deepEqual(events, []);
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const aborted = await adapter.run({ prompt: 'later', signal: controller.signal, hostOperationId: 'aborted-run', recordIntent() { called = true; } });
    assert.equal(called, false);
    assert.deepEqual(aborted.write, { kind: 'not-dispatched', reason: 'aborted' });
  });
});

test('a disallowed update before the prompt is written is outcome-unknown', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const running = adapter.run({ prompt: 'early-tool', signal, hostOperationId: 'early-tool', recordIntent: () => gate });
    await setImmediate();
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'SECRET_EARLY' } } });
    release();
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, rejectedUpdate);
    assert.equal(result.write.kind, 'outcome-unknown');
    assert.equal(JSON.stringify(result).includes('SECRET_EARLY'), false);
    assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
    assert.equal(agent.state.notifications.some((message) => message.method === 'session/cancel'), false);
    const next = await adapter.run({ prompt: 'after', signal, hostOperationId: 'after-early', recordIntent() {} });
    assert.equal(next.write.kind, 'not-attempted');
    assert.equal(next.error.message, rejectedUpdate);
  });
});

test('a prompt error followed by a tool call still cancels once', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'err-then-tool', signal, hostOperationId: 'err-then-tool', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, error: { code: -32603, message: 'raw body secret' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'SECRET_AFTER_ERROR' } } }),
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, incompleteTurn);
    assert.equal(result.write.kind, 'accepted');
    assert.equal(JSON.stringify(result).includes('raw body secret'), false);
    const cancels = agent.state.notifications.filter((message) => message.method === 'session/cancel');
    assert.equal(cancels.length, 1);
    assert.equal(Object.hasOwn(cancels[0], 'id'), false);
    assert.equal(agent.state.signals, 0);
  });
});

test('a refusal followed by a model change still cancels once', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'refuse-then-model', signal, hostOperationId: 'refuse-then-model', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'refusal', usage: {} } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: {
        sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'other/model' }] } } }),
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, incompleteTurn);
    assert.equal(agent.state.notifications.filter((message) => message.method === 'session/cancel').length, 1);
    assert.equal(agent.state.signals, 0);
  });
});

test('EOF after a yielded line still judges the rest of the chunk', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'eof-yield', signal, hostOperationId: 'eof-yield', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } }),
      JSON.stringify(textUpdate('before-tool')),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'late-tool' } } }),
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    agent.endOutput();
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.notEqual(result.kind, 'complete');
    assert.equal(result.error.message, rejectedUpdate);
    assert.equal(result.write.kind, 'accepted');
  });
});

test('a later bad frame is judged before a yielded turn completes', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'later-bad', signal, hostOperationId: 'later-bad', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.deliver(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } })}\n`));
    agent.deliver(Buffer.from(`${JSON.stringify(textUpdate('held'))}\n{bad\n`));
    agent.endOutput();
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.notEqual(result.kind, 'complete');
    assert.equal(result.error.message, incompleteTurn);
  });
});

test('a later tool call is judged before a yielded turn completes', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'later-tool-chunk', signal, hostOperationId: 'later-tool-chunk', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.deliver(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } })}\n`));
    const follow = [
      JSON.stringify(textUpdate('held')),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'held-tool' } } }),
    ].join('\n');
    agent.deliver(Buffer.from(`${follow}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, rejectedUpdate);
  });
});

test('a blank line after a yielded tool call keeps that rejection', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'blank-yield', signal, hostOperationId: 'blank-yield', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } }),
      JSON.stringify(textUpdate('before-blank')),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'kept' } } }),
      '',
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, rejectedUpdate);
    assert.equal(agent.state.notifications.filter((message) => message.method === 'session/cancel').length, 1);
  });
});

test('an in-turn cancel is not repeated after the segment returns', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'one-cancel', signal, hostOperationId: 'one-cancel', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'during' } } });
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'after' } } });
    await setImmediate();
    assert.equal(agent.state.notifications.filter((message) => message.method === 'session/cancel').length, 1);
  });
});

test('abort after the prompt terminal does not cancel or complete', async () => {
  const controller = new AbortController();
  await withSession(async ({ adapter, agent }) => {
    adapter.events.subscribe((event) => {
      if (event.kind === 'text-delta') controller.abort();
    });
    const running = adapter.run({ prompt: 'abort-after', signal: controller.signal, hostOperationId: 'abort-after', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } }),
      JSON.stringify(textUpdate('then-abort')),
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.notEqual(result.kind, 'complete');
    assert.equal(result.error.message, incompleteTurn);
    assert.equal(agent.state.notifications.some((message) => message.method === 'session/cancel'), false);
    const again = await adapter.run({ prompt: 'next', signal: AbortSignal.timeout(1000), hostOperationId: 'abort-after-2', recordIntent() {} });
    assert.equal(again.write.kind, 'not-attempted');
    assert.equal(agent.state.requests.filter((message) => message.method === 'session/prompt').length, 1);
  });
});

test('a disallowed update during the next intent still cancels the written prompt', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const first = adapter.run({ prompt: 'first', signal, hostOperationId: 'intent-cancel-1', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    assert.equal((await first).kind, 'complete');
    let release = () => {};
    const second = adapter.run({
      prompt: 'second', signal, hostOperationId: 'intent-cancel-2',
      recordIntent() { return new Promise((resolve) => { release = resolve; }); },
    });
    await setImmediate();
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'during-intent' } } });
    await setImmediate();
    assert.equal(agent.state.notifications.filter((message) => message.method === 'session/cancel').length, 1);
    assert.equal(agent.state.requests.filter((message) => message.method === 'session/prompt').length, 1);
    release();
    const result = await second;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, rejectedUpdate);
    assert.equal(agent.state.requests.filter((message) => message.method === 'session/prompt').length, 1);
  });
});

test('interrupt stays quiet after the prompt terminal is recorded', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    let seen;
    adapter.events.subscribe((event) => {
      if (event.kind === 'text-delta' && seen === undefined) seen = adapter.interrupt({ timeoutMs: 50 });
    });
    const running = adapter.run({ prompt: 'quiet-interrupt', signal, hostOperationId: 'quiet-interrupt', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } }),
      JSON.stringify(textUpdate('after')),
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    const interrupted = await seen;
    assert.equal(result.kind, 'complete', JSON.stringify(result));
    assert.equal(interrupted.kind, 'terminal-observed');
    assert.equal(agent.state.notifications.some((message) => message.method === 'session/cancel'), false);
  });
});

test('a blank line after end_turn fails the latched turn', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'blank-after', signal, hostOperationId: 'blank-after', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } }),
      '',
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, incompleteTurn);
    assert.equal(result.write.kind, 'accepted');
  });
});

test('a partial line at EOF does not complete a latched turn', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'partial-eof', signal, hostOperationId: 'partial-eof', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.deliver(Buffer.concat([
      Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } })}\n`),
      Buffer.from('{partial'),
    ]));
    agent.endOutput();
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, incompleteTurn);
  });
});

test('a tool call after the segment returns cancels once', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'later-tool', signal, hostOperationId: 'later-tool', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    const result = await running;
    assert.equal(result.kind, 'complete', JSON.stringify(result));
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'late' } } });
    await setImmediate();
    assert.equal(agent.state.notifications.filter((message) => message.method === 'session/cancel').length, 1);
    const again = await adapter.run({ prompt: 'next', signal, hostOperationId: 'later-tool-2', recordIntent() {} });
    assert.equal(again.kind, 'failed');
    assert.equal(again.write.kind, 'not-attempted');
    assert.equal(again.error.message, 'OpenCode sent an update this session cannot accept.');
  });
});

test('a recordIntent that resolves after close does not send the prompt', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    let releaseIntent = () => {};
    const running = adapter.run({
      prompt: 'after-close', signal, hostOperationId: 'after-close',
      recordIntent() { return new Promise((resolve) => { releaseIntent = resolve; }); },
    });
    await setImmediate();
    await adapter.close();
    releaseIntent();
    const result = await running;
    assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.write.kind, 'outcome-unknown');
  });
});

test('a corrupt line after end_turn does not complete the segment', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'corrupt-after', signal, hostOperationId: 'corrupt-after', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } }),
      '{bad',
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.notEqual(result.kind, 'complete');
    assert.equal(result.error.message, incompleteTurn);
    assert.equal(result.write.kind, 'accepted');
  });
});

test('a tool call after end_turn in the same chunk fails that segment', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'race', signal, hostOperationId: 'race', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', title: 'SECRET_AFTER' } } }),
    ].join('\n');
    agent.deliver(Buffer.from(`${lines}\n`));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, rejectedUpdate);
    assert.equal(result.write.kind, 'accepted');
    assert.equal(JSON.stringify(result).includes('SECRET_AFTER'), false);
  });
});

test('a model change while idle makes the next run not attempted', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'idle', signal, hostOperationId: 'idle-model', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    assert.equal((await running).kind, 'complete');
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: {
      sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'other/model' }] } } });
    const next = await adapter.run({ prompt: 'later', signal, hostOperationId: 'later-model', recordIntent() {} });
    assert.equal(next.write.kind, 'not-attempted');
    assert.equal(next.error.message, rejectedUpdate);
    assert.equal(JSON.stringify(next).includes('other/model'), false);
  });
});

test('a config update that omits the model does not fail the turn', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'partial', signal, hostOperationId: 'partial-model', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: {
      sessionUpdate: 'config_option_update', configOptions: [{ id: 'theme', currentValue: 'dark' }] } } });
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    const result = await running;
    assert.equal(result.kind, 'complete', JSON.stringify(result));
  });
});

test('a foreign session id and a child marker on the params fail the segment', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'foreign', signal, hostOperationId: 'foreign', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECRET_FOREIGN' } } } });
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.error.message, rejectedUpdate);
    assert.equal(JSON.stringify(result).includes('SECRET_FOREIGN'), false);
    assert.equal(result.text === undefined || result.text === '', true);
  });
});

test('a carriage return before newline still completes initialize', async () => {
  const agent = createAgent();
  agent.options.auto = false;
  const opening = opencodeHostAdapter.open({
    model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } }, launch: launchOf(agent),
  }, AbortSignal.timeout(10000));
  const init = await untilRequest(agent, 'initialize');
  agent.deliver(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } })}\r\n`));
  const created = await untilRequest(agent, 'session/new');
  agent.push({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'session-1', configOptions: [{ id: 'model', type: 'select', currentValue: 'dir/default' }] } });
  const configured = await untilRequest(agent, 'session/set_config_option');
  agent.push({ jsonrpc: '2.0', id: configured.id, result: { configOptions: [{ id: 'model', currentValue: model }] } });
  const opened = await opening;
  assert.equal(opened.kind, 'ok', JSON.stringify(opened));
  await opened.value.close();
});

test('a string response id does not end the turn', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'string-id', signal, hostOperationId: 'string-id', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: 'not-a-waiter', result: { stopReason: 'end_turn' } });
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    assert.equal((await running).kind, 'complete');
  });
});

test('a frame delivered inside listen fails open once and does not crash', async () => {
  const failures = [];
  const onRejection = (error) => { failures.push(error); };
  process.on('unhandledRejection', onRejection);
  try {
    let ended = 0;
    const opened = await opencodeHostAdapter.open({
      model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } },
      launch: { kind: 'spawn', spawn() {
        return {
          channel: {
            listen(next) { next(Buffer.from('\n')); return () => {}; },
            write() { return Promise.resolve(); },
            endInput() { ended += 1; },
          },
          processExit: Promise.resolve(),
        };
      } },
    }, AbortSignal.timeout(10000));
    await setImmediate();
    assert.equal(opened.kind, 'error');
    assert.equal(opened.error.message, 'OpenCode turn did not complete.');
    assert.equal(ended, 1);
    assert.deepEqual(failures, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a listen throw fails open once and does not crash', async () => {
  const failures = [];
  const onRejection = (error) => { failures.push(error); };
  process.on('unhandledRejection', onRejection);
  try {
    let ended = 0;
    const opened = await opencodeHostAdapter.open({
      model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } },
      launch: { kind: 'spawn', spawn() {
        return {
          channel: {
            listen() { throw new Error('listen-failed'); },
            write() { return Promise.resolve(); },
            endInput() { ended += 1; },
          },
          processExit: Promise.resolve(),
        };
      } },
    }, AbortSignal.timeout(10000));
    await setImmediate();
    assert.equal(opened.kind, 'error');
    assert.equal(opened.error.code, 'unavailable');
    assert.equal(opened.error.feature, 'host-launcher');
    assert.equal(ended, 1);
    assert.deepEqual(failures, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a frame returned from listen is dropped once the exit watch settles', async () => {
  const failures = [];
  const onRejection = (error) => { failures.push(error); };
  process.on('unhandledRejection', onRejection);
  try {
    let ended = 0;
    let removed = 0;
    const opened = await opencodeHostAdapter.open({
      model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } },
      launch: { kind: 'spawn', spawn() {
        return {
          channel: {
            listen(next) {
              const remove = () => { removed += 1; };
              next(Buffer.from('\n'));
              return remove;
            },
            write() { return Promise.resolve(); },
            endInput() { ended += 1; },
          },
          processExit: Promise.resolve(),
        };
      } },
    }, AbortSignal.timeout(10000));
    await setImmediate();
    assert.equal(opened.kind, 'error');
    assert.equal(opened.error.message, 'OpenCode turn did not complete.');
    assert.equal(ended, 1);
    assert.equal(removed, 1);
    assert.deepEqual(failures, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a frame followed by a listen throw keeps the first error and ends stdin once', async () => {
  const failures = [];
  const onRejection = (error) => { failures.push(error); };
  process.on('unhandledRejection', onRejection);
  try {
    let ended = 0;
    const opened = await opencodeHostAdapter.open({
      model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } },
      launch: { kind: 'spawn', spawn() {
        return {
          channel: {
            listen(next) {
              next(Buffer.from('\n'));
              throw new Error('listen-failed');
            },
            write() { return Promise.resolve(); },
            endInput() { ended += 1; },
          },
          processExit: Promise.resolve(),
        };
      } },
    }, AbortSignal.timeout(10000));
    await setImmediate();
    assert.equal(opened.kind, 'error');
    assert.equal(opened.error.message, 'OpenCode turn did not complete.');
    assert.equal(ended, 1);
    assert.deepEqual(failures, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('an unusable spawn handle ends stdin and does not signal', async () => {
  let ended = 0;
  const opened = await opencodeHostAdapter.open({
    model, environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } },
    launch: { kind: 'spawn', spawn() { return { channel: { listen() { return () => {}; }, write() { return Promise.resolve(); }, endInput() { ended += 1; } }, kill() {} }; } },
  }, AbortSignal.timeout(10000));
  assert.equal(opened.kind, 'error');
  assert.equal(opened.error.code, 'unavailable');
  assert.equal(opened.error.feature, 'host-launcher');
  assert.equal(ended, 1);
});

test('a control character in the executable never reaches spawn', async () => {
  const ready = await openReady({ executable: `/usr/bin/opencode\n` });
  assert.equal(ready.opened.kind, 'error');
  assert.equal(ready.opened.error.code, 'invalid-input');
  assert.equal(ready.agent.state.attempts, 0);
});

test('a prompt whose JSON frame exceeds the line limit is not sent', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const prompt = '\\'.repeat(600_000);
    let called = false;
    const result = await adapter.run({ prompt, signal, hostOperationId: 'wide-frame', recordIntent() { called = true; } });
    assert.equal(result.kind, 'failed');
    assert.equal(result.error.code, 'invalid-input');
    assert.equal(result.write.kind, 'not-attempted');
    assert.equal(called, false);
    assert.equal(agent.state.requests.some((message) => message.method === 'session/prompt'), false);
  });
});

test('close waits to end stdin until session/close has been written', async () => {
  const agent = createAgent();
  agent.options.deferCloseWrite = true;
  const ready = await openReady({ agent });
  assert.equal(ready.opened.kind, 'ok');
  const closing = ready.opened.value.close();
  await untilRequest(agent, 'session/close');
  assert.equal(agent.state.stdinEnded, 0);
  agent.releaseClose();
  const closed = await closing;
  assert.equal(closed.kind, 'ok', JSON.stringify(closed));
  assert.equal(agent.state.stdinEnded, 1);
  assert.equal(agent.state.requests.filter((message) => message.method === 'session/close').length, 1);
});

test('a rejected process exit uses the fixed failure and drops the reason', async () => {
  const agent = createAgent();
  agent.options.resolveOnEndInput = false;
  const ready = await openReady({ agent });
  assert.equal(ready.opened.kind, 'ok');
  const closing = ready.opened.value.close();
  agent.rejectExit(new Error('secret-exit-detail'));
  const closed = await closing;
  assert.equal(closed.kind, 'error');
  assert.equal(closed.error.message, 'OpenCode process exit failed.');
  assert.equal(JSON.stringify(closed).includes('secret-exit-detail'), false);
  assert.equal(agent.state.signals, 0);
});

test('a throwing notification ends the in-flight request', async () => {
  let sink;
  const protocol = openOpenCodeProtocol({
    listen(next) { sink = next; return () => {}; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, {
    onNotification() { throw new Error('secret-handler'); },
    onRequest() {},
  });
  protocol.start();
  const pending = protocol.request('initialize', {}, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 });
  sink(Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":{}}\n'));
  const outcome = await pending;
  assert.equal(outcome.kind, 'ended');
  protocol.stop();
});

test('a notification promise can yield before the next line', async () => {
  const seen = [];
  let sink;
  const protocol = openOpenCodeProtocol({
    listen(next) { sink = next; return () => {}; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, {
    onNotification(message) {
      seen.push(message.params);
      return Promise.resolve('yield');
    },
    onRequest() {},
  });
  protocol.start();
  sink(Buffer.from('{"jsonrpc":"2.0","method":"a","params":1}\n{"jsonrpc":"2.0","method":"b","params":2}\n'));
  await setImmediate();
  assert.deepEqual(seen, [1, 2]);
  protocol.stop();
});

test('prompt bytes followed by channel EOF are outcome-unknown', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'vanish', signal, hostOperationId: 'vanish', recordIntent() {} });
    await untilRequest(agent, 'session/prompt');
    agent.endOutput();
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.write.kind, 'outcome-unknown');
    assert.equal(agent.state.signals, 0);
    agent.push(textUpdate('LATE'));
    let called = false;
    const again = await adapter.run({ prompt: 'again', signal, hostOperationId: 'again', recordIntent() { called = true; } });
    assert.equal(again.write.kind, 'not-attempted');
    assert.equal(called, false);
    assert.equal(agent.state.requests.filter((message) => message.method === 'session/prompt').length, 1);
    assert.equal(JSON.stringify(result).includes('LATE'), false);
  });
});

test('aborting a written prompt leaves the next run unsent', async () => {
  const controller = new AbortController();
  await withSession(async ({ adapter, agent }) => {
    const running = adapter.run({ prompt: 'abort-me', signal: controller.signal, hostOperationId: 'abort-me', recordIntent() {} });
    await untilRequest(agent, 'session/prompt');
    controller.abort();
    agent.push(textUpdate('LATE'));
    const result = await running;
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(result.write.kind, 'outcome-unknown');
    assert.equal(JSON.stringify(result).includes('LATE'), false);
    const again = await adapter.run({ prompt: 'again', signal: AbortSignal.timeout(1000), hostOperationId: 'again', recordIntent() {} });
    assert.equal(again.write.kind, 'not-attempted');
    assert.equal(agent.state.requests.filter((message) => message.method === 'session/prompt').length, 1);
    assert.equal(agent.state.signals, 0);
  });
});

test('ending stdout while interrupt waits is not a native terminal', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const running = adapter.run({ prompt: 'cut', signal, hostOperationId: 'cut', recordIntent() {} });
    await untilRequest(agent, 'session/prompt');
    const pending = adapter.interrupt({ timeoutMs: 1000 });
    agent.endOutput();
    assert.equal((await pending).kind, 'unconfirmed-within-bound');
    const result = await running;
    assert.equal(result.write.kind, 'outcome-unknown');
    assert.equal(agent.state.signals, 0);
  });
});

test('a process exit during initialize fails open without the exit reason', async () => {
  const agent = createAgent();
  agent.options.auto = false;
  agent.options.resolveOnEndInput = false;
  const opening = opencodeHostAdapter.open({
    model,
    environment: { variables: { PATH: '/host/bin' }, nativeConfig: { cwd, executable, account } },
    launch: launchOf(agent),
  }, AbortSignal.timeout(10000));
  await untilRequest(agent, 'initialize');
  agent.rejectExit(new Error('secret-exit-detail'));
  const opened = await opening;
  assert.equal(opened.kind, 'error');
  assert.equal(opened.error.message, 'OpenCode process exit failed.');
  assert.equal(JSON.stringify(opened).includes('secret-exit-detail'), false);
  assert.equal(agent.state.signals, 0);
});

test('a process exit during a prompt fails that segment and blocks the next run', async () => {
  const agent = createAgent();
  agent.options.resolveOnEndInput = false;
  const ready = await openReady({ agent });
  assert.equal(ready.opened.kind, 'ok');
  const adapter = ready.opened.value;
  const running = adapter.run({ prompt: 'live', signal: ready.signal, hostOperationId: 'live', recordIntent() {} });
  await untilRequest(agent, 'session/prompt');
  agent.rejectExit(new Error('secret-exit-detail'));
  const result = await running;
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  assert.equal(result.error.message, 'OpenCode process exit failed.');
  assert.equal(result.write.kind, 'outcome-unknown');
  assert.equal(JSON.stringify(result).includes('secret-exit-detail'), false);
  let called = false;
  const again = await adapter.run({ prompt: 'next', signal: ready.signal, hostOperationId: 'next', recordIntent() { called = true; } });
  assert.equal(again.write.kind, 'not-attempted');
  assert.equal(called, false);
  assert.equal(agent.state.requests.filter((message) => message.method === 'session/prompt').length, 1);
  assert.equal(agent.state.notifications.some((message) => message.method === 'session/cancel'), false);
  assert.equal(agent.state.signals, 0);
  await adapter.close();
});

test('a process exit stays quiet for a later abort and interrupt', async () => {
  const agent = createAgent();
  agent.options.resolveOnEndInput = false;
  const controller = new AbortController();
  const ready = await openReady({ agent });
  assert.equal(ready.opened.kind, 'ok');
  const adapter = ready.opened.value;
  const running = adapter.run({ prompt: 'quiet-exit', signal: controller.signal, hostOperationId: 'quiet-exit', recordIntent() {} });
  await untilRequest(agent, 'session/prompt');
  agent.rejectExit(new Error('secret-exit-detail'));
  await setImmediate();
  controller.abort();
  const interrupted = await adapter.interrupt({ timeoutMs: 20 });
  const result = await running;
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  assert.equal(interrupted.kind, 'unconfirmed-within-bound');
  assert.equal(agent.state.notifications.some((message) => message.method === 'session/cancel'), false);
  const blocked = await adapter.run({ prompt: 'blocked', signal: AbortSignal.timeout(1000), hostOperationId: 'blocked', recordIntent() {} });
  assert.equal(blocked.write.kind, 'not-attempted');
  await adapter.close();
});

test('a malformed run returns invalid input and does not stay busy', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const missing = await adapter.run(null);
    assert.equal(missing.kind, 'failed');
    assert.equal(missing.error.code, 'invalid-input');
    assert.equal(missing.write.kind, 'not-attempted');
    const blank = await adapter.run({ prompt: 'ok', signal, hostOperationId: '', recordIntent: 'nope' });
    assert.equal(blank.kind, 'failed');
    assert.equal(blank.error.code, 'invalid-input');
    assert.equal(blank.write.kind, 'not-attempted');
    const running = adapter.run({ prompt: 'after', signal, hostOperationId: 'after', recordIntent() {} });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: {} } });
    assert.equal((await running).kind, 'complete');
  });
});

test('a stalled write still hits the request deadline', async () => {
  const protocol = openOpenCodeProtocol({
    listen() { return () => {}; },
    write() { return new Promise(() => {}); },
    endInput() {},
  }, { onNotification() {}, onRequest() {} });
  protocol.start();
  const outcome = await protocol.request('initialize', {}, { signal: AbortSignal.timeout(1000), timeoutMs: 30 });
  assert.equal(outcome.kind, 'timeout');
  protocol.stop();
});

test('a throwing beforeWrite still settles the request', async () => {
  const protocol = openOpenCodeProtocol({
    listen() { return () => {}; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, { onNotification() {}, onRequest() {} });
  protocol.start();
  const outcome = await protocol.request('initialize', {}, {
    signal: AbortSignal.timeout(1000),
    timeoutMs: 1000,
    beforeWrite() { throw new Error('secret-before'); },
  });
  assert.equal(outcome.kind, 'ended');
  assert.equal(JSON.stringify(outcome).includes('secret-before'), false);
  protocol.stop();
});

test('a bare newline ends the request instead of queueing empty lines', async () => {
  let sink;
  const protocol = openOpenCodeProtocol({
    listen(next) { sink = next; return () => {}; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, { onNotification() {}, onRequest() {} });
  protocol.start();
  const pending = protocol.request('initialize', {}, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 });
  sink(Buffer.from('\n\n\n'));
  assert.equal((await pending).kind, 'ended');
  protocol.stop();
});

test('a leading BOM does not complete a waiter', async () => {
  let sink;
  const protocol = openOpenCodeProtocol({
    listen(next) { sink = next; return () => {}; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, { onNotification() {}, onRequest() {} });
  protocol.start();
  const pending = protocol.request('initialize', {}, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 });
  sink(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'),
  ]));
  assert.equal((await pending).kind, 'ended');
  protocol.stop();
});

test('a malformed byte and a stopped reader drop the stdout sink', async () => {
  let removed = 0;
  let sink;
  const protocol = openOpenCodeProtocol({
    listen(next) { sink = next; return () => { removed += 1; }; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, { onNotification() {}, onRequest() {} });
  protocol.start();
  const pending = protocol.request('initialize', {}, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 });
  sink(Buffer.from([0xff, 0x0a]));
  assert.equal((await pending).kind, 'ended');
  assert.equal(removed, 0);
  sink(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
  assert.equal(removed, 0);
  protocol.releaseReader();
  assert.equal(removed, 1);
  protocol.stop();
  assert.equal(removed, 1);
});

test('a blank line after a yielded notification stops once as a bad frame', async () => {
  let sink;
  const reasons = [];
  const seen = [];
  const protocol = openOpenCodeProtocol({
    listen(next) { sink = next; return () => {}; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, {
    onNotification() {
      seen.push('note');
      if (seen.length === 1) return 'yield';
    },
    onRequest() {},
    onStopped(reason) { reasons.push(reason); },
  });
  protocol.start();
  const pending = protocol.request('initialize', {}, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 });
  const lines = [
    '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call"}}}',
    '',
  ].join('\n');
  sink(Buffer.from(`${lines}\n`));
  await setImmediate();
  await setImmediate();
  assert.equal((await pending).kind, 'result');
  assert.deepEqual(seen, ['note', 'note']);
  assert.deepEqual(reasons, ['bad-frame']);
  protocol.releaseReader();
});

test('a throwing or rejected line handler stops as a bad frame', async () => {
  for (const fail of ['throw', 'reject']) {
    let sink;
    const reasons = [];
    const protocol = openOpenCodeProtocol({
      listen(next) { sink = next; return () => {}; },
      write() { return Promise.resolve(); },
      endInput() {},
    }, {
      onNotification() {
        if (fail === 'throw') throw new Error('handler');
        return Promise.reject(new Error('handler'));
      },
      onRequest() {},
      onStopped(reason) { reasons.push(reason); },
    });
    protocol.start();
    const pending = protocol.request('initialize', {}, { signal: AbortSignal.timeout(1000), timeoutMs: 1000 });
    sink(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}\n{"jsonrpc":"2.0","method":"session/update","params":{}}\n'));
    await setImmediate();
    const outcome = await pending;
    assert.equal(outcome.kind, 'result', fail);
    assert.deepEqual(reasons, ['bad-frame'], fail);
    protocol.releaseReader();
  }
});

test('an agent request is finished before the next line', async () => {
  const seen = [];
  let sink;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const protocol = openOpenCodeProtocol({
    listen(next) { sink = next; return () => {}; },
    write() { return Promise.resolve(); },
    endInput() {},
  }, {
    onRequest() { return gate.then(() => { seen.push('request'); }); },
    onNotification() { seen.push('note'); },
  });
  protocol.start();
  sink(Buffer.from('{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{}}\n{"jsonrpc":"2.0","method":"a","params":1}\n'));
  await setImmediate();
  assert.deepEqual(seen, []);
  release();
  await setImmediate();
  assert.deepEqual(seen, ['request', 'note']);
  protocol.stop();
});

test('prompt bytes followed by channel EOF report an outcome-unknown terminal observation', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'vanish', signal, hostOperationId: 'vanish-observed', recordIntent() {}, onObservation: seen.listener });
    await untilRequest(agent, 'session/prompt');
    agent.endOutput();
    const result = await running;
    assert.equal(result.write.kind, 'outcome-unknown');
    assert.equal(seen.rows[0].kind, 'run-started');
    assert.deepEqual(seen.rows.at(-1), { kind: 'terminal', outcome: 'outcome-unknown' });
  });
});

test('usage_update carries no token counts and never yields a usage row; the prompt response usage is the only row', async () => {
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'usage-norm', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(update('usage_update', { used: 12, size: 100, cost: { amount: 0.1, currency: 'USD' } }));
    agent.push(textUpdate('A'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 1 } } });
    assert.equal((await running).kind, 'complete');
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'usage'),
      [{ kind: 'usage', rows: [{ outputTokens: 1, inputTokens: 100 }] }]);
  });
  // OpenCode 1.18 shape: input excludes cache, output excludes reasoning, total sums all five buckets.
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'usage-disjoint', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(textUpdate('A'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 229, thoughtTokens: 20, cachedReadTokens: 99 } } });
    assert.equal((await running).kind, 'complete');
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'usage'),
      [{ kind: 'usage', rows: [{ inputTokens: 199, outputTokens: 30, totalTokens: 229, reasoningTokens: 20, cachedInputTokens: 99 }] }]);
  });
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'usage-write', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(textUpdate('A'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 211, cachedReadTokens: 100, cachedWriteTokens: 1 } } });
    assert.equal((await running).kind, 'complete');
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'usage'),
      [{ kind: 'usage', rows: [{ inputTokens: 201, outputTokens: 10, totalTokens: 211, cachedInputTokens: 100, cacheWriteInputTokens: 1 }] }]);
  });
  await withSession(async ({ adapter, agent, signal }) => {
    const seen = observed();
    const running = adapter.run({ prompt: 'go', signal, hostOperationId: 'usage-prompt', recordIntent() {}, onObservation: seen.listener });
    const prompt = await untilRequest(agent, 'session/prompt');
    agent.push(textUpdate('A'));
    agent.push({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } });
    assert.equal((await running).kind, 'complete');
    assert.deepEqual(seen.rows.filter((row) => row.kind === 'usage'),
      [{ kind: 'usage', rows: [{ outputTokens: 2, inputTokens: 5, totalTokens: 7 }] }]);
    assert.deepEqual(seen.rows.slice(-2).map((row) => row.kind), ['usage', 'terminal']);
  });
});
