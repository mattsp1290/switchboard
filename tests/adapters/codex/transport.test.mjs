import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { registerHooks } from 'node:module';
import test from 'node:test';

const source = new URL('../../../src/adapters/codex/transport.ts', import.meta.url).href;
const imports = new Map([['./wire.js', new URL('../../../src/adapters/codex/wire.ts', import.meta.url).href],
  ['../../core/events.js', new URL('../../../src/core/events.ts', import.meta.url).href]]);
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === source && imports.has(specifier)) return { url: imports.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
const { openCodexTransport } = await import(source);
hook.deregister();
const bounds = { maxFrameBytes: 512, maxChunkBytes: 2048, maxDiagnosticBytes: 7, maxPending: 4,
  maxHandlers: 4, maxWrites: 4, observationCapacity: 4,
  handlerTimeoutMs: 60000, observationTimeoutMs: 60000, writeTimeoutMs: 60000 };
const signal = () => new AbortController().signal;
const line = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const checkpoint = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => Promise.withResolvers();
function track(promise) {
  const values = [];
  promise.then((value) => values.push(value));
  return values;
}
function fixture(t, options = {}) {
  const f = { writes: [], requests: [], observations: [], reports: [], witnesses: [], detaches: 0,
    activeWrites: 0, maxActiveWrites: 0, depth: 0, listens: 0 };
  f.mark = (name) => { f.witnesses.push(name); t.diagnostic(name); };
  f.bytes = (bytes) => {
    f.depth++;
    try { f.sink.data(bytes); } finally { f.depth--; }
  };
  f.input = (value) => f.bytes(line(value));
  const channel = {
    listen(sink) {
      f.listens++;
      f.sink = sink;
      options.listen?.(f);
      return () => { f.detaches++; options.detach?.(f); };
    },
    write(bytes, deliverySignal) {
      f.writes.push(JSON.parse(Buffer.from(bytes).toString()));
      f.activeWrites++;
      f.maxActiveWrites = Math.max(f.maxActiveWrites, f.activeWrites);
      f.mark('writer-entered');
      try {
        return Promise.resolve(options.write?.(f, deliverySignal)).finally(() => { f.activeWrites--; });
      } catch (error) { f.activeWrites--; throw error; }
    },
  };
  f.transport = openCodexTransport({ channel, bounds: { ...bounds, ...options.bounds },
    onRequest(request, deliverySignal) {
      assert.equal(f.depth, 0, 'handler-outside-reader');
      f.requests.push(request);
      return options.request ? options.request(request, deliverySignal, f) : { kind: 'result', value: null };
    },
    onObservation(observation, deliverySignal) {
      assert.equal(f.depth, 0, 'observer-outside-reader');
      f.observations.push(observation);
      return options.observation?.(observation, deliverySignal, f);
    },
  });
  f.transport.ended.then((report) => f.reports.push(report));
  t.after(() => f.transport.close());
  return f;
}

test('approval-reader-progress', async (t) => {
  const held = gate();
  const f = fixture(t, { request: (_, __, current) => { current.mark('approval-entered'); return held.promise; } });
  f.input({ id: 'approval', method: 'future/approval', params: { drift: 1 }, extra: true });
  const result = track(f.transport.request({ method: 'independent' }, signal()));
  await checkpoint();
  assert.ok(f.witnesses.includes('approval-entered'));
  f.input({ method: 'future/notice', params: [1], extra: 2 });
  f.input({ id: f.writes[0].id, result: null, extra: 3 });
  f.mark('approval-input-delivered');
  await checkpoint();
  assert.deepEqual([result[0]?.envelope.raw.extra, f.observations[0]?.raw.extra, f.reports.length], [3, 2, 0], 'approval-reader-progress');
  held.resolve({ kind: 'error', error: { code: -32601, message: 'Unsupported method', data: null } });
  await checkpoint();
  assert.deepEqual(f.requests[0].raw, { id: 'approval', method: 'future/approval', params: { drift: 1 }, extra: true });
  assert.equal(f.writes.filter((value) => value.id === 'approval' && value.error?.code === -32601).length, 1, 'approval-reader-progress');
});

for (const [name, bytes, reason, witness] of [
  ['malformed-envelope-terminal', line({ id: 1, result: null, error: { code: 1, message: 'x' } }), 'invalid-envelope', 'invalid-frame-delivered'],
  ['partial-byte-limit-terminal', Buffer.alloc(513, 32), 'oversized-frame', 'oversize-delivered'],
  ['invalid-json', Buffer.from('{\n'), 'malformed-frame', 'invalid-json-delivered'],
  ['invalid-utf8', Buffer.from([0xff, 10]), 'malformed-frame', 'invalid-utf8-delivered'],
  ['chunk-limit', Buffer.alloc(2049), 'input-overflow', 'large-chunk-delivered'],
]) test(name, async (t) => {
  const f = fixture(t);
  f.bytes(bytes);
  f.mark(witness);
  await checkpoint();
  assert.deepEqual([f.reports[0]?.reason, f.requests.length, f.observations.length], [reason, 0, 0], name);
});

test('fragmented UTF-8, exact frame bytes, CRLF and truncated EOF use the shared reader', async (t) => {
  const bytes = Buffer.from(`${JSON.stringify({ method: '雪🙂' })}\r\n`);
  const f = fixture(t, { bounds: { maxFrameBytes: bytes.length - 1 } });
  for (const byte of bytes) f.bytes(Buffer.from([byte]));
  await checkpoint();
  assert.equal(f.observations[0].method, '雪🙂');
  assert.equal(f.reports.length, 0);
  f.bytes(Buffer.from('{'));
  f.sink.ended('eof');
  await checkpoint();
  assert.equal(f.reports[0].reason, 'malformed-frame');
});

test('caller-overflow-not-sent', async (t) => {
  const held = gate();
  const f = fixture(t, { bounds: { maxWrites: 2 }, write: () => held.promise });
  f.transport.request({ method: 'first' }, signal());
  await checkpoint();
  f.transport.notify({ method: 'second' }, signal());
  f.mark('write-capacity-filled');
  let serialized = 0;
  const params = { toJSON() { serialized++; return null; } };
  const request = track(f.transport.request({ method: 'excess-request', params }, signal()));
  const notify = track(f.transport.notify({ method: 'excess-notify', params }, signal()));
  await checkpoint();
  assert.deepEqual([request[0], notify[0], f.writes.length, f.reports.length, serialized],
    [{ kind: 'not-sent', reason: 'capacity' }, { kind: 'not-sent', reason: 'capacity' }, 1, 0, 0], 'caller-overflow-not-sent');
  held.resolve();
});

test('observation-overflow-terminal', async (t) => {
  const held = gate();
  const f = fixture(t, { bounds: { observationCapacity: 2 }, observation: (_, __, current) => {
    current.mark('observer-entered');
    return held.promise;
  } });
  f.input({ method: 'first' });
  await checkpoint();
  assert.ok(f.witnesses.includes('observer-entered'));
  f.input({ method: 'queued' });
  f.input({ method: 'overflow' });
  f.mark('observation-overflow-delivered');
  await checkpoint();
  assert.deepEqual([f.reports[0]?.reason, f.reports[0]?.unsettled.observer, f.observations.length],
    ['observation-overflow', true, 1], 'observation-overflow-terminal');
  assert.deepEqual(f.reports[0].discarded, { observations: 2, requests: 0 });
  held.resolve();
  await checkpoint();
  assert.deepEqual(f.reports[0].discarded, { observations: 2, requests: 0 });
  assert.ok(Object.isFrozen(f.reports[0].discarded));
  const scheduled = fixture(t, { bounds: { observationCapacity: 2 } });
  scheduled.bytes(Buffer.concat(['first', 'queued', 'overflow'].map((method) => line({ method }))));
  await checkpoint();
  assert.deepEqual(scheduled.reports[0].discarded, { observations: 3, requests: 0 });
  assert.equal(scheduled.observations.length, 0);
});

for (const send of ['request', 'notify']) for (const entered of [false, true])
test(`${send} ${entered ? 'cancel-entered-uncertain' : 'cancel-queued-not-sent'}`, async (t) => {
  const held = gate();
  const f = fixture(t, { write: () => held.promise });
  if (!entered) f.transport.notify({ method: 'blocker' }, signal());
  const controller = new AbortController();
  const result = track(f.transport[send]({ method: 'target' }, controller.signal));
  await checkpoint();
  if (entered) {
    assert.equal(f.writes[0].method, 'target');
    f.mark('target-write-entered');
  }
  controller.abort();
  f.mark('abort-delivered');
  f.transport.notify({ method: 'following' }, signal());
  await checkpoint();
  const name = entered ? 'cancel-entered-uncertain' : 'cancel-queued-not-sent';
  assert.deepEqual([result[0], f.writes.length, f.maxActiveWrites],
    [{ kind: entered ? 'uncertain' : 'not-sent', reason: 'aborted' }, 1, 1], name);
  held.resolve();
  await checkpoint();
  assert.equal(f.writes.filter((value) => value.method === 'target').length, Number(entered), name);
  assert.deepEqual(result, [{ kind: entered ? 'uncertain' : 'not-sent', reason: 'aborted' }], name);
});

test('late-response-keeps-correlation', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  f.transport.request({ method: 'A' }, controller.signal);
  await checkpoint();
  const a = f.writes[0].id;
  f.mark('A-write-entered');
  controller.abort();
  const bResult = track(f.transport.request({ method: 'B' }, signal()));
  await checkpoint();
  const b = f.writes[1].id;
  f.mark('B-write-entered');
  f.input({ id: a, result: 'old' });
  f.mark('late-frame-delivered');
  await checkpoint();
  assert.deepEqual([f.observations[0]?.kind, f.observations[0]?.envelope.id, bResult.length, a !== b],
    ['unmatched-reply', a, 0, true], 'late-response-keeps-correlation');
  f.input({ id: b, result: 'own' });
  await checkpoint();
  assert.equal(bResult[0]?.envelope.reply.value, 'own', 'late-response-keeps-correlation');
});

for (const reason of ['eof', 'transport-error', 'process-exit']) test(`termination-settles-once ${reason}`, async (t) => {
  const held = gate();
  const f = fixture(t, { request: (_, __, current) => { current.mark('termination-handler-entered'); return held.promise; } });
  const first = track(f.transport.request({ method: 'first' }, signal()));
  const second = track(f.transport.request({ method: 'second' }, signal()));
  f.input({ id: 1, method: 'held' });
  await checkpoint();
  assert.equal(f.writes.length, 2);
  assert.ok(f.witnesses.includes('termination-handler-entered'));
  f.sink.ended(reason);
  f.mark('termination-delivered');
  f.sink.ended('transport-error');
  await checkpoint();
  assert.deepEqual([first, second, f.reports.map((report) => report.reason), f.writes.length],
    [[{ kind: 'uncertain', reason: 'closed' }], [{ kind: 'uncertain', reason: 'closed' }], [reason], 2], 'termination-settles-once');
  assert.equal(f.transport.close(), f.transport.ended, 'termination-settles-once');
  held.resolve({ kind: 'result', value: null });
});

test('cleanup-keeps-borrowed-ownership', async (t) => {
  const handler = gate();
  const writer = gate();
  const f = fixture(t, { write: () => writer.promise, request: (request, deliverySignal, current) => {
    if (request.id === 'queued-reply') return { kind: 'result', value: null };
    current.mark('cleanup-handler-entered');
    deliverySignal.addEventListener('abort', () => current.input({ method: 'abort-reentry' }));
    return handler.promise;
  } });
  const result = track(f.transport.request({ method: 'active' }, signal()));
  f.transport.notify({ method: 'queued' }, signal());
  f.input({ id: 1, method: 'held' });
  f.input({ id: 'queued-reply', method: 'completed' });
  await checkpoint();
  assert.ok(f.witnesses.includes('cleanup-handler-entered'));
  const close = f.transport.close();
  assert.equal(f.transport.close(), close, 'cleanup-keeps-borrowed-ownership');
  await checkpoint();
  f.mark('close-complete');
  const snapshot = f.reports[0];
  assert.deepEqual([result[0], snapshot?.unsettled, f.detaches],
    [{ kind: 'uncertain', reason: 'closed' }, { handlers: 1, observer: false, write: true }, 1], 'cleanup-keeps-borrowed-ownership');
  writer.resolve();
  handler.resolve({ kind: 'result', value: true });
  f.input({ id: 2, method: 'late' });
  await checkpoint();
  assert.deepEqual([f.writes.length, f.requests.length, f.maxActiveWrites, f.detaches, f.reports[0] === snapshot],
    [1, 2, 1, 1, true], 'cleanup-keeps-borrowed-ownership');
  assert.deepEqual(snapshot.unsettled, { handlers: 1, observer: false, write: true }, 'cleanup-keeps-borrowed-ownership');
});

test('sync-loopback-keeps-reader-open', async (t) => {
  const f = fixture(t, { write: (current) => {
    const written = current.writes.at(-1);
    if (written.id === 'S1') {
      current.input({ method: 'loopback-notice' });
      current.input({ id: 'S2', method: 'second' });
    } else if (written.method === 'caller') current.input({ id: written.id, result: 'caller-result' });
  } });
  f.input({ id: 'S1', method: 'first' });
  const result = track(f.transport.request({ method: 'caller' }, signal()));
  await checkpoint();
  assert.deepEqual([f.requests.map((request) => request.id), f.observations.map((value) => value.method),
    f.writes.filter((value) => !value.method).map((value) => value.id), result[0]?.envelope.reply.value,
    f.reports.length, f.maxActiveWrites], [['S1', 'S2'], ['loopback-notice'], ['S1', 'S2'], 'caller-result', 0, 1], 'sync-loopback-keeps-reader-open');
  const report = await f.transport.close();
  assert.deepEqual([report.reason, f.detaches, f.writes.length], ['caller-close', 1, 3], 'sync-loopback-keeps-reader-open');
});

test('queued replies are unmatched, reverse replies correlate, and duplicate replies retain raw drift', async (t) => {
  const held = gate();
  const f = fixture(t, { write: (current) => current.writes.length === 1 ? held.promise : undefined });
  const first = track(f.transport.request({ method: 'first' }, signal()));
  const second = track(f.transport.request({ method: 'second' }, signal()));
  await checkpoint();
  const firstId = f.writes[0].id;
  const secondId = firstId.replace(/:1$/, ':2');
  f.input({ id: secondId, result: 'premature' });
  await checkpoint();
  assert.deepEqual([second.length, f.observations[0]?.kind], [0, 'unmatched-reply']);
  held.resolve();
  await checkpoint();
  assert.equal(f.writes[1].id, secondId);
  const error = { id: secondId, error: { code: -1, message: 'native', data: null, future: true }, extra: 7 };
  f.input(error);
  f.input({ id: firstId, result: 'first' });
  f.input(error);
  await checkpoint();
  assert.deepEqual(second[0].envelope.raw, error);
  assert.equal(first[0].envelope.reply.value, 'first');
  assert.deepEqual(f.observations[1].envelope.raw, error);
});

test('numeric and string server IDs remain distinct, including zero and null result', async (t) => {
  const f = fixture(t);
  f.input({ id: 0, method: 'numeric' });
  f.input({ id: '0', method: 'string' });
  await checkpoint();
  assert.deepEqual(f.writes, [{ id: 0, result: null }, { id: '0', result: null }]);
  assert.equal(f.reports.length, 0);
});

for (const stage of ['callback', 'queued-reply', 'active-reply']) test(`duplicate server ID during ${stage}`, async (t) => {
  const held = gate();
  const f = fixture(t, {
    request: () => stage === 'callback' ? held.promise : { kind: 'result', value: null },
    write: () => stage === 'callback' ? undefined : held.promise,
  });
  if (stage === 'queued-reply') f.transport.notify({ method: 'blocker' }, signal());
  f.input({ id: 3, method: 'server' });
  await checkpoint();
  assert.equal(f.requests.length, 1);
  assert.equal(f.writes.length, stage === 'callback' ? 0 : 1);
  f.input({ id: 3, method: 'duplicate' });
  await checkpoint();
  assert.equal(f.reports[0]?.reason, 'duplicate-request');
  assert.equal(f.requests.length, 1);
  held.resolve({ kind: 'result', value: null });
});

test('required replies retain output capacity under caller saturation', async (t) => {
  const held = gate();
  const f = fixture(t, { bounds: { maxWrites: 1 }, write: (current) => current.writes.length === 1 ? held.promise : undefined });
  f.transport.notify({ method: 'blocker' }, signal());
  await checkpoint();
  f.input({ id: 4, method: 'server' });
  await checkpoint();
  assert.deepEqual(await f.transport.notify({ method: 'excess' }, signal()), { kind: 'not-sent', reason: 'capacity' });
  assert.deepEqual([f.reports.length, f.requests.length, f.writes.length], [0, 1, 1]);
  held.resolve();
  await checkpoint();
  assert.deepEqual(f.writes.map((value) => value.id ?? value.method), ['blocker', 4]);
});

test('approvals and correlated replies progress while earlier observations await delivery', async (t) => {
  const held = gate();
  const f = fixture(t, { observation: () => held.promise });
  const result = track(f.transport.request({ method: 'caller' }, signal()));
  await checkpoint();
  f.bytes(Buffer.concat([line({ method: 'first' }), line({ method: 'queued' }),
    line({ id: 'approval', method: 'approval' }), line({ id: f.writes[0].id, result: null })]));
  await checkpoint();
  assert.deepEqual([f.requests.length, result[0]?.kind, f.observations.map((value) => value.method)], [1, 'reply', ['first']]);
  assert.deepEqual(f.writes[1], { id: 'approval', result: null });
  held.resolve();
  await checkpoint();
  assert.deepEqual(f.observations.map((value) => value.method), ['first', 'queued']);
});

for (const stage of ['scheduled', 'callback', 'active-reply']) test(`handler capacity retains ${stage} lease`, async (t) => {
  const held = gate();
  const f = fixture(t, { bounds: { maxHandlers: 1 },
    request: () => stage === 'active-reply' ? { kind: 'result', value: null } : held.promise,
    write: () => held.promise,
  });
  f.input({ id: 1, method: 'first' });
  if (stage !== 'scheduled') await checkpoint();
  f.input({ id: 2, method: 'excess' });
  await checkpoint();
  assert.equal(f.reports[0]?.reason, 'handler-overflow');
  assert.equal(f.requests.length, stage === 'scheduled' ? 0 : 1);
  assert.deepEqual(f.reports[0].discarded, { observations: 0, requests: Number(stage === 'scheduled') });
  held.resolve({ kind: 'result', value: null });
});

for (const failure of ['throw', 'reject']) test(`handler ${failure} closes without a reply or unsettled failed callback`, async (t) => {
  const f = fixture(t, { request: () => {
    if (failure === 'throw') throw new Error('private detail');
    return Promise.reject(new Error('private detail'));
  } });
  f.input({ id: 'bad', method: 'approval' });
  await checkpoint();
  assert.deepEqual([f.writes, f.reports[0]?.reason, f.reports[0]?.unsettled],
    [[], 'handler-error', { handlers: 0, observer: false, write: false }]);
  assert.equal(JSON.stringify(f.reports).includes('private detail'), false);
  const snapshot = f.reports[0];
  f.sink.ended('process-exit');
  assert.equal(await f.transport.close(), snapshot);
  assert.equal(f.reports.length, 1);
});

for (const reply of [null, { kind: 'result', value: undefined }, { kind: 'result', value: 'x'.repeat(600) },
  { kind: 'error', error: { code: 'wrong', message: 'x' } }]) test('invalid handler reply closes without writing', async (t) => {
  const f = fixture(t, { request: () => reply });
  f.input({ id: 1, method: 'bad-reply' });
  await checkpoint();
  assert.deepEqual([f.reports[0]?.reason, f.reports[0]?.unsettled.handlers, f.writes.length], ['invalid-handler-reply', 0, 0]);
});

for (const operation of ['handler', 'observer', 'write']) test(`${operation} deadline retains the actual unsettled operation`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = gate();
  let seen;
  const f = fixture(t, { bounds: { [`${operation === 'observer' ? 'observation' : operation}TimeoutMs`]: 10 },
    request: (_, deliverySignal, current) => { seen = deliverySignal; current.mark('handler-entered'); return held.promise; },
    observation: (_, deliverySignal, current) => { seen = deliverySignal; current.mark('observer-entered'); return held.promise; },
    write: (_, deliverySignal) => { seen = deliverySignal; return held.promise; },
  });
  if (operation === 'handler') f.input({ id: 1, method: 'held' });
  if (operation === 'observer') f.input({ method: 'held' });
  if (operation === 'write') f.transport.notify({ method: 'held' }, signal());
  await checkpoint();
  assert.ok(f.witnesses.includes(operation === 'write' ? 'writer-entered' : `${operation}-entered`));
  assert.equal(seen.aborted, false);
  t.mock.timers.tick(10);
  await checkpoint();
  const snapshot = f.reports[0];
  assert.equal(seen.aborted, true, `${operation}-signal-aborted`);
  assert.equal(snapshot?.reason, `${operation === 'observer' ? 'observation' : operation}-timeout`);
  assert.deepEqual(snapshot.unsettled, { handlers: Number(operation === 'handler'), observer: operation === 'observer', write: operation === 'write' });
  held.reject(new Error('late private rejection'));
  await checkpoint();
  assert.equal(f.reports.length, 1);
  assert.equal(f.writes.length, Number(operation === 'write'));
  assert.deepEqual(snapshot.unsettled, { handlers: Number(operation === 'handler'), observer: operation === 'observer', write: operation === 'write' });
});

for (const operation of ['observer', 'write']) for (const failure of ['throw', 'reject']) {
  test(`${operation} ${failure} has a fixed terminal reason and no unsettled failed operation`, async (t) => {
    const fail = () => {
      if (failure === 'throw') throw new Error('private');
      return Promise.reject(new Error('private'));
    };
    const f = fixture(t, { observation: fail, write: fail });
    let result;
    if (operation === 'observer') f.input({ method: 'bad' });
    else result = track(f.transport.notify({ method: 'bad' }, signal()));
    await checkpoint();
    assert.equal(f.reports[0]?.reason, operation === 'observer' ? 'observation-error' : 'write-error');
    assert.deepEqual(f.reports[0].unsettled, { handlers: 0, observer: false, write: false });
    if (result) assert.deepEqual(result, [{ kind: 'uncertain', reason: 'closed' }]);
  });
}

test('listen-time delivery and EOF detach the acquired registration once', async (t) => {
  const f = fixture(t, { listen: (current) => {
    current.input({ method: 'notice' });
    current.sink.ended('eof');
  } });
  await checkpoint();
  assert.deepEqual([f.reports[0]?.reason, f.detaches, f.observations.length], ['eof', 1, 0]);
  assert.deepEqual(f.reports[0].discarded, { observations: 1, requests: 0 });
  assert.equal(f.transport.close(), f.transport.ended);
  const data = fixture(t, { listen: (current) => current.input({ id: 1, method: 'server' }) });
  await checkpoint();
  assert.equal(data.writes.length, 1);
});

test('listen failure and reentrant throwing detach preserve the first report', async (t) => {
  const failed = fixture(t, { listen: () => { throw new Error('private'); } });
  await checkpoint();
  assert.deepEqual([failed.reports[0]?.reason, failed.detaches, failed.reports[0]?.detachFailed], ['listen-error', 0, false]);
  const f = fixture(t, { detach: (current) => {
    current.transport.close();
    current.sink.ended('process-exit');
    current.input({ method: 'late' });
    throw new Error('private');
  } });
  const report = await f.transport.close();
  assert.deepEqual([report.reason, report.detachFailed, f.detaches], ['caller-close', true, 1]);
  assert.equal(await f.transport.close(), report);
  const early = fixture(t, { listen: (current) => { current.sink.ended('eof'); throw new Error('private'); } });
  await checkpoint();
  assert.equal(early.reports[0]?.reason, 'eof');
});

test('diagnostic tail remains bounded while client replies progress', async (t) => {
  const f = fixture(t);
  const result = track(f.transport.request({ method: 'read' }, signal()));
  await checkpoint();
  f.sink.diagnostic(Buffer.from('old'));
  f.sink.diagnostic(Buffer.alloc(100, 97));
  f.sink.diagnostic(Buffer.from('finish'));
  f.input({ id: f.writes[0].id, result: true });
  await checkpoint();
  assert.equal(result[0]?.envelope.reply.value, true);
  const report = await f.transport.close();
  assert.equal(Buffer.from(report.diagnostics).toString(), 'afinish');
  f.sink.diagnostic(Buffer.from('late'));
  assert.equal(Buffer.from(report.diagnostics).toString(), 'afinish');
});

test('every bound and product is validated before listener acquisition', () => {
  let acquired = 0;
  const channel = { listen: () => { acquired++; return () => {}; }, write: () => Promise.resolve() };
  const bad = Object.keys(bounds).flatMap((key) => [0, -1, 1.5, NaN, Infinity].map((value) => ({ [key]: value })));
  bad.push({ maxFrameBytes: constants.MAX_LENGTH }, { maxChunkBytes: constants.MAX_LENGTH + 1 },
    { maxDiagnosticBytes: constants.MAX_LENGTH + 1 }, { maxWrites: Number.MAX_SAFE_INTEGER },
    { observationCapacity: Number.MAX_SAFE_INTEGER }, ...['handlerTimeoutMs', 'observationTimeoutMs', 'writeTimeoutMs'].map((key) => ({ [key]: 2147483648 })));
  for (const invalid of bad) assert.throws(() => openCodexTransport({ channel, bounds: { ...bounds, ...invalid },
    onRequest: () => ({ kind: 'result', value: null }), onObservation: () => {} }), { name: 'RangeError', message: 'Invalid transport bounds' });
  assert.equal(acquired, 0);
});

test('pending capacity, invalid outgoing values, and already aborted callers never write', async (t) => {
  const f = fixture(t, { bounds: { maxPending: 1 } });
  const cyclic = {};
  cyclic.self = cyclic;
  for (const call of [{ method: '' }, { method: 'cycle', params: cyclic }, { method: 'large', params: 'x'.repeat(600) }]) {
    for (const send of [f.transport.request, f.transport.notify]) assert.deepEqual(await send(call, signal()), { kind: 'not-sent', reason: 'invalid-outgoing' });
  }
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await f.transport.request({ method: 'aborted' }, aborted.signal), { kind: 'not-sent', reason: 'aborted' });
  f.transport.request({ method: 'pending' }, signal());
  await checkpoint();
  assert.deepEqual(await f.transport.request({ method: 'excess' }, signal()), { kind: 'not-sent', reason: 'capacity' });
  assert.deepEqual(await f.transport.notify({ method: 'allowed' }, signal()), { kind: 'written' });
  assert.equal(f.writes.length, 2);
  await f.transport.close();
  assert.deepEqual(await f.transport.notify({ method: 'closed' }, signal()), { kind: 'not-sent', reason: 'closed' });
});

for (const send of ['request', 'notify']) for (const action of ['close', 'abort', 'capacity']) test(`${send} serialization rechecks ${action} before admission`, async (t) => {
  const f = fixture(t, { bounds: { maxWrites: 1 } });
  const controller = new AbortController();
  const params = { toJSON() {
    if (action === 'close') f.transport.close();
    if (action === 'abort') controller.abort();
    if (action === 'capacity') f.transport.notify({ method: 'nested' }, signal());
    return null;
  } };
  const result = track(f.transport[send]({ method: 'outer', params }, controller.signal));
  await checkpoint();
  assert.deepEqual(result[0], { kind: 'not-sent', reason: action === 'close' ? 'closed' : action === 'abort' ? 'aborted' : 'capacity' });
  assert.equal(f.writes.filter((value) => value.method === 'outer').length, 0);
});

test('inbound and per-request outbound bounds are independent', async (t) => {
  const f = fixture(t, { bounds: { maxInboundFrameBytes: 1024, maxOutboundFrameBytes: 1024 } });
  const call = { method: 'large', params: { data: 'x'.repeat(600) } };
  assert.deepEqual(await f.transport.request(call, signal()), { kind: 'not-sent', reason: 'invalid-outgoing' });
  const accepted = f.transport.request(call, signal(), { maxFrameBytes: 1024 });
  await checkpoint();
  f.input({ id: f.writes[0].id, result: 'x'.repeat(600) });
  assert.equal((await accepted).kind, 'reply');
  assert.deepEqual(await f.transport.request(call, signal(), { maxFrameBytes: 1025 }), { kind: 'not-sent', reason: 'invalid-outgoing' });
  f.bytes(Buffer.alloc(1025, 32));
  assert.equal((await f.transport.ended).reason, 'oversized-frame');
});

test('the direct paired-echo callback bound remains independent of line size', async (t) => {
  const config = { maxFrameBytes: 1048576, maxInboundFrameBytes: 8388608,
    maxOutboundFrameBytes: 8388608, maxChunkBytes: 16777215 };
  const f = fixture(t, { bounds: config });
  const echo = line({ method: 'item/started', params: { item: { type: 'userMessage', data: 'x'.repeat(5592408) } } });
  f.bytes(Buffer.concat([echo, echo]));
  await checkpoint();
  assert.equal(f.observations.length, 2);
  assert.equal(f.reports.length, 0);
  f.bytes(Buffer.alloc(16777216));
  assert.equal((await f.transport.ended).reason, 'input-overflow');
});
