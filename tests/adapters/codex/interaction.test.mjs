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
  assert.equal(await session.interrupt(), 'replied');
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
  assert.equal(await session.interrupt(), 'replied');
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

test('a request for a turn whose terminal was already observed is withdrawn at once', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const turn = await turnOn(session);
  const turnId = ctx.f.turns.get(session.threadId);
  ctx.f.complete(session.threadId);
  await turn.completion;
  await settle();
  ctx.f.request('late', 'item/commandExecution/requestApproval', { threadId: session.threadId, turnId, itemId: 'i', availableDecisions });
  await settle();
  assert.deepEqual(settledOf(ctx.events), [{ kind: 'withdrawn', by: 'turn/completed', evidence: 'unqualified' }]);
  assert.equal(ctx.f.replies[0].error.code, -32000);
});

test('a blind bridge observer is reported and its live approvals stay answerable', async (t) => {
  const ctx = await setup(t);
  const [session] = ctx.sessions;
  const threadId = randomUUID();
  // A session whose stream disconnected the bridge's observer on overflow.
  const overflowed = { ...session, threadId, events: { subscribe: () => ({ kind: 'ok', value: { dispose() {}, ended: Promise.resolve('overflow') } }) } };
  assert.equal(ctx.bridge.attach(overflowed).kind, 'ok');
  await settle();
  assert.deepEqual(ctx.events.filter((event) => event.kind === 'blind'), [{ kind: 'blind', threadId }]);
  ctx.f.request('blind-1', 'item/commandExecution/requestApproval', { threadId, turnId: 'turn-b', itemId: 'item-b', availableDecisions });
  await settle();
  const pending = ctx.events.findLast((event) => event.kind === 'pending').pending;
  assert.equal((await reply(ctx, choose(pending, 'decline'))).kind, 'ok');
  await settle();
  assert.deepEqual(ctx.f.replies, [{ id: 'blind-1', result: { decision: 'decline' } }]);
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
