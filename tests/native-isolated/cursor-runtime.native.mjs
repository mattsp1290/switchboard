import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CursorAgentError, JsonlLocalAgentStore } from '@cursor/sdk';
import { createCursorRuntime } from '@operatorworks/switchboard/cursor';
import { assertCoherentReport } from '../adapters/readiness-oracle.mjs';

// The SDK seam is internal to the packed entry, so it is loaded by file URL past the exports map.
const { sdk } = await import(new URL('sdk.js', import.meta.resolve('@operatorworks/switchboard/cursor')).href);
assert.equal(sdk.Store, JsonlLocalAgentStore);
const original = { create: sdk.create, resume: sdk.resume, Store: sdk.Store, listModels: sdk.listModels };

const caller = 'caller-model';
const key = 'fixture-key-never-log';

function restore() {
  sdk.create = original.create;
  sdk.resume = original.resume;
  sdk.Store = original.Store;
  sdk.listModels = original.listModels;
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-cursor-'));
  const cwd = join(root, 'work');
  const session = join(root, 'session');
  await mkdir(cwd);
  return { root, cwd, session, async remove() { await rm(root, { recursive: true, force: true }); } };
}

function options(cwd, session, extra = {}) {
  return { cwd, sessionDirectory: session, apiKey: key, model: caller, ...extra };
}

function assistant(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function tool(status, field, secret) {
  return { type: 'tool_call', status, call_id: 'call-1', name: 'edit', [field]: { secret } };
}

let chain = Promise.resolve();
function serial(name, fn) {
  const previous = chain;
  let gate = () => {};
  chain = new Promise(resolve => { gate = resolve; });
  test(name, async (t) => {
    await previous;
    try { await fn(t); }
    finally { gate(); }
  });
}

function install(scripted) {
  const created = [];
  const resumed = [];
  const roots = [];
  const cancels = [];
  let sends = 0;
  const state = {
    createError: undefined, resumeError: undefined, sendError: undefined, scripts: scripted,
    messages: [],
    waitStatus: 'finished', cancelError: undefined, holdCreate: undefined, holdSend: undefined,
    holdStream: undefined, holdWait: undefined, holdDispose: undefined, disposals: [],
  };
  class Store {
    constructor(dir) { this.dir = dir; roots.push(dir); }
  }
  function agent(id) {
    return {
      agentId: id,
      async send(message) {
        state.messages.push(structuredClone(message));
        sends += 1;
        if (state.holdSend) await state.holdSend;
        if (state.sendError) throw state.sendError;
        const events = state.scripts.shift() ?? [];
        let used = false;
        return {
          supports: (operation) => operation === 'cancel',
          stream() {
            if (used) throw new Error('second stream');
            used = true;
            return (async function* () {
              if (state.holdStream) await state.holdStream;
              for (const event of events) {
                if (event instanceof Error) throw event;
                yield event;
              }
            })();
          },
          async wait() {
            if (state.holdWait) await state.holdWait;
            return { status: state.waitStatus };
          },
          async cancel() {
            cancels.push('cancel');
            if (state.cancelError) throw state.cancelError;
          },
        };
      },
      async [Symbol.asyncDispose]() {
        state.disposals.push(id);
        if (state.holdDispose) await state.holdDispose;
      },
    };
  }
  sdk.Store = Store;
  sdk.create = async (value) => {
    created.push(value);
    if (state.holdCreate) await state.holdCreate;
    if (state.createError) throw state.createError;
    return agent('agent-1');
  };
  sdk.resume = async (...args) => {
    resumed.push(args);
    if (state.resumeError) throw state.resumeError;
    return agent(args[0]);
  };
  return { created, resumed, roots, cancels, get sends() { return sends; }, state, Store };
}

function assertLocal(local, cwd, session, Store) {
  assert.equal(local.cwd, cwd);
  assert.deepEqual(local.settingSources, ['project']);
  assert.deepEqual(local.sandboxOptions, { enabled: true });
  assert.equal(local.enableAgentRetries, false);
  assert.ok(local.store instanceof Store);
  assert.equal(local.store.dir, session);
  for (const name of ['autoReview', 'tools', 'disallowedTools', 'cloud', 'mcpServers']) {
    assert.equal(Object.hasOwn(local, name), false);
  }
}

serial('Cursor runtime sandboxes, accumulates text, and hides tool payloads', async () => {
  const place = await workspace();
  const fake = install([[
    assistant('Hello'),
    { type: 'thinking', text: 'do-not-leak' },
    assistant(' world'),
    tool('running', 'args', 'do-not-leak'),
    tool('completed', 'result', 'do-not-leak'),
    { type: 'tool_call', status: 'running', call_id: 'call-2', name: 'edit', path: '/tmp/do-not-leak' },
    { type: 'tool_call', status: 'error', call_id: 'call-3', name: 'edit', error: 'do-not-leak' },
  ], [assistant('Done')]]);
  const events = [];
  const follow = [];
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const observed = [];
    const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event), onObservation: o => observed.push(o) });
    assert.equal(await turn.finished, 'completed');
    assert.equal(fake.created.length, 1);
    assert.deepEqual(Object.keys(fake.created[0]).sort(), ['apiKey', 'local', 'model']);
    assert.equal(fake.created[0].apiKey, key);
    assert.deepEqual(fake.created[0].model, { id: caller });
    assertLocal(fake.created[0].local, place.cwd, place.session, fake.Store);
    for (const name of ['autoReview', 'tools', 'disallowedTools', 'cloud', 'mcpServers']) {
      assert.equal(Object.hasOwn(fake.created[0], name), false);
    }
    assert.deepEqual(fake.roots, [place.session]);
    assert.deepEqual(events.filter(event => event.kind === 'text'), [
      { kind: 'text', text: 'Hello' },
      { kind: 'text', text: 'Hello world' },
    ]);
    const tools = events.filter(event => event.kind === 'tool');
    assert.deepEqual(tools, [
      { kind: 'tool', callId: 'call-1', name: 'edit', status: 'running' },
      { kind: 'tool', callId: 'call-1', name: 'edit', status: 'completed' },
      { kind: 'tool', callId: 'call-2', name: 'edit', status: 'running' },
      { kind: 'tool', callId: 'call-3', name: 'edit', status: 'error' },
    ]);
    for (const event of tools) assert.deepEqual(Object.keys(event).sort(), ['callId', 'kind', 'name', 'status']);
    assert.equal(JSON.stringify(events).includes('do-not-leak'), false);
    assert.deepEqual(events.at(-1), { kind: 'ended', outcome: 'completed' });
    assert.equal(observed[0].kind, 'run-started');
    assert.deepEqual(observed.filter(o => o.kind === 'unsupported').map(o => o.family),
      ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents']);
    assert.deepEqual(observed.filter(o => o.kind === 'text'), [
      { kind: 'text', messageId: 'assistant', mode: 'snapshot', text: 'Hello' },
      { kind: 'text', messageId: 'assistant', mode: 'snapshot', text: 'Hello world' },
    ]);
    assert.deepEqual(observed.filter(o => o.kind === 'reasoning'),
      [{ kind: 'reasoning', messageId: 'reasoning:0', mode: 'delta', text: 'do-not-leak' }]);
    const observedTools = observed.filter(o => o.kind === 'tool');
    assert.deepEqual(observedTools, [
      { kind: 'tool', callId: 'call-1', name: 'edit', phase: 'started' },
      { kind: 'tool', callId: 'call-1', name: 'edit', phase: 'arguments', argumentsJson: '{"secret":"do-not-leak"}' },
      { kind: 'tool', callId: 'call-1', name: 'edit', phase: 'completed', resultJson: '{"secret":"do-not-leak"}' },
      { kind: 'tool', callId: 'call-2', name: 'edit', phase: 'started' },
      { kind: 'tool', callId: 'call-3', name: 'edit', phase: 'started' },
      { kind: 'tool', callId: 'call-3', name: 'edit', phase: 'failed', resultJson: '"do-not-leak"' },
    ]);
    assert.deepEqual(observed.at(-1), { kind: 'terminal', outcome: 'success' });
    assert.equal(observed.filter(o => o.kind === 'terminal').length, 1);
    const resumed = await runtime.start({ text: 'Again', agentId: turn.agentId, onEvent: event => follow.push(event) });
    assert.equal(resumed.agentId, 'agent-1');
    assert.equal(await resumed.finished, 'completed');
    assert.equal(fake.resumed.length, 1);
    assert.equal(fake.resumed[0].length, 2);
    assert.equal(fake.resumed[0][0], 'agent-1');
    assert.deepEqual(fake.resumed[0][1].model, { id: caller });
    assertLocal(fake.resumed[0][1].local, place.cwd, place.session, fake.Store);
    await runtime.close();
  } finally { restore(); await place.remove(); }
});

serial('a request or stream failure after send resolves start and ends failed', async () => {
  const place = await workspace();
  const request = install([[{ type: 'request', request_id: 'req-1' }]]);
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const events = [];
    const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
    assert.equal(await turn.finished, 'failed');
    assert.deepEqual(events, [{ kind: 'ended', outcome: 'failed' }]);
    assert.deepEqual(request.cancels, ['cancel']);
    await runtime.close();
  } finally { restore(); await place.remove(); }

  install([[new Error('stream secret')]]);
  const again = await workspace();
  try {
    const runtime = createCursorRuntime(options(again.cwd, again.session));
    const events = [];
    const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
    assert.equal(await turn.finished, 'failed');
    assert.deepEqual(events, [{ kind: 'ended', outcome: 'failed' }]);
    assert.equal(JSON.stringify(events).includes('stream secret'), false);
    await runtime.close();
  } finally { restore(); await again.remove(); }
});

serial('create and send failures reject start and emit no ended', async () => {
  const place = await workspace();
  const fake = install([]);
  fake.state.createError = new Error('create secret');
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const events = [];
    await assert.rejects(runtime.start({ text: 'Hello', onEvent: event => events.push(event) }), (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes('create secret'), false);
      return true;
    });
    assert.deepEqual(events, []);
    assert.equal(fake.sends, 0);
    await runtime.close();
  } finally { restore(); await place.remove(); }

  const sending = install([]);
  sending.state.sendError = new Error('send secret');
  const second = await workspace();
  try {
    const runtime = createCursorRuntime(options(second.cwd, second.session));
    const events = [];
    await assert.rejects(runtime.start({ text: 'Hello', onEvent: event => events.push(event) }), (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      return true;
    });
    assert.deepEqual(events, []);
    await runtime.close();
  } finally { restore(); await second.remove(); }
});

serial('a resume error stays generic and does not send', async () => {
  const place = await workspace();
  const fake = install([]);
  fake.state.resumeError = new CursorAgentError('resume secret');
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const events = [];
    await assert.rejects(runtime.start({
      text: 'Hello', agentId: 'agent-1', onEvent: event => events.push(event),
    }), (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      assert.equal(String(error.message).includes('resume secret'), false);
      return true;
    });
    assert.equal(fake.sends, 0);
    assert.deepEqual(events, []);
    await runtime.close();
  } finally { restore(); await place.remove(); }
});

serial('illegal caller options throw before the SDK create', async () => {
  const place = await workspace();
  const fake = install([]);
  const illegal = [
    options(place.cwd, place.session, { model: undefined }),
    { ...options(place.cwd, place.session), model: '' },
    options(place.cwd, place.session, { model: ' id' }),
    options(place.cwd, place.session, { model: 'x'.repeat(257) }),
    options(place.cwd, place.session, { model: '\n' }),
    options(place.cwd, place.session, { model: '\u007f' }),
    options(place.cwd, place.session, { model: 1 }),
    options('relative', place.session),
  ];
  try {
    for (const value of illegal) {
      assert.throws(() => createCursorRuntime(value), (error) => {
        assert.equal(error.message, 'Cursor operation failed.');
        assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(key), false);
        return true;
      });
    }
    assert.equal(fake.created.length, 0);
  } finally { restore(); await place.remove(); }
});

serial('a non-object start rejects with the generic error', async () => {
  const place = await workspace();
  const fake = install([]);
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    await assert.rejects(async () => runtime.start(null), (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      return true;
    });
    assert.equal(fake.created.length, 0);
    await runtime.close();
  } finally { restore(); await place.remove(); }
});

serial('a rejected dispose is tried again on the next close', async () => {
  const place = await workspace();
  const fake = install([[assistant('Hi')]]);
  let attempts = 0;
  const created = sdk.create;
  sdk.create = async (value) => {
    const handle = await created(value);
    handle[Symbol.asyncDispose] = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('dispose secret');
    };
    return handle;
  };
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const turn = await runtime.start({ text: 'Hello', onEvent() {} });
    assert.equal(await turn.finished, 'completed');
    await assert.rejects(runtime.close(), (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes('dispose secret'), false);
      return true;
    });
    await runtime.close();
    assert.equal(attempts, 2);
    assert.equal(fake.created.length, 1);
  } finally { restore(); await place.remove(); }
});

serial('a throwing callback fails the turn and leaves disposal to close', async () => {
  const place = await workspace();
  install([[assistant('Hi')]]);
  let disposed = 0;
  const created = sdk.create;
  sdk.create = async (value) => {
    const handle = await created(value);
    handle[Symbol.asyncDispose] = async () => { disposed += 1; };
    return handle;
  };
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const events = [];
    const turn = await runtime.start({
      text: 'Hello',
      onEvent(event) {
        events.push(event.kind);
        if (event.kind === 'text') throw new Error('callback secret');
      },
    });
    assert.equal(await turn.finished, 'failed');
    assert.deepEqual(events, ['text', 'ended']);
    assert.equal(JSON.stringify(events).includes('callback secret'), false);
    assert.equal(disposed, 0);
    await runtime.close();
    assert.equal(disposed, 1);
  } finally { restore(); await place.remove(); }
});

serial('a newline inside a tool call id is reported without a control character', async () => {
  const place = await workspace();
  const prefix = 'a'.repeat(64);
  const suffix = 'b'.repeat(41);
  install([[{
    type: 'tool_call', status: 'completed', name: 'edit', call_id: `${prefix}\n${suffix}`, args: { secret: 'do-not-leak' },
  }]]);
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const events = [];
    const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
    assert.equal(await turn.finished, 'completed');
    assert.deepEqual(events.filter(event => event.kind === 'tool'), [
      { kind: 'tool', callId: `${prefix}:${suffix}`, name: 'edit', status: 'completed' },
    ]);
    assert.equal(events.some(event => event.kind === 'tool' && event.callId.includes('\n')), false);
    await runtime.close();
  } finally { restore(); await place.remove(); }
});

serial('readiness stays unverified and a closed runtime does not create a session', async () => {
  const place = await workspace();
  install([]);
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const report = assertCoherentReport(await runtime.readinessReport(), [key, place.cwd, place.session, caller]);
    assert.equal(report.provider, 'cursor');
    assert.equal(report.verdict, 'unverified');
    assert.equal(report.remediation.code, 'check_unavailable');
    assert.equal(report.facts.workspace.state, 'accessible');
    assert.equal(report.facts.installation.state, 'unsupported');
    assert.equal(report.facts.version.state, 'unsupported');
    assert.equal(report.facts.authentication.state, 'unsupported');
    await access(place.session);
    await runtime.checkReady();
    await assert.rejects(runtime.readinessReport({ signal: {} }), (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      return true;
    });
    const missing = createCursorRuntime(options(join(place.root, 'missing'), join(place.root, 'missing-session')));
    await assert.rejects(missing.checkReady(), (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      return true;
    });
    const blocked = await missing.readinessReport();
    assert.equal(blocked.verdict, 'blocked');
    assert.equal(blocked.remediation.code, 'workspace_unavailable');
    assertCoherentReport(blocked, [
      key, caller, join(place.root, 'missing'), join(place.root, 'missing-session'),
    ]);
    const closed = createCursorRuntime(options(place.cwd, join(place.root, 'closed-session')));
    await closed.close();
    const after = assertCoherentReport(await closed.readinessReport(), [
      key, caller, place.cwd, join(place.root, 'closed-session'),
    ]);
    assert.equal(after.verdict, 'unverified');
    assert.equal(after.remediation.code, 'runtime_closed');
    await assert.rejects(access(join(place.root, 'closed-session')));
    await closed.close();
    await runtime.close();
    await missing.close();
  } finally { restore(); await place.remove(); }
});

function gate() {
  let open = () => {};
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

serial('admission, cancellation, and malformed tool ids settle on the public boundary', async () => {
  const held = await workspace();
  const creating = install([]);
  const created = gate();
  creating.state.holdCreate = created.promise;
  try {
    const runtime = createCursorRuntime(options(held.cwd, held.session));
    const events = [];
    const pending = runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
    assert.equal(creating.created.length, 1);
    const stopping = runtime.close();
    created.open();
    await assert.rejects(pending, (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      return true;
    });
    assert.deepEqual(events, []);
    await stopping;
    for (let attempt = 0; attempt < 10 && creating.state.disposals.length === 0; attempt += 1) await Promise.resolve();
    assert.deepEqual(creating.state.disposals, ['agent-1']);
  } finally { created.open(); restore(); await held.remove(); }

  const sending = await workspace();
  const slowSend = install([]);
  const sent = gate();
  const disposed = gate();
  slowSend.state.holdSend = sent.promise;
  slowSend.state.holdDispose = disposed.promise;
  try {
    const runtime = createCursorRuntime(options(sending.cwd, sending.session));
    const events = [];
    const pending = runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
    for (let attempt = 0; attempt < 10 && slowSend.sends === 0; attempt += 1) await Promise.resolve();
    assert.equal(slowSend.sends, 1);
    let closeSettled = false;
    const stopping = runtime.close().finally(() => { closeSettled = true; });
    await assert.rejects(pending, (error) => {
      assert.equal(error.message, 'Cursor operation failed.');
      return true;
    });
    assert.equal(closeSettled, false);
    assert.deepEqual(events, []);
    disposed.open();
    await stopping;
    sent.open();
    for (let attempt = 0; attempt < 10 && !slowSend.cancels.includes('cancel'); attempt += 1) await Promise.resolve();
    assert.ok(slowSend.cancels.includes('cancel'));
  } finally {
    disposed.open();
    sent.open();
    restore();
    await sending.remove();
  }

  const interrupted = await workspace();
  const cancelWait = install([[assistant('Hi')]]);
  const waited = gate();
  cancelWait.state.holdWait = waited.promise;
  cancelWait.state.waitStatus = 'cancelled';
  try {
    const runtime = createCursorRuntime(options(interrupted.cwd, interrupted.session));
    const turn = await runtime.start({ text: 'Hello', onEvent() {} });
    const aborting = turn.abort();
    waited.open();
    await aborting;
    assert.equal(await turn.finished, 'interrupted');
    await runtime.close();
  } finally { restore(); await interrupted.remove(); }

  const thrownCancel = await workspace();
  const failingCancel = install([[assistant('Hi')]]);
  const failedWait = gate();
  failingCancel.state.holdWait = failedWait.promise;
  failingCancel.state.cancelError = new Error('cancel secret');
  failingCancel.state.waitStatus = 'finished';
  try {
    const runtime = createCursorRuntime(options(thrownCancel.cwd, thrownCancel.session));
    const events = [];
    const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
    const aborting = turn.abort();
    failedWait.open();
    await aborting;
    assert.equal(await turn.finished, 'failed');
    assert.equal(JSON.stringify(events).includes('cancel secret'), false);
    await runtime.close();
  } finally { restore(); await thrownCancel.remove(); }

  const cancelledThrow = await workspace();
  const excused = install([[assistant('Hi')]]);
  const excusedWait = gate();
  excused.state.holdWait = excusedWait.promise;
  excused.state.cancelError = new Error('cancel secret');
  excused.state.waitStatus = 'cancelled';
  try {
    const runtime = createCursorRuntime(options(cancelledThrow.cwd, cancelledThrow.session));
    const turn = await runtime.start({ text: 'Hello', onEvent() {} });
    const aborting = turn.abort();
    excusedWait.open();
    await aborting;
    assert.equal(await turn.finished, 'interrupted');
    await runtime.close();
  } finally { restore(); await cancelledThrow.remove(); }

  const callbackPlace = await workspace();
  const callbackFake = install([[assistant('Hi')]]);
  const stream = gate();
  callbackFake.state.holdStream = stream.promise;
  callbackFake.state.waitStatus = 'cancelled';
  try {
    const runtime = createCursorRuntime(options(callbackPlace.cwd, callbackPlace.session));
    const events = [];
    const turn = await runtime.start({
      text: 'Hello',
      onEvent(event) {
        events.push(event.kind);
        if (event.kind === 'text') throw new Error('callback secret');
      },
    });
    const aborting = turn.abort();
    await Promise.resolve();
    assert.ok(callbackFake.cancels.includes('cancel'));
    stream.open();
    await aborting;
    assert.equal(await turn.finished, 'interrupted');
    assert.equal(callbackFake.state.disposals.length, 0);
    assert.equal(JSON.stringify(events).includes('callback secret'), false);
    await runtime.close();
    assert.equal(callbackFake.state.disposals.length, 1);
  } finally { restore(); await callbackPlace.remove(); }

  const followPlace = await workspace();
  install([[assistant('Hi')], [assistant('Next')]]);
  try {
    const runtime = createCursorRuntime(options(followPlace.cwd, followPlace.session));
    let second;
    const turn = await runtime.start({
      text: 'Hello',
      onEvent(event) {
        if (event.kind === 'ended') second = runtime.start({ text: 'Next', agentId: turn.agentId, onEvent() {} });
      },
    });
    assert.equal(await turn.finished, 'completed');
    const follow = await second;
    assert.equal(follow.agentId, turn.agentId);
    assert.equal(await follow.finished, 'completed');
    await runtime.close();
  } finally { restore(); await followPlace.remove(); }

  for (const callId of ['a\n', '\na', 'a\nb\nc', 'a:b\nc']) {
    const place = await workspace();
    install([[{ type: 'tool_call', status: 'completed', name: 'edit', call_id: callId }]]);
    try {
      const runtime = createCursorRuntime(options(place.cwd, place.session));
      const events = [];
      const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
      assert.equal(await turn.finished, 'failed');
      assert.equal(events.some(event => event.kind === 'tool'), false);
      assert.deepEqual(events, [{ kind: 'ended', outcome: 'failed' }]);
      await runtime.close();
    } finally { restore(); await place.remove(); }
  }

  const overflowPlace = await workspace();
  install([[assistant(`${'x'.repeat(SNAPSHOT_BYTES)}y`)]]);
  try {
    const runtime = createCursorRuntime(options(overflowPlace.cwd, overflowPlace.session));
    const events = [];
    const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
    assert.equal(await turn.finished, 'failed');
    assert.equal(events.some(event => event.kind === 'text'), false);
    await runtime.close();
  } finally { restore(); await overflowPlace.remove(); }
});

const SNAPSHOT_BYTES = 4 * 1024 * 1024;

serial('Cursor image sends preserve exact bytes on create and resume and refuse invalid input before admission', async () => {
  const place = await workspace();
  const fake = install([[assistant('one')], [assistant('two')], [assistant('three')]]);
  const runtime = createCursorRuntime(options(place.cwd, place.session));
  try {
    assert.equal(runtime.imageInput.kind, 'supported');
    const first = await runtime.start({ text: 'legacy', onEvent() {} }); await first.finished;
    const images = [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(4194304, 1).toString('base64')}` }];
    const expected = images[0].dataUrl.split(',')[1];
    const second = runtime.start({ text: 'image', images, onEvent() {} });
    images[0].dataUrl = 'mutated';
    await (await second).finished;
    const jpeg = { mediaType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,YQ==' };
    await (await runtime.start({ text: 'resume image', agentId: first.agentId, images: [jpeg], onEvent() {} })).finished;
    assert.deepEqual(fake.state.messages, ['legacy', { text: 'image', images: [{ data: expected, mimeType: 'image/png' }] },
      { text: 'resume image', images: [{ data: 'YQ==', mimeType: 'image/jpeg' }] }]);
    const before = fake.created.length + fake.resumed.length;
    for (const invalid of [null, {}, [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YR==' }],
      [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(4194305).toString('base64')}` }]]) {
      await assert.rejects(runtime.start({ text: 'invalid', images: invalid, agentId: first.agentId, onEvent() {} }), /Cursor operation failed/);
    }
    assert.equal(fake.created.length + fake.resumed.length, before);
  } finally { await runtime.close(); restore(); await place.remove(); }
});

serial('Cursor catalogs use each explicit key, remain sessionless and copy only native metadata', async () => {
  const place = await workspace();
  const fake = install([]);
  const one = createCursorRuntime(options(place.cwd, place.session));
  const two = createCursorRuntime(options(place.cwd, place.session, { apiKey: 'second-explicit-key' }));
  const calls = [];
  let returned = [];
  sdk.listModels = async (options) => { calls.push(options); return returned; };
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await one.models.api.list(signal), { kind: 'ok', value: [] });
    returned = [{ id: 'native', displayName: 'Native', description: 'description', aliases: ['alias'], parameters: ['omit'], variants: ['omit'] }];
    const result = await two.models.api.list(signal);
    returned[0].aliases.push('mutation');
    assert.deepEqual(result.value, [{ id: 'native', displayName: 'Native', description: 'description', aliases: ['alias'] }]);
    assert.equal(Object.hasOwn(result.value[0], 'hidden'), false);
    assert.equal(Object.hasOwn(result.value[0], 'inputModalities'), false);
    assert.deepEqual(calls, [{ apiKey: key }, { apiKey: 'second-explicit-key' }]);
    assert.deepEqual([fake.created.length, fake.resumed.length, fake.roots.length], [0, 0, 0]);
    for (const invalid of [null, {}, [{}], Array(1001).fill({ id: 'x', displayName: 'X' }),
      [{ id: 'x'.repeat(257), displayName: 'X' }], [{ id: 'x', displayName: '雪'.repeat(342) }],
      [{ id: 'x', displayName: 'X', description: 'x'.repeat(4097) }],
      [{ id: 'x', displayName: 'X', aliases: Array(65).fill('a') }], [{ id: 'x', displayName: 'X', aliases: ['a'.repeat(257)] }]]) {
      returned = invalid;
      assert.equal((await one.models.api.list(signal)).error.code, 'native-failure');
    }
    sdk.listModels = async () => { throw new Error('must not escape'); };
    assert.equal((await one.models.api.list(signal)).error.code, 'native-failure');
  } finally { await one.close(); await two.close(); restore(); await place.remove(); }
});

serial('Cursor catalog timeout and abort detach the waiter while retaining one upstream lease', async (t) => {
  const place = await workspace();
  install([]);
  const runtime = createCursorRuntime(options(place.cwd, place.session));
  const signal = new AbortController().signal;
  let calls = 0;
  let held = Promise.withResolvers();
  sdk.listModels = () => { calls++; return held.promise; };
  try {
    assert.equal((await runtime.models.api.list(AbortSignal.abort())).error.code, 'closed');
    assert.equal(calls, 0);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const waiting = runtime.models.api.list(signal);
    t.mock.timers.tick(30000);
    assert.equal((await waiting).error.code, 'unavailable');
    assert.equal((await runtime.models.api.list(signal)).error.code, 'busy');
    held.resolve([{ id: 'late', displayName: 'Late' }]);
    await Promise.resolve(); await Promise.resolve();
    held = Promise.withResolvers();
    const control = new AbortController();
    const aborted = runtime.models.api.list(control.signal);
    control.abort();
    assert.equal((await aborted).error.code, 'closed');
    assert.equal((await runtime.models.api.list(signal)).error.code, 'busy');
    await runtime.close();
    assert.equal((await runtime.models.api.list(signal)).error.code, 'closed');
    held.reject(new Error('late failure is observed'));
    await Promise.resolve();
  } finally { t.mock.timers.reset(); await runtime.close(); restore(); await place.remove(); }
});

serial('closing Cursor settles an active catalog waiter without waiting for its uncancellable upstream', async () => {
  const place = await workspace(); install([]);
  const runtime = createCursorRuntime(options(place.cwd, place.session));
  const held = Promise.withResolvers(); sdk.listModels = () => held.promise;
  try {
    const waiting = runtime.models.api.list(new AbortController().signal);
    await runtime.close();
    assert.equal((await waiting).error.code, 'closed');
    held.resolve([{ malformed: true }]);
  } finally { await runtime.close(); restore(); await place.remove(); }
});
