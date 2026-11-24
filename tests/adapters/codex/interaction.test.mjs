import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
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
const { createCodexWriters, openCodexExecution } = await import(new URL('adapters/codex/execution.ts', src).href);
const { codexServerRequestSupport, createCodexInteraction } = await import(new URL('adapters/codex/interaction.ts', src).href);
const { codexSettlement } = await import(new URL('adapters/codex/settlement.ts', src).href);
hook.deregister();

const home = '/fixture/codex-home';
const transport = { maxFrameBytes: 65536, maxChunkBytes: 131072, maxDiagnosticBytes: 64, maxPending: 8, maxHandlers: 4,
  maxWrites: 8, observationCapacity: 64, handlerTimeoutMs: 60000, observationTimeoutMs: 60000, writeTimeoutMs: 60000 };
const bounds = { maxSessions: 4, maxObservers: 2, eventCapacity: 64, maxEarlyNotifications: 8, cleanupTimeoutMs: 60000,
  acknowledgementTimeoutMs: 60000 };
const access = { bounds: { maxResults: 10, maxExamined: 10, maxDurationMs: 5000 }, signal: new AbortController().signal };
const input = [{ type: 'text', text: 'Fixture only.', text_elements: [] }];
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
const nativePolicy = { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } };
const options = { maxObservers: 2, eventCapacity: 64, maxSettled: 8, maxPending: 3, transport };
const availableDecisions = ['accept', 'acceptForSession', 'decline', 'cancel'];
const withdrawnFrame = (id) => ({ id, error: { code: -32000, message: 'Request no longer pending', data: null } });

/**
 * Inert app-server over a borrowed channel that, unlike execution.test.mjs, records every client reply frame to a server
 * request. Turns are held until the test completes or interrupts them; `turn/interrupt` completes `interrupted`.
 */
function appServer() {
  const f = { sent: [], replies: [], turns: new Map(), params: [] };
  const send = (value) => { if (f.sink && !f.gone) f.sink.data(Buffer.from(`${JSON.stringify(value)}\n`)); };
  f.notify = (method, params) => send({ method, params });
  f.request = (id, method, params) => send({ id, method, params });
  f.complete = (threadId, status = 'completed') => {
    const turnId = f.turns.get(threadId);
    f.turns.delete(threadId);
    f.notify('turn/completed', { threadId, turn: { id: turnId, status, items: [], error: null } });
  };
  f.lose = () => { f.gone = true; f.sink.ended('eof'); };
  const config = { sqlite_home: '/private/index', log_dir: '/private/logs' };
  // Natively a thread runs on `config/read` `model_provider`, or `openai` when absent (ai7m binds to it).
  const provider = config.model_provider ?? 'openai';
  const answer = {
    'initialize': () => ({ codexHome: home, userAgent: 'fake/0.169.0' }),
    'config/read': () => ({ config }),
    'account/read': () => ({ account: { type: 'apiKey' } }),
    'thread/start': () => ({ thread: { id: randomUUID(), historyMode: 'paginated', ephemeral: false, modelProvider: provider },
      ...nativePolicy }),
    'turn/start': ({ threadId }) => {
      const turnId = randomUUID();
      f.turns.set(threadId, turnId);
      queueMicrotask(() => f.notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } }));
      return { turn: { id: turnId, status: 'inProgress', items: [], error: null } };
    },
    'turn/interrupt': ({ threadId }) => { queueMicrotask(() => f.complete(threadId, 'interrupted')); return {}; },
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'thread/read': ({ threadId }) => ({ thread: { id: threadId, historyMode: 'paginated', status: { type: 'idle' },
      modelProvider: provider } }),
  };
  f.channel = {
    listen(sink) { f.sink = sink; return () => {}; },
    write(bytes) {
      const message = JSON.parse(Buffer.from(bytes).toString());
      if (message.method === undefined) { f.replies.push(message); return Promise.resolve(); }
      if (message.id === undefined) return Promise.resolve();
      f.sent.push(message.method);
      f.params.push([message.method, message.params]);
      const value = answer[message.method]?.(message.params) ?? { error: { code: -32601, message: 'unsupported' } };
      queueMicrotask(() => send(value.error ? { id: message.id, error: value.error } : { id: message.id, result: value }));
      return Promise.resolve();
    },
  };
  return f;
}
async function setup(t, { handlerTimeoutMs = transport.handlerTimeoutMs, sessions = 1, ...overrides } = {}) {
  const f = appServer();
  const made = createCodexInteraction({ ...options, transport: { ...transport, handlerTimeoutMs }, ...overrides });
  assert.equal(made.kind, 'ok');
  const bridge = made.value;
  const events = [];
  bridge.events.subscribe((event) => { events.push(event); });
  const opened = await openCodexExecution({ channel: f.channel, transport: { ...transport, handlerTimeoutMs }, bounds, home,
    writers: createCodexWriters(8), initialize: {}, onServerRequest: bridge.onServerRequest, signal: access.signal,
    processExit: new Promise(() => {}) });
  assert.equal(opened.kind, 'ok', JSON.stringify(opened));
  const execution = opened.value;
  t.after(() => execution.close());
  const list = [];
  for (let n = 0; n < sessions; n++) {
    const created = await execution.create({ ...access, params: { approvalPolicy: 'untrusted' } });
    assert.equal(created.kind, 'ok');
    assert.equal(bridge.attach(created.value).kind, 'ok');
    list.push(created.value);
  }
  return { f, bridge, events, execution, sessions: list };
}
async function turnOn(session) {
  const started = session.turn({ hostOperationId: randomUUID(), input, signal: access.signal, recordIntent: () => {} });
  assert.equal(started.kind, 'ok', JSON.stringify(started));
  await started.value.run();
  return started.value;
}
/** A native command approval (no `approvalId`, as 0.169 sends) for the active turn; returns the published pending record. */
async function approval(ctx, session, id = 'req-1', extra = {}) {
  const turnId = ctx.f.turns.get(session.threadId);
  ctx.f.request(id, 'item/commandExecution/requestApproval', { kind: 'command', threadId: session.threadId, turnId,
    itemId: `item-${id}`, startedAtMs: 1, environmentId: null, command: 'touch /tmp/marker',
    availableDecisions, ...extra });
  await settle();
  const event = ctx.events.findLast((candidate) => candidate.kind === 'pending');
  assert.ok(event, 'pending published');
  return event.pending;
}
const choose = (pending, nativeChoiceId) => ({ formatVersion: 1, kind: 'approval', target: structuredClone(pending.target), nativeChoiceId });
const reply = (ctx, value, intent = {}) => ctx.bridge.reply({ value, recordIntent: () => {}, signal: access.signal, ...intent });
const settledOf = (events) => events.filter((event) => event.kind === 'settled').map((event) => event.settlement);
const refusedError = (code) => ({ kind: 'error', error: { code } });

test('approve: the chosen native decision is the one reply frame for the native request id', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const pending = await approval(ctx, session);
  assert.deepEqual(pending.choices.map((choice) => choice.nativeChoiceId), ['accept', 'acceptForSession', 'decline', 'cancel']);
  assert.deepEqual(pending.target.tool, { nativeToolCallId: 'item-req-1' });
  assert.deepEqual(pending.target.session, session.reference);
  assert.deepEqual(JSON.parse(pending.target.nativeApprovalId), ['req-1', ctx.f.turns.get(session.threadId), 'item-req-1', null]);
  assert.deepEqual(pending.nativePolicy.data, nativePolicy);
  assert.deepEqual(ctx.bridge.pending(), [pending]);
  assert.deepEqual(await reply(ctx, choose(pending, 'accept')),
    { kind: 'ok', value: { nativeChoiceId: 'accept', delivery: { kind: 'unknown' } } });
  await settle();
  assert.deepEqual(ctx.f.replies, [{ id: 'req-1', result: { decision: 'accept' } }]);
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'replied', nativeChoiceId: 'accept', delivery: { kind: 'unknown' } }]);
  assert.deepEqual(ctx.bridge.pending(), []);
  ctx.f.complete(session.threadId);
  assert.equal((await turn.completion).terminal.status, 'completed');
});

test('deny: decline is replied once and a declined item is the only qualified no-effect observation', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  const pending = await approval(ctx, session);
  assert.equal((await reply(ctx, choose(pending, 'decline'))).kind, 'ok');
  await settle();
  ctx.f.notify('serverRequest/resolved', { threadId: session.threadId, requestId: 'req-1' });
  ctx.f.notify('item/completed', { threadId: session.threadId, turnId, item: { id: 'item-req-1', type: 'commandExecution', status: 'declined' } });
  await settle();
  assert.deepEqual(ctx.f.replies, [{ id: 'req-1', result: { decision: 'decline' } }]);
  const observed = ctx.events.filter((event) => event.kind === 'observed');
  assert.deepEqual(observed.map((event) => [event.method, event.effect.kind, event.evidence]),
    [['serverRequest/resolved', 'unknown', 'unqualified'], ['item/completed', 'known', 'qualified']]);
  assert.equal(observed[1].effect.effect, 'none');
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'replied', nativeChoiceId: 'decline', delivery: { kind: 'unknown' } }],
    'native evidence never upgrades delivery');
});

test('an accepted command that completes keeps its effect unknown', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  const pending = await approval(ctx, session);
  await reply(ctx, choose(pending, 'accept'));
  ctx.f.notify('item/completed', { threadId: session.threadId, turnId, item: { id: 'item-req-1', type: 'commandExecution', status: 'completed' } });
  await settle();
  const observed = ctx.events.find((event) => event.kind === 'observed');
  assert.deepEqual([observed.effect, observed.evidence], [{ kind: 'unknown' }, 'unqualified']);
});

test('invalid continuations are refused with core codes and write nothing', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const pending = await approval(ctx, session);
  const base = choose(pending, 'accept');
  const cases = [
    [null, 'invalid-input'], [{ ...base, kind: 'other' }, 'invalid-input'], [{ ...base, formatVersion: 2 }, 'unsupported-version'],
    [{ ...base, nativeChoiceId: 'allow-all' }, 'choice-mismatch'],
    [{ ...base, target: { ...base.target, session: { ...base.target.session, binding: { ...base.target.session.binding, account: 'chatgpt:x' } } } }, 'binding-mismatch'],
    [{ ...base, target: { ...base.target, session: { ...base.target.session, opaque: randomUUID() } } }, 'session-mismatch'],
    [{ ...base, target: { ...base.target, tool: null } }, 'target-mismatch'],
    // A host correlation ID is never a native target.
    [{ ...base, target: { ...base.target, nativeApprovalId: 'host-operation-7' } }, 'stale-interaction'],
  ];
  for (const [value, code] of cases) assert.deepEqual(await reply(ctx, value), refusedError(code), code);
  assert.deepEqual(await ctx.bridge.reply({ value: base, recordIntent: null, signal: access.signal }), refusedError('invalid-input'));
  await settle();
  assert.deepEqual(ctx.f.replies, []);
  assert.deepEqual(ctx.bridge.pending(), [pending], 'still pending after every refusal');
});

test('a duplicate reply is refused and never resent; a reply after native withdrawal is stale', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const first = await approval(ctx, session, 'req-1');
  assert.equal((await reply(ctx, choose(first, 'decline'))).kind, 'ok');
  assert.deepEqual(await reply(ctx, choose(first, 'decline')), refusedError('duplicate-interaction'));
  assert.deepEqual(await reply(ctx, choose(first, 'accept')), refusedError('duplicate-interaction'));
  const second = await approval(ctx, session, 'req-2');
  ctx.f.notify('serverRequest/resolved', { threadId: session.threadId, requestId: 'req-2' });
  await settle();
  assert.deepEqual(await reply(ctx, choose(second, 'accept')), refusedError('stale-interaction'));
  assert.deepEqual(ctx.f.replies, [{ id: 'req-1', result: { decision: 'decline' } }, withdrawnFrame('req-2')]);
  assert.deepEqual(settledOf(ctx.events).map((settlement) => settlement.kind), ['replied', 'withdrawn']);
});

test('recordIntent runs before the single native write; a failed, aborted or superseded intent writes nothing', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const pending = await approval(ctx, session);
  const value = choose(pending, 'decline');
  assert.deepEqual(await reply(ctx, value, { recordIntent: () => { throw new Error('disk'); } }), refusedError('intent-failed'));
  assert.deepEqual(await reply(ctx, value, { signal: AbortSignal.abort() }), refusedError('aborted'));
  assert.deepEqual(ctx.bridge.pending(), [pending], 'still pending and answerable');
  const intents = [];
  let release;
  const recording = new Promise((resolve) => { release = resolve; });
  const replying = reply(ctx, value, { recordIntent: (intent, signal) => {
    intents.push(intent);
    assert.equal(signal, access.signal);
    assert.deepEqual(ctx.f.replies, [], 'intent precedes the native write');
    return recording;
  } });
  assert.deepEqual(await reply(ctx, value), refusedError('duplicate-interaction'), 'a reply racing the intent');
  release();
  assert.deepEqual(await replying, { kind: 'ok', value: { nativeChoiceId: 'decline', delivery: { kind: 'unknown' } } });
  assert.deepEqual(intents, [{ target: pending.target, nativeChoiceId: 'decline' }]);
  const second = await approval(ctx, session, 'req-2');
  let open;
  const held = reply(ctx, choose(second, 'accept'), { recordIntent: () => new Promise((resolve) => { open = resolve; }) });
  ctx.f.notify('serverRequest/resolved', { threadId: session.threadId, requestId: 'req-2' });
  await settle();
  open();
  assert.deepEqual(await held, refusedError('stale-interaction'), 'withdrawn while the intent was recorded');
  await settle();
  assert.deepEqual(ctx.f.replies, [{ id: 'req-1', result: { decision: 'decline' } }, withdrawnFrame('req-2')]);
});

test('protocol traffic continues while an approval is pending', async (t) => {
  const ctx = await setup(t, { sessions: 2 });
  const [a, b] = ctx.sessions;
  const seen = [];
  a.events.subscribe((event) => { seen.push(event.kind); });
  const held = await turnOn(a);
  const pending = await approval(ctx, a);
  const turnId = ctx.f.turns.get(a.threadId);
  ctx.f.notify('item/agentMessage/delta', { threadId: a.threadId, turnId, itemId: 'm', delta: 'still streaming' });
  const other = await turnOn(b);
  ctx.f.complete(b.threadId);
  assert.equal((await other.completion).terminal.status, 'completed', 'independent session completes');
  const read = await ctx.execution.scope.request({ method: 'thread/read', params: { threadId: b.threadId } }, access.signal);
  assert.equal(read.kind, 'reply', 'client request answered');
  await settle();
  assert.ok(seen.includes('text-delta'), 'same-session notifications flow');
  assert.deepEqual(ctx.bridge.pending(), [pending]);
  await reply(ctx, choose(pending, 'decline'));
  ctx.f.complete(a.threadId);
  assert.equal((await held.completion).terminal.status, 'completed');
});

test('a busy session refuses a second turn while an approval is pending and accepts one after the terminal', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const pending = await approval(ctx, session);
  const before = ctx.f.sent.length;
  assert.deepEqual(session.turn({ hostOperationId: 'two', input, signal: access.signal, recordIntent: () => {} }),
    { kind: 'error', error: { code: 'busy' } });
  assert.equal(ctx.f.sent.length, before);
  await reply(ctx, choose(pending, 'decline'));
  ctx.f.complete(session.threadId);
  await turn.completion;
  const next = await turnOn(session);
  ctx.f.complete(session.threadId);
  assert.equal((await next.completion).terminal.status, 'completed');
});

test('interrupt while waiting on approval: the native terminal withdraws it with an error reply, never a decision', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const pending = await approval(ctx, session);
  assert.equal((await session.interrupt()).step, 'replied', 'both native terminal and RPC reply are parsed before intake; terminal retirement cannot erase the reply');
  assert.equal((await turn.completion).terminal.status, 'interrupted');
  await settle();
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'withdrawn', by: 'turn/completed', evidence: 'unqualified' }]);
  assert.deepEqual(ctx.f.replies, [withdrawnFrame('req-1')]);
  assert.deepEqual(await reply(ctx, choose(pending, 'accept')), refusedError('stale-interaction'));
  const next = await turnOn(session);
  ctx.f.complete(session.threadId);
  assert.equal((await next.completion).terminal.status, 'completed', 'cancel did not close the session');
});

test('cancel while a tool runs after approval reports the request and the native terminal; the effect stays unknown', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  const pending = await approval(ctx, session);
  await reply(ctx, choose(pending, 'accept'));
  ctx.f.notify('item/started', { threadId: session.threadId, turnId, item: { id: 'item-req-1', type: 'commandExecution', status: 'inProgress' } });
  assert.equal((await session.interrupt()).step, 'replied', 'both native terminal and RPC reply are parsed before intake; terminal retirement cannot erase the reply');
  ctx.f.notify('item/completed', { threadId: session.threadId, turnId, item: { id: 'item-req-1', type: 'commandExecution', status: 'failed' } });
  assert.equal((await turn.completion).terminal.status, 'interrupted');
  await settle();
  assert.deepEqual(ctx.events.find((event) => event.kind === 'observed').effect, { kind: 'unknown' });
  assert.equal(ctx.f.replies.length, 1, 'no second reply after cancel');
});

test('transport loss while an approval is pending settles lost, writes nothing and a later reply is stale', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const pending = await approval(ctx, session);
  ctx.f.lose();
  assert.equal((await turn.completion).kind, 'unconcluded');
  await settle();
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'lost', reply: 'not-sent', cause: 'eof' }]);
  assert.deepEqual(await reply(ctx, choose(pending, 'accept')), refusedError('stale-interaction'));
  assert.deepEqual(ctx.f.replies, []);
});

test('a reply whose write is lost stays delivery-unknown and is never resent', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const pending = await approval(ctx, session);
  assert.deepEqual((await reply(ctx, choose(pending, 'decline'))).value.delivery, { kind: 'unknown' });
  ctx.f.lose();
  await settle();
  assert.deepEqual(await reply(ctx, choose(pending, 'decline')), refusedError('duplicate-interaction'));
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'replied', nativeChoiceId: 'decline', delivery: { kind: 'unknown' } }]);
  assert.ok(ctx.f.replies.length <= 1);
});

test('a host that never answers trips the transport handler deadline; the approval settles lost unanswered', async (t) => {
  const ctx = await setup(t, { handlerTimeoutMs: 20 });
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  await approval(ctx, session);
  const completion = await turn.completion;
  assert.deepEqual([completion.kind, completion.reason], ['unconcluded', 'handler-timeout']);
  await settle();
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'lost', reply: 'not-sent', cause: 'handler-timeout' }]);
  assert.deepEqual(ctx.f.replies, [], 'the bridge never answers on its own deadline');
});

test('host-selected expiry answers a decision-free error before the handler deadline and the transport survives', async (t) => {
  const ctx = await setup(t, { handlerTimeoutMs: 5000, expiry: { afterMs: 20 } });
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const pending = await approval(ctx, session);
  while (settledOf(ctx.events).length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'expired', delivery: { kind: 'unknown' } }]);
  const projected = ctx.events.map(codexSettlement).filter(Boolean);
  assert.deepEqual(projected.map((event) => event.settlement), [{ namespace: 'codex-app-server/interaction-settlement', schemaVersion: 1, data: { kind: 'expired' } }]);
  assert.deepEqual(ctx.f.replies, [{ id: 'req-1', error: { code: -32000, message: 'Approval expired unanswered', data: null } }]);
  assert.deepEqual(await reply(ctx, choose(pending, 'accept')), refusedError('stale-interaction'));
  ctx.f.complete(session.threadId);
  assert.equal((await turn.completion).terminal.status, 'completed', 'the transport stayed open');
});

test('unsupported server requests are reported and refused with -32601, never a permit', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const refused = [...Object.keys(codexServerRequestSupport).filter((method) => codexServerRequestSupport[method] === 'refused'),
    'item/unknownFuture/request'];
  // One at a time: each refusal is answered at once, but a burst beyond `maxHandlers` is a transport overflow.
  for (const [index, method] of refused.entries()) {
    ctx.f.request(index + 100, method, { threadId: session.threadId });
    await settle();
  }
  assert.deepEqual(ctx.f.replies.map((frame) => [frame.id, frame.error?.code, frame.result]),
    refused.map((_, index) => [index + 100, -32601, undefined]));
  assert.deepEqual(ctx.events.filter((event) => event.kind === 'refused').map((event) => [event.method, event.reason]),
    refused.map((method) => [method, 'unsupported']));
  assert.deepEqual(ctx.bridge.pending(), []);
});

test('unattached threads and malformed approvals are refused and reported', async (t) => {
  const ctx = await setup(t);
  ctx.f.request(1, 'item/commandExecution/requestApproval', { threadId: randomUUID(), turnId: 't', itemId: 'i' });
  ctx.f.request(2, 'item/fileChange/requestApproval', { threadId: ctx.sessions[0].threadId, turnId: 7, itemId: 'i' });
  ctx.f.request(3, 'item/fileChange/requestApproval', { threadId: ctx.sessions[0].threadId, turnId: 't', itemId: '\u0085' });
  await settle();
  assert.deepEqual(ctx.events.filter((event) => event.kind === 'refused').map((event) => event.reason), ['unattached', 'malformed', 'malformed']);
  assert.deepEqual(ctx.f.replies.map((frame) => frame.error.code), [-32601, -32602, -32602]);
});

test('numeric and string native request ids are answered with their exact type', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const numeric = await approval(ctx, session, 7);
  const text = await approval(ctx, session, '7');
  assert.notEqual(numeric.target.nativeApprovalId, text.target.nativeApprovalId);
  await reply(ctx, choose(text, 'decline'));
  await reply(ctx, choose(numeric, 'accept'));
  await settle();
  assert.deepEqual(ctx.f.replies, [{ id: '7', result: { decision: 'decline' } }, { id: 7, result: { decision: 'accept' } }]);
});

test('choices are the request availableDecisions; an object decision is written verbatim and nothing forces a policy', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  // The 0.169 native shape: no `decline` offered, and the amendment arrives as an object decision.
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', '/tmp/marker'] } };
  const pending = await approval(ctx, session, 'req-1', { availableDecisions: ['accept', amendment, 'cancel'],
    proposedExecpolicyAmendment: ['touch', '/tmp/marker'] });
  assert.deepEqual(pending.choices.map((choice) => choice.nativeChoiceId), ['accept', 'acceptWithExecpolicyAmendment:1', 'cancel']);
  assert.equal(JSON.parse(pending.target.nativeApprovalId)[3], null, 'absent approvalId is part of the identity');
  for (const choice of ['decline', 'acceptForSession', 'acceptWithExecpolicyAmendment']) {
    assert.deepEqual(await reply(ctx, choose(pending, choice)), refusedError('choice-mismatch'), choice);
  }
  await settle();
  assert.deepEqual([ctx.f.replies, ctx.bridge.pending()], [[], [pending]], 'not-offered choices are refused locally, nothing written');
  await reply(ctx, choose(pending, 'acceptWithExecpolicyAmendment:1'));
  await settle();
  assert.deepEqual(ctx.f.replies, [{ id: 'req-1', result: { decision: amendment } }]);
  const policy = ctx.f.params.filter(([method]) => ['thread/start', 'turn/start'].includes(method)).map(([, params]) => params);
  assert.deepEqual(policy.map((params) => [params.approvalPolicy, params.sandbox]), [['untrusted', undefined], [undefined, undefined]],
    'only host-passed policy reaches native');
});

test('a command approval without a usable availableDecisions list is refused malformed, never given synthesized choices', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  const lists = [undefined, null, [], ['accept', 'accept'], ['accept', { a: 1, b: 2 }], ['accept', 7]];
  for (const [n, list] of lists.entries()) {
    ctx.f.request(`bad-${n}`, 'item/commandExecution/requestApproval',
      { threadId: session.threadId, turnId, itemId: `item-${n}`, ...(list === undefined ? {} : { availableDecisions: list }) });
    await settle();
  }
  assert.deepEqual(ctx.events.map((event) => [event.kind, event.reason]), lists.map(() => ['refused', 'malformed']));
  assert.deepEqual(ctx.f.replies.map((frame) => frame.error.code), lists.map(() => -32602));
});

test('tool and delegation continuations are unsupported for Codex', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(await reply(ctx, { formatVersion: 1, kind: 'delegation', outcomes: [] }),
    { kind: 'error', error: { code: 'unsupported', feature: 'delegation' } });
  assert.deepEqual(await reply(ctx, { formatVersion: 1, kind: 'tool', outcome: {} }),
    { kind: 'error', error: { code: 'unsupported', feature: 'tool' } });
});

test('observer detach is not cancellation and invalid options or a second attach are refused', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const pending = await approval(ctx, session);
  const subscription = session.events.subscribe(() => {});
  subscription.value.dispose();
  await settle();
  assert.equal(ctx.f.sent.includes('turn/interrupt'), false);
  assert.deepEqual(ctx.bridge.pending(), [pending]);
  assert.deepEqual(ctx.bridge.attach(session), { kind: 'error', error: { code: 'busy' } });
  for (const broken of [{}, null, { ...options, maxObservers: 0 }, { ...options, maxPending: transport.maxHandlers },
    { ...options, expiry: { afterMs: transport.handlerTimeoutMs } }, { ...options, expiry: { afterMs: 0 } }]) {
    assert.deepEqual(createCodexInteraction(broken), { kind: 'error', error: { code: 'invalid-input' } });
  }
  await reply(ctx, choose(pending, 'decline'));
  ctx.f.complete(session.threadId);
  await turn.completion;
});

test('approvals beyond maxPending are refused with a decision-free error and never overflow the transport', async (t) => {
  const ctx = await setup(t, { sessions: 2 });
  const [a, b] = ctx.sessions;
  const turns = [await turnOn(a), await turnOn(b)];
  const request = (id, session) => ctx.f.request(id, 'item/commandExecution/requestApproval', { threadId: session.threadId,
    turnId: ctx.f.turns.get(session.threadId), itemId: `item-${id}`, availableDecisions });
  // A burst of maxPending + 1 (= maxHandlers) in one tick: one handler slot is left for the refusal.
  for (const [id, session] of [['a1', a], ['a2', a], ['b1', b], ['b2', b]]) request(id, session);
  await settle();
  assert.equal(ctx.bridge.pending().length, options.maxPending);
  assert.deepEqual(ctx.f.replies, [{ id: 'b2', error: { code: -32000, message: 'Too many pending approvals', data: null } }]);
  assert.deepEqual(ctx.events.filter((event) => event.kind === 'refused').map((event) => [event.reason, event.code]), [['capacity', -32000]]);
  // Beyond the guard the documented transport bound still applies: a burst above maxHandlers ends the transport.
  for (const id of ['x1', 'x2']) request(id, b);
  for (const turn of turns) assert.equal((await turn.completion).reason, 'handler-overflow');
  await settle();
  assert.deepEqual(settledOf(ctx.events).map((settlement) => settlement.kind), ['lost', 'lost', 'lost']);
});

test('a request for a completed turn is withdrawn without being offered as pending', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  ctx.f.complete(session.threadId);
  await turn.completion;
  await settle();
  ctx.f.request('late', 'item/commandExecution/requestApproval', { threadId: session.threadId, turnId, itemId: 'i', availableDecisions });
  await settle();
  assert.deepEqual(settledOf(ctx.events), []);
  assert.equal(ctx.events.some((event) => event.kind === 'pending'), false);
  assert.equal(ctx.f.replies[0].error.code, -32000);
});

test('a slow public session observer cannot disconnect trusted interaction intake', async (t) => {
  const ctx = await setup(t); const [session] = ctx.sessions; await turnOn(session);
  const stuck = session.events.subscribe(() => new Promise(() => {}));
  for (let i = 0; i < 70; i++) { ctx.f.notify('fixture/padding', { threadId: session.threadId, turnId: ctx.f.turns.get(session.threadId) }); await settle(1); }
  assert.equal(await stuck.value.ended, 'overflow');
  const pending = await approval(ctx, session);
  assert.equal((await reply(ctx, choose(pending, 'decline'))).kind, 'ok'); await settle();
  assert.equal(ctx.f.replies[0].result.decision, 'decline');
});

test('a second host tool reply is duplicate-interaction and a completion without a string turn id does not deliver', async (t) => {
  const ctx = await setup(t, { declaredTools: [{ name: 'lookup', namespace: 'application' }] });
  const [session] = ctx.sessions;
  await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  ctx.f.request('tool-1', 'item/tool/call', { threadId: session.threadId, turnId, callId: 'call-1', namespace: 'application',
    tool: 'lookup', arguments: { city: 'Paris' } });
  await settle();
  const call = ctx.events.find((event) => event.kind === 'host-call');
  assert.ok(call);
  const value = { formatVersion: 1, kind: 'tool', outcome: { target: call.call.pending.target,
    result: { kind: 'ok', value: { namespace: 'host', schemaVersion: 1, data: { text: 'ok' } } },
    effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
  assert.equal((await reply(ctx, value)).kind, 'ok');
  assert.deepEqual(await reply(ctx, value), refusedError('duplicate-interaction'));
  const before = ctx.events.filter((event) => event.kind === 'host-delivery').length;
  ctx.f.notify('item/completed', { threadId: session.threadId, item: { id: 'call-1', type: 'dynamicToolCall' } });
  ctx.f.notify('item/completed', { threadId: session.threadId, turnId: 'other-turn', item: { id: 'call-1', type: 'dynamicToolCall' } });
  await settle();
  assert.equal(ctx.events.filter((event) => event.kind === 'host-delivery').length, before);
  ctx.f.notify('item/completed', { threadId: session.threadId, turnId, item: { id: 'call-1', type: 'dynamicToolCall' } });
  await settle();
  assert.equal(ctx.events.filter((event) => event.kind === 'host-delivery').length, before + 1);
});

test('an evicted settled approval answers stale instead of duplicate', async (t) => {
  const ctx = await setup(t, { maxSettled: 1 });
  const [session] = ctx.sessions;
  await turnOn(session);
  const first = await approval(ctx, session, 'req-1');
  await reply(ctx, choose(first, 'decline'));
  assert.deepEqual(await reply(ctx, choose(first, 'decline')), refusedError('duplicate-interaction'));
  const second = await approval(ctx, session, 'req-2');
  await reply(ctx, choose(second, 'decline'));
  assert.deepEqual(await reply(ctx, choose(first, 'decline')), refusedError('stale-interaction'));
  await settle();
  assert.equal(ctx.f.replies.length, 2, 'never a second write for either');
});

for (const reason of [new Error('untrusted'), { arbitrary: true }, 'unknown-reason']) test('arbitrary abort reasons normalize to aborted for tools and approvals', async (t) => {
  const ctx = await setup(t, { declaredTools: [{ name: 'lookup', namespace: 'application' }] });
  const [session] = ctx.sessions;
  await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  const control = new AbortController();
  const command = { id: 'direct-approval', method: 'item/commandExecution/requestApproval',
    params: { threadId: session.threadId, turnId, itemId: 'a', availableDecisions }, raw: {} };
  const tool = { id: 'direct-tool', method: 'item/tool/call', params: { threadId: session.threadId, turnId,
    callId: 't', namespace: 'application', tool: 'lookup', arguments: {} }, raw: {} };
  const held = [ctx.bridge.onServerRequest(command, control.signal, { replyAllowed() {}, fault() {}, watchNotification: () => () => {} }), ctx.bridge.onServerRequest(tool, control.signal, { replyAllowed() {}, fault() {}, watchNotification: () => () => {} })];
  control.abort(reason);
  await Promise.all(held);
  await settle();
  const projected = ctx.events.map(codexSettlement).filter(Boolean);
  assert.deepEqual(projected.map((event) => event.settlement.data), [{ kind: 'lost', cause: 'aborted' }, { kind: 'lost', cause: 'aborted' }]);
  control.abort();
  assert.equal(projected.length, 2);
  ctx.f.complete(session.threadId);
});

for(const method of ['item/fileChange/requestApproval','item/tool/call']) test(`pre-ack ${method} watcher hands off without a withdrawal gap`,async(t)=>{
 const ctx=await setup(t);const session=ctx.sessions[0];const gate=Promise.withResolvers();const listeners=[];let watcher;
 const made=createCodexInteraction({...options,declaredTools:[{name:'lookup',namespace:'application'}]});assert.equal(made.kind,'ok');
 const bridge=made.value;assert.equal(bridge.attach({...session,matchesTurn:()=>gate.promise,intake(listener){listeners.push(listener);return {kind:'ok',value(){}};}}).kind,'ok');
 const params={threadId:session.threadId,turnId:'preack-turn',itemId:'item',callId:'call',tool:'lookup',namespace:'application',arguments:{}};
 const request={id:'preack',method,params,raw:{id:'preack',method,params}};
 const reply=bridge.onServerRequest(request,access.signal,{replyAllowed(){},fault(){},watchNotification(fn){watcher=fn;return ()=>{watcher=undefined;};}});
 gate.resolve(true);queueMicrotask(()=>{const params={threadId:session.threadId,turnId:'preack-turn',requestId:'preack'};watcher?.({kind:'notification',method:'serverRequest/resolved',params,raw:{}});for(const listener of listeners)listener.notification?.('serverRequest/resolved',params);});
 const result=await reply;assert.equal(result.kind,'error');assert.equal(result.error.code,-32000);assert.deepEqual(bridge.pending(),[]);assert.deepEqual(bridge.hostCalls(),[]);
});

test('prepared approval entry and projection follow the actual writer invocation', async t => {
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);let observedWrites=-1;let replies=0;
 ctx.bridge.project(event=>{if(event.kind==='settled'&&event.settlement.kind==='replied'){observedWrites=ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length;ctx.f.lose();}});
 const prepared=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(prepared.kind,'ok');assert.equal(prepared.value.commit(access.signal,()=>{replies++;},ctx.execution.flushIntake).kind,'ok');
 assert.equal((await prepared.value.entry).kind,'ok');await settle();assert.equal(observedWrites,1);assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);assert.equal(prepared.value.entered(),true);assert.equal(replies,1);
});

test('an abort inside the writer cannot erase a prepared approval entry that already happened', async t => {
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const control=new AbortController();const write=ctx.f.channel.write;
 ctx.f.channel.write=bytes=>{const result=write(bytes);const frame=JSON.parse(Buffer.from(bytes));if(Object.hasOwn(frame,'result'))control.abort();return result;};
 const prepared=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(prepared.kind,'ok');assert.equal(prepared.value.commit(control.signal,()=>{},ctx.execution.flushIntake).kind,'ok');
 assert.equal((await prepared.value.entry).kind,'ok');await settle();assert.equal(prepared.value.entered(),true);assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);
});

test('a projection failure cannot strand refused batch entry or written waiters',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const first=await approval(ctx,session,'first');
 const held=Promise.withResolvers();const write=ctx.f.channel.write;let blocked=false;ctx.f.channel.write=bytes=>{const result=write(bytes);if(!blocked&&JSON.parse(Buffer.from(bytes)).method==='thread/start'){blocked=true;return held.promise;}return result;};
 assert.equal((await ctx.execution.create(access)).kind,'ok');
 ctx.bridge.project(event=>{if(event.kind==='settled'&&event.target.nativeApprovalId===first.target.nativeApprovalId&&event.settlement.kind==='lost')throw new Error('project failed');});
 const prepared=ctx.bridge.prepareBatch([choose(first,'decline')]);assert.equal(prepared.kind,'ok');assert.equal(prepared.value.commit(access.signal,()=>{},ctx.execution.flushIntake).kind,'ok');await approval(ctx,session,'second');held.resolve();
 const bounded=promise=>Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve('timeout'),100))]);
 const [entry,written]=await Promise.all([bounded(prepared.value.entry),bounded(prepared.value.written)]);assert.equal(entry.kind,'error');assert.equal(written.kind,'error');await settle();assert.equal(ctx.f.replies.some(frame=>frame.id==='first'&&Object.hasOwn(frame,'result')),false);
});
test('a single approval reply publishes its settlement after actual writer invocation',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);let observed=-1;
 ctx.bridge.project(event=>{if(event.kind==='settled'&&event.settlement.kind==='replied'){observed=ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length;ctx.f.lose();}});
 assert.equal((await reply(ctx,choose(pending,'decline'))).kind,'ok');await settle();assert.equal(observed,1);assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);
});

async function holdReplyWriter(ctx) {
 const held=Promise.withResolvers();const write=ctx.f.channel.write;let armed=true;
 ctx.f.channel.write=bytes=>{const result=write(bytes);if(armed&&JSON.parse(Buffer.from(bytes)).method==='thread/start'){armed=false;return held.promise;}return result;};
 assert.equal((await ctx.execution.create(access)).kind,'ok');return ()=>held.resolve();
}

for (const aborted of [false,true]) test(`repeating a batch commit inside its writer cannot retract entry (aborted: ${aborted})`,async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const prepared=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(prepared.kind,'ok');
 const write=ctx.f.channel.write;let duplicate;let replies=0;ctx.f.channel.write=bytes=>{const result=write(bytes);if(Object.hasOwn(JSON.parse(Buffer.from(bytes)),'result'))duplicate=prepared.value.commit(aborted?AbortSignal.abort():access.signal,()=>assert.fail('duplicate reply callback'),ctx.execution.flushIntake);return result;};
 assert.equal(prepared.value.commit(access.signal,()=>{replies++;},ctx.execution.flushIntake).kind,'ok');assert.equal((await prepared.value.entry).kind,'ok');assert.equal((await prepared.value.written).kind,'ok');await settle();assert.equal(duplicate.kind,'error');assert.equal(prepared.value.entered(),true);assert.equal(replies,1);assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);
});

test('a stale overlapping prepared batch cannot discard another batch reservation',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const first=ctx.bridge.prepareBatch([choose(pending,'decline')]);const second=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(first.kind,'ok');assert.equal(second.kind,'ok');const release=await holdReplyWriter(ctx);
 first.value.commit(access.signal,()=>{},ctx.execution.flushIntake);assert.equal(second.value.commit(access.signal,()=>{},ctx.execution.flushIntake).kind,'error');release();assert.equal((await first.value.entry).kind,'ok');assert.equal((await first.value.written).kind,'ok');assert.equal((await second.value.entry).kind,'error');await settle();assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);
});

test('an old prepared batch cannot retract a single reply from inside its writer',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const old=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(old.kind,'ok');const write=ctx.f.channel.write;let refused;
 ctx.f.channel.write=bytes=>{const result=write(bytes);if(Object.hasOwn(JSON.parse(Buffer.from(bytes)),'result'))refused=old.value.commit(access.signal,()=>{},ctx.execution.flushIntake);return result;};
 assert.equal((await reply(ctx,choose(pending,'decline'))).kind,'ok');await settle();assert.equal(refused.kind,'error');assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);
});

test('a replied projector error preserves all actual batch entry facts',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);let replies=0;
 ctx.bridge.project(event=>{if(event.kind==='settled'&&event.settlement.kind==='replied')throw new Error('projection failed');});
 const prepared=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(prepared.kind,'ok');prepared.value.commit(access.signal,()=>{replies++;},ctx.execution.flushIntake);assert.equal((await prepared.value.entry).kind,'ok');assert.equal((await prepared.value.written).kind,'ok');await settle();assert.equal(replies,1);assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);assert.equal((await ctx.execution.close()).transport.reason,'handler-error');
});

for(const kind of ['approval','tool'])test(`teardown contains a throwing ${kind} loss projector`,async t=>{
 const ctx=await setup(t,{declaredTools:[{name:'lookup',namespace:'application'}]});const session=ctx.sessions[0];await turnOn(session);
 if(kind==='approval')await approval(ctx,session);else{ctx.f.request('tool-loss','item/tool/call',{threadId:session.threadId,turnId:ctx.f.turns.get(session.threadId),callId:'call',namespace:'application',tool:'lookup',arguments:{}});await settle();assert.equal(ctx.bridge.hostCalls().length,1);}
 ctx.bridge.project(event=>{if((event.kind==='settled'||event.kind==='host-settled')&&event.settlement.kind==='lost')throw new Error('loss projection failed');});
 ctx.f.lose();await settle();assert.equal(ctx.bridge.pending().length,0);assert.equal(ctx.bridge.hostCalls().length,0);assert.equal((await ctx.execution.close()).transport.reason,'eof');
});

test('refused gate cleanup projects after the decision-free writer invocation',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const first=await approval(ctx,session,'first');const release=await holdReplyWriter(ctx);let observed=-1;
 ctx.bridge.project(event=>{if(event.kind==='settled'&&event.target.nativeApprovalId===first.target.nativeApprovalId&&event.settlement.kind==='lost'){observed=ctx.f.replies.filter(frame=>frame.id==='first'&&Object.hasOwn(frame,'error')).length;ctx.f.lose();}});
 const prepared=ctx.bridge.prepareBatch([choose(first,'decline')]);assert.equal(prepared.kind,'ok');prepared.value.commit(access.signal,()=>{},ctx.execution.flushIntake);await approval(ctx,session,'second');release();assert.equal((await prepared.value.entry).kind,'error');await settle();assert.equal(observed,1);assert.equal(ctx.f.replies.some(frame=>frame.id==='first'&&Object.hasOwn(frame,'result')),false);
});

test('a thrown reply callback faults the owner without erasing writer facts',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const prepared=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(prepared.kind,'ok');prepared.value.commit(access.signal,()=>{throw new Error('reply observer failed');},ctx.execution.flushIntake);assert.equal((await prepared.value.written).kind,'ok');await settle();assert.equal((await ctx.execution.close()).transport.reason,'handler-error');assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);
});

test('caller abort after recording cannot strand an unstaged single reply reservation',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const control=new AbortController();
 const result=await ctx.bridge.reply({value:choose(pending,'decline'),signal:control.signal,recordIntent(){queueMicrotask(()=>queueMicrotask(()=>control.abort()));}});assert.equal(result.kind,'ok');await settle();assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);assert.equal(ctx.bridge.pending().length,0);ctx.f.complete(session.threadId);
});

for(const kind of ['approval','tool'])test(`initial ${kind} projector failure retires the failed handler authority`,async t=>{
 const ctx=await setup(t,{declaredTools:[{name:'lookup',namespace:'application'}]});const session=ctx.sessions[0];await turnOn(session);
 ctx.bridge.project(event=>{if(event.kind===(kind==='approval'?'pending':'host-call'))throw new Error('initial projection failed');});
 if(kind==='approval')ctx.f.request('initial-fail','item/commandExecution/requestApproval',{threadId:session.threadId,turnId:ctx.f.turns.get(session.threadId),itemId:'initial',availableDecisions});
 else ctx.f.request('initial-fail','item/tool/call',{threadId:session.threadId,turnId:ctx.f.turns.get(session.threadId),callId:'initial',namespace:'application',tool:'lookup',arguments:{}});
 await settle();assert.equal((await ctx.execution.close()).transport.reason,'handler-error');assert.equal(ctx.bridge.pending().length,0);assert.equal(ctx.bridge.hostCalls().length,0);assert.equal(ctx.f.replies.some(frame=>Object.hasOwn(frame,'result')),false);
});

for(const kind of ['missing','throwing'])test(`a ${kind} catch on a valid writer promise cannot erase entry`,async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const write=ctx.f.channel.write;let replies=0;
 ctx.f.channel.write=bytes=>{const value=write(bytes);if(Object.hasOwn(JSON.parse(Buffer.from(bytes)),'result')){const promise=Promise.resolve();Object.defineProperty(promise,'catch',kind==='missing'?{value:undefined}:{get(){throw new Error('not part of PromiseLike');}});return promise;}return value;};
 const prepared=ctx.bridge.prepareBatch([choose(pending,'decline')]);assert.equal(prepared.kind,'ok');prepared.value.commit(access.signal,()=>{replies++;},ctx.execution.flushIntake);assert.equal((await prepared.value.entry).kind,'ok');assert.equal((await prepared.value.written).kind,'ok');await settle();assert.equal(replies,1);assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);ctx.f.complete(session.threadId);
});

test('throwing second batch intake hook refuses every staged positive reply',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const first=await approval(ctx,session,'first');const second=await approval(ctx,session,'second');const prepared=ctx.bridge.prepareBatch([choose(first,'decline'),choose(second,'decline')]);assert.equal(prepared.kind,'ok');let calls=0;let result;
 assert.doesNotThrow(()=>{result=prepared.value.commit(access.signal,()=>{},()=>{ctx.execution.flushIntake();if(++calls===2)throw new Error('intake hook failed');});});assert.equal(result.kind,'error');const outcomes=[];prepared.value.entry.then(x=>outcomes.push(x));prepared.value.written.then(x=>outcomes.push(x));await settle();assert.equal(outcomes.length,2);assert.ok(outcomes.every(x=>x.kind==='error'));assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,0);assert.equal((await ctx.execution.close()).transport.reason,'handler-error');assert.equal(ctx.bridge.pending().length,0);
});

test('caller abort after durable intent cannot retract a queued single reply',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const release=await holdReplyWriter(ctx);const control=new AbortController();let records=0;
 const result=ctx.bridge.reply({value:choose(pending,'decline'),signal:control.signal,recordIntent(){records++;}});await settle();assert.equal(records,1);control.abort();release();assert.equal((await result).kind,'ok');await settle();assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,1);assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'error')).length,0);ctx.f.complete(session.threadId);
});

test('caller abort after batch entry cannot retract remaining recorded decisions',async t=>{
 const ctx=await setup(t);const session=ctx.sessions[0];await turnOn(session);const first=await approval(ctx,session,'first');const second=await approval(ctx,session,'second');
 const original=ctx.f.channel.write.bind(ctx.f.channel);const held=Promise.withResolvers();ctx.f.channel.write=bytes=>{const frame=JSON.parse(Buffer.from(bytes));const writing=original(bytes);return frame.id==='first'&&frame.result?held.promise:writing;};
 const control=new AbortController();const prepared=ctx.bridge.prepareBatch([choose(first,'decline'),choose(second,'decline')]);assert.equal(prepared.kind,'ok');prepared.value.commit(control.signal,()=>{},ctx.execution.flushIntake);assert.equal((await prepared.value.entry).kind,'ok');control.abort();held.resolve();assert.equal((await prepared.value.written).kind,'ok');await settle();assert.equal(ctx.f.replies.filter(frame=>Object.hasOwn(frame,'result')).length,2);ctx.f.complete(session.threadId);
});
test('approval expiry includes the wait for turn acknowledgement',async t=>{
 const ctx=await setup(t);const matched=Promise.withResolvers();const made=createCodexInteraction({...options,expiry:{afterMs:20}});assert.equal(made.kind,'ok');const bridge=made.value;const session=ctx.sessions[0];assert.equal(bridge.attach({...session,matchesTurn:()=>matched.promise}).kind,'ok');const response=await bridge.onServerRequest({id:'early',method:'item/commandExecution/requestApproval',params:{threadId:session.threadId,turnId:'early-turn',itemId:'early-item',availableDecisions}},access.signal,{watchNotification(){return()=>{};},replyAllowed(){},fault(){}});assert.equal(response.kind,'error');assert.equal(response.error.code,-32000);assert.equal(bridge.pending().length,0);matched.resolve(true);
});
test('a recorded queued reply is no longer an unanswered approval',async t=>{
 const ctx=await setup(t,{expiry:{afterMs:20}});const session=ctx.sessions[0];await turnOn(session);const pending=await approval(ctx,session);const release=await holdReplyWriter(ctx);const answering=ctx.bridge.reply({value:choose(pending,'decline'),signal:access.signal,recordIntent(){}});await new Promise(resolve=>setTimeout(resolve,40));release();assert.equal((await answering).kind,'ok');await settle();assert.equal(ctx.f.replies.filter(f=>f.result?.decision==='decline').length,1);ctx.f.complete(session.threadId);
});

test('withdrawal releases pre-ack admission before identification arrives',async t=>{
 const ctx=await setup(t);const matched=Promise.withResolvers();const made=createCodexInteraction(options);assert.equal(made.kind,'ok');const session=ctx.sessions[0];const bridge=made.value;bridge.attach({...session,matchesTurn:()=>matched.promise});let watch;const result=bridge.onServerRequest({id:'early-withdrawn',method:'item/commandExecution/requestApproval',params:{threadId:session.threadId,turnId:'early-turn',itemId:'item',availableDecisions}},access.signal,{watchNotification(fn){watch=fn;return()=>{};},replyAllowed(){},fault(){}});watch({method:'serverRequest/resolved',params:{threadId:session.threadId,requestId:'early-withdrawn'}});const value=await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('blocked'),50))]);assert.notEqual(value,'blocked');assert.equal(value.kind,'error');assert.equal(bridge.pending().length,0);matched.resolve(true);
});
test('synchronous batch reservation clears an already armed expiry timer',async t=>{
 const ctx=await setup(t,{expiry:{afterMs:20}});const session=ctx.sessions[0];await turnOn(session);const release=await holdReplyWriter(ctx);let prepared;ctx.bridge.project(event=>{if(event.kind==='pending'){prepared=ctx.bridge.prepareBatch([choose(event.pending,'decline')]);assert.equal(prepared.kind,'ok');prepared.value.commit(access.signal,()=>{},ctx.execution.flushIntake);}});await approval(ctx,session);await new Promise(resolve=>setTimeout(resolve,40));release();assert.equal((await prepared.value.written).kind,'ok');ctx.f.complete(session.threadId);
});


test('preack admission rechecks live turn after its acknowledgement snapshot',async t=>{
 const ctx=await setup(t);const identified=Promise.withResolvers();let reads=0;const control=new AbortController();const made=createCodexInteraction(options);const bridge=made.value;const session=ctx.sessions[0];bridge.attach({...session,matchesTurn:()=>++reads===1?identified.promise:false});const held=bridge.onServerRequest({id:'interrupted-before-offer',method:'item/commandExecution/requestApproval',params:{threadId:session.threadId,turnId:'held',itemId:'item',availableDecisions}},control.signal,{watchNotification(){return()=>{};},replyAllowed(){},fault(){}});try{identified.resolve(true);await settle();assert.equal(bridge.pending().length,0);}finally{control.abort();await held;}
});
test('approval expiry keeps one elapsed deadline across a wall-clock reversal',async t=>{
 const ctx=await setup(t);const identified=Promise.withResolvers();let reads=0;const control=new AbortController();const bridge=createCodexInteraction({...options,expiry:{afterMs:20}}).value;const session=ctx.sessions[0];bridge.attach({...session,matchesTurn:()=>++reads===1?identified.promise:true});let wall=100000;t.mock.method(Date,'now',()=>wall);const held=bridge.onServerRequest({id:'clock-reversal',method:'item/commandExecution/requestApproval',params:{threadId:session.threadId,turnId:'held',itemId:'item',availableDecisions}},control.signal,{watchNotification(){return()=>{};},replyAllowed(){},fault(){}});try{wall=0;identified.resolve(true);const result=await Promise.race([held,new Promise(resolve=>setTimeout(()=>resolve('blocked'),100))]);assert.notEqual(result,'blocked');assert.equal(result.kind,'error');}finally{control.abort();await held;}
});


test('prepared turn refuses an older request without awaiting intent', async t => {
  const ctx = await setup(t, { handlerTimeoutMs: 1000 }); const session = ctx.sessions[0];
  const first = await turnOn(session); const old = ctx.f.turns.get(session.threadId); ctx.f.complete(session.threadId); await first.completion;
  const hold = Promise.withResolvers(); let intent = false;
  const next = session.turn({ hostOperationId: 'held-intent', input, signal: access.signal, recordIntent() { intent = true; return hold.promise; } });
  const running = next.value.run(); while (!intent) await Promise.resolve();
  try {
    ctx.f.request('late-older', 'item/commandExecution/requestApproval', { threadId: session.threadId, turnId: old, itemId: 'older', availableDecisions });
    await settle(); assert.equal(ctx.f.replies.some(frame => frame.id === 'late-older' && frame.error), true);
  } finally { hold.resolve(); await running; ctx.f.complete(session.threadId); await next.value.completion; }
});
test('elapsed approval cannot publish when acknowledgement beats its overdue timer', async t => {
  const ctx = await setup(t); const session = ctx.sessions[0]; const identified = Promise.withResolvers(); let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const bridge = createCodexInteraction({ ...options, expiry: { afterMs: 20 } }).value;
  bridge.attach({ ...session, matchesTurn: () => identified.promise }); const published = [];
  bridge.project(event => { if (event.kind === 'pending') published.push(event); });
  const response = bridge.onServerRequest({ id: 'late-ack', method: 'item/commandExecution/requestApproval', params: { threadId: session.threadId, turnId: 'held', itemId: 'item', availableDecisions } }, access.signal, { watchNotification() { return () => {}; }, replyAllowed() {}, fault() {} });
  clock = 30; identified.resolve(true); const reply = await response;
  assert.equal(reply.kind, 'error'); assert.equal(published.length, 0);
});
test('elapsed approval cannot be reserved before its overdue timer runs', async t => {
  const ctx = await setup(t, { expiry: { afterMs: 20 } }); const session = ctx.sessions[0]; await turnOn(session);
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const pending = await approval(ctx, session); clock = 30;
  const prepared = ctx.bridge.prepareBatch([choose(pending, 'accept')]);
  assert.equal(prepared.kind, 'ok');
  const committed = prepared.value.commit(access.signal, () => assert.fail('expired reply entered'), ctx.execution.flushIntake);
  assert.equal(committed.kind, 'error'); assert.equal(committed.error.code, 'stale-interaction');
  ctx.f.complete(session.threadId);
});
