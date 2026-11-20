import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CursorAgentError, JsonlLocalAgentStore } from '@cursor/sdk';
import { createCursorRuntime } from '@mattsp1290/switchboard/cursor';
import { assertCoherentReport } from '../adapters/readiness-oracle.mjs';

// The SDK seam is internal to the packed entry, so it is loaded by file URL past the exports map.
const { sdk } = await import(new URL('sdk.js', import.meta.resolve('@mattsp1290/switchboard/cursor')).href);
assert.equal(sdk.Store, JsonlLocalAgentStore);
const original = { create: sdk.create, resume: sdk.resume, Store: sdk.Store };

const caller = 'caller-model';
const key = 'fixture-key-never-log';

function restore() {
  sdk.create = original.create;
  sdk.resume = original.resume;
  sdk.Store = original.Store;
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
  test(name, async () => {
    await previous;
    try { await fn(); }
    finally { gate(); }
  });
}

function install(scripted) {
  const created = [];
  const resumed = [];
  const roots = [];
  const cancels = [];
  let sends = 0;
  const state = { createError: undefined, resumeError: undefined, sendError: undefined, scripts: scripted };
  class Store {
    constructor(dir) { this.dir = dir; roots.push(dir); }
  }
  function agent(id) {
    return {
      agentId: id,
      async send() {
        sends += 1;
        if (state.sendError) throw state.sendError;
        const events = state.scripts.shift() ?? [];
        let used = false;
        return {
          supports: (operation) => operation === 'cancel',
          stream() {
            if (used) throw new Error('second stream');
            used = true;
            return (async function* () {
              for (const event of events) {
                if (event instanceof Error) throw event;
                yield event;
              }
            })();
          },
          async wait() { return { status: 'finished' }; },
          async cancel() { cancels.push('cancel'); },
        };
      },
      async [Symbol.asyncDispose]() {},
    };
  }
  sdk.Store = Store;
  sdk.create = async (value) => {
    created.push(value);
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
  ], [assistant('Done')]]);
  const events = [];
  const follow = [];
  try {
    const runtime = createCursorRuntime(options(place.cwd, place.session));
    const turn = await runtime.start({ text: 'Hello', onEvent: event => events.push(event) });
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
    ]);
    for (const event of tools) assert.deepEqual(Object.keys(event).sort(), ['callId', 'kind', 'name', 'status']);
    assert.equal(JSON.stringify(events).includes('do-not-leak'), false);
    assert.deepEqual(events.at(-1), { kind: 'ended', outcome: 'completed' });
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
    await assert.rejects(runtime.start({ text: 'Hello', onEvent: event => events.push(event) }), /Cursor operation failed/);
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
    for (const value of illegal) assert.throws(() => createCursorRuntime(value), /Cursor operation failed/);
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
    await assert.rejects(runtime.close(), /Cursor operation failed/);
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
    const missing = createCursorRuntime(options(join(place.root, 'missing'), join(place.root, 'missing-session')));
    const blocked = await missing.readinessReport();
    assert.equal(blocked.verdict, 'blocked');
    assert.equal(blocked.remediation.code, 'workspace_unavailable');
    assertCoherentReport(blocked, [key, caller]);
    const closed = createCursorRuntime(options(place.cwd, join(place.root, 'closed-session')));
    await closed.close();
    const after = await closed.readinessReport();
    assert.equal(after.verdict, 'unverified');
    assert.equal(after.remediation.code, 'runtime_closed');
    await assert.rejects(access(join(place.root, 'closed-session')));
    await closed.close();
    await runtime.close();
    await missing.close();
  } finally { restore(); await place.remove(); }
});
