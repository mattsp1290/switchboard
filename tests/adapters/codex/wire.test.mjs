import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import test from 'node:test';
import { createWireReader, encodeEnvelope } from '../../../src/adapters/codex/wire.ts';

const jsonLine = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
function capture(options = {}) {
  const envelopes = [];
  const faults = [];
  const reader = createWireReader({ maxFrameBytes: 256, maxChunkBytes: 1024,
    onEnvelope: (value) => envelopes.push(value), onFault: (value) => faults.push(value), ...options });
  return { reader, envelopes, faults };
}
test('wire preserves every raw envelope branch, unknown fields, ID zero and null result', () => {
  const values = [
    { id: 0, method: 'unknown', params: ['drift'], extension: true },
    { method: 'unknown', params: null, extension: { future: true } },
    { jsonrpc: '2.0', id: '0', result: null, extension: 3 },
    { id: 9, error: { code: -32000, message: '', data: { detail: true }, future: 4 }, extension: 5 },
  ];
  const { reader, envelopes, faults } = capture();
  reader.push(Buffer.concat(values.map(jsonLine)));
  reader.end();
  assert.deepEqual(faults, []);
  assert.deepEqual(envelopes.map((entry) => entry.kind), ['request', 'notification', 'reply', 'reply']);
  assert.deepEqual(envelopes.map((entry) => (entry.request ?? entry.notification ?? entry.envelope).raw), values);
  assert.equal(envelopes[0].request.id, 0);
  assert.deepEqual(envelopes[2].envelope.reply, { kind: 'result', value: null });
  assert.deepEqual(envelopes[3].envelope.reply.error, { code: -32000, message: '', data: { detail: true } });
});
test('wire rejects signed-zero IDs before delivery and closes after one fault', () => {
  for (const json of [
    '{"id":-0,"method":"server/request","params":{}}',
    '{"id":-0e0,"method":"server/request","params":{}}',
    '{"id":-0,"result":null}',
    '{"id":-0e0,"result":null}',
    '{"id":-0,"error":{"code":-32000,"message":"failed"}}',
    '{"id":-0e0,"error":{"code":-32000,"message":"failed"}}',
  ]) {
    const { reader, envelopes, faults } = capture();
    reader.push(Buffer.from(`${json}\n{"method":"late"}\n`));
    reader.push(jsonLine({ id: 1, method: 'later' }));
    reader.end();
    reader.end();
    assert.deepEqual(faults, ['invalid-envelope'], json);
    assert.deepEqual(envelopes, [], json);
  }
});
test('wire round trips zero, string zero and ordinary numeric IDs without changing raw fields', () => {
  for (const id of [0, '0', -7, 7, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    for (const value of [
      { id, method: 'server/request', params: { future: true }, extension: ['retained'] },
      { id, result: null, extension: ['retained'] },
      { id, error: { code: -32000, message: 'failed', future: true }, extension: ['retained'] },
    ]) {
      const bytes = encodeEnvelope(value, 256);
      assert.notEqual(bytes, undefined);
      const { reader, envelopes, faults } = capture();
      reader.push(bytes);
      reader.end();
      assert.deepEqual(faults, []);
      assert.equal(envelopes.length, 1);
      const envelope = envelopes[0].request ?? envelopes[0].envelope;
      assert.equal(envelope.id, id);
      assert.deepEqual(envelope.raw, value);
    }
  }
});
test('wire preserves signed zero outside routing IDs', () => {
  const { reader, envelopes, faults } = capture();
  reader.push(Buffer.from('{"id":0,"method":"x","params":{"value":-0},"extension":-0}\n'));
  reader.end();
  assert.deepEqual(faults, []);
  assert.equal(envelopes.length, 1);
  assert.deepEqual(envelopes[0].request.raw,
    { id: 0, method: 'x', params: { value: -0 }, extension: -0 });
});
test('wire refuses outgoing signed-zero IDs for requests and both reply shapes', () => {
  for (const value of [
    { id: -0, method: 'server/request', params: {} },
    { id: -0, result: null },
    { id: -0, error: { code: -32000, message: 'failed' } },
  ]) assert.equal(encodeEnvelope(value, 256), undefined);
});
test('wire rejects malformed envelope shapes and incompatible routing fields', () => {
  const invalid = [null, [], 1, '', true, {}, { params: {} }, { result: null },
    ...[null, '', false, {}, [], 0.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ({ id, result: null })),
    ...[null, '', 1, false, []].map((method) => ({ method })),
    { method: 'x', result: null }, { method: 'x', error: {} }, { method: 'x', id: 1, result: null },
    { id: 1 }, { id: 1, result: null, error: { code: 1, message: 'x' } },
    { id: 1, result: null, params: null }, { id: 1, result: null, method: null },
    ...[null, [], {}, { code: 1.5, message: 'x' }, { code: '1', message: 'x' },
      { code: 1 }, { code: 1, message: false }].map((error) => ({ id: 1, error })),
    ...[null, '1.0', 2].map((jsonrpc) => ({ jsonrpc, method: 'x' }))];
  for (const value of invalid) {
    const { reader, envelopes, faults } = capture();
    reader.push(jsonLine(value));
    reader.push(jsonLine({ method: 'late' }));
    reader.end();
    assert.deepEqual(faults, ['invalid-envelope'], JSON.stringify(value));
    assert.deepEqual(envelopes, []);
  }
  for (const json of ['{"id":1e400,"result":null}\n', '{"id":1,"error":{"code":1e400,"message":"x"}}\n']) {
    const { reader, faults } = capture();
    reader.push(Buffer.from(json));
    assert.deepEqual(faults, ['invalid-envelope']);
  }
});
test('wire handles split UTF-8, multiple records, CRLF and exact byte limits', () => {
  const value = { method: '雪🙂' };
  const bytes = Buffer.from(`${JSON.stringify(value)}\r\n`);
  for (let split = 0; split <= bytes.length; split++) {
    const { reader, envelopes, faults } = capture({ maxFrameBytes: bytes.length - 1, maxChunkBytes: bytes.length });
    reader.push(bytes.subarray(0, split));
    reader.push(bytes.subarray(split));
    reader.end();
    assert.deepEqual(faults, []);
    assert.deepEqual(envelopes[0].notification.raw, value);
  }
  const { reader, envelopes, faults } = capture({ maxFrameBytes: bytes.length - 2 });
  reader.push(bytes);
  assert.deepEqual(faults, ['oversized-frame'], 'CR counts toward the byte bound');
  assert.deepEqual(envelopes, []);
});
test('wire refuses chunks before framing and complete or fragmented oversized frames', () => {
  const line = jsonLine({ method: 'x' });
  const overflow = capture({ maxChunkBytes: line.length - 1 });
  overflow.reader.push(line);
  assert.deepEqual(overflow.faults, ['input-overflow']);
  assert.deepEqual(overflow.envelopes, []);
  for (const fragments of [[Buffer.from('12345\n')], [Buffer.from('1234'), Buffer.from('5')]]) {
    const { reader, envelopes, faults } = capture({ maxFrameBytes: 4 });
    for (const fragment of fragments) reader.push(fragment);
    reader.push(line);
    reader.end();
    assert.deepEqual(faults, ['oversized-frame']);
    assert.deepEqual(envelopes, []);
  }
});
test('wire rejects invalid UTF-8, empty records, invalid JSON and truncated EOF exactly once', () => {
  for (const bytes of [Buffer.from('\n'), Buffer.from('{bad\n'), Buffer.from([0xff, 10]),
    Buffer.from([0xc3, 10]), Buffer.from('\ufeff{"method":"x"}\n'), Buffer.from('{"method":"x"}'), Buffer.from([0xc3])]) {
    const { reader, envelopes, faults } = capture();
    reader.push(bytes);
    reader.end();
    reader.end();
    reader.close();
    reader.push(jsonLine({ method: 'late' }));
    assert.deepEqual(faults, ['malformed-frame']);
    assert.deepEqual(envelopes, []);
  }
});
test('wire refuses reentrant input and permits callback close or end', () => {
  for (const terminal of ['push', 'close', 'end']) {
    const seen = [];
    const { reader, faults } = capture({ onEnvelope: (entry) => {
      seen.push(entry.notification.method);
      reader[terminal](jsonLine({ method: 'reentrant' }));
    } });
    const push = () => reader.push(Buffer.concat([jsonLine({ method: 'first' }), jsonLine({ method: 'late' })]));
    if (terminal === 'push') assert.throws(push, /Reentrant wire push/);
    else push();
    reader.push(jsonLine({ method: 'later' }));
    assert.deepEqual(seen, ['first']);
    assert.deepEqual(faults, []);
  }
  const { reader, faults } = capture();
  reader.push(Buffer.from('{'));
  reader.close();
  reader.end();
  assert.deepEqual(faults, [], 'close discards a partial frame without manufacturing EOF');
});
test('wire leaves consumer exceptions unchanged and never labels them decoding faults', () => {
  const failure = new Error('consumer failure');
  let delivered = 0;
  const callback = capture({ onEnvelope: () => { delivered++; throw failure; } });
  assert.throws(() => callback.reader.push(Buffer.concat([jsonLine({ method: 'x' }), jsonLine({ method: 'y' })])),
    (error) => error === failure);
  callback.reader.push(jsonLine({ method: 'z' }));
  callback.reader.end();
  assert.equal(delivered, 1, 'consumer exception closes the reader');
  assert.deepEqual(callback.faults, []);
  const fault = capture({ onFault: () => { throw failure; } });
  assert.throws(() => fault.reader.push(Buffer.from('\n')), (error) => error === failure);
  assert.doesNotThrow(() => fault.reader.push(Buffer.from('\n')));
});
test('wire bounds fail before callbacks and are captured before input', () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, constants.MAX_LENGTH + 1]) {
    for (const key of ['maxFrameBytes', 'maxChunkBytes']) {
      assert.throws(() => capture({ [key]: value, onEnvelope: assert.fail, onFault: assert.fail }),
        { name: 'RangeError', message: 'Invalid wire byte bounds' });
    }
    assert.throws(() => encodeEnvelope({ method: 'x' }, value), RangeError);
  }
  assert.throws(() => capture({ maxFrameBytes: constants.MAX_LENGTH }), RangeError);
  assert.throws(() => encodeEnvelope({ method: 'x' }, constants.MAX_LENGTH), RangeError);
  const faults = [];
  const options = { maxFrameBytes: 1, maxChunkBytes: 2, onEnvelope: assert.fail, onFault: (fault) => faults.push(fault) };
  const reader = createWireReader(options);
  options.maxFrameBytes = 100;
  reader.push(Buffer.from('12'));
  assert.deepEqual(faults, ['oversized-frame']);
});
test('wire encoding preserves routing and checks the serialized envelope and byte limit', () => {
  for (const value of [{ method: '雪🙂' }, { method: 'x', id: 0, params: {} },
    { id: '1', result: null }, { id: 1, error: { code: 1, message: 'x' } }]) {
    const bytes = jsonLine(value);
    assert.deepEqual(encodeEnvelope(value, bytes.length - 1), bytes);
    assert.equal(encodeEnvelope(value, bytes.length - 2), undefined);
  }
  assert.deepEqual(encodeEnvelope({ method: 'x', toJSON: () => ({ method: 'x', params: { future: true } }) }, 1024),
    jsonLine({ method: 'x', params: { future: true } }));
  const cyclic = { method: 'x' };
  cyclic.params = cyclic;
  const invalid = [cyclic, { method: 'x', params: 1n }, { id: 1, result: undefined },
    { method: 'x', get params() { throw new Error('inspection'); } },
    { method: 'x', toJSON() { throw new Error('serialization'); } },
    { toJSON: () => ({ method: 'x' }) },
    ...[undefined, [], { method: 'y' }, { method: 'x', id: 1 }].map((value) => ({ method: 'x', toJSON: () => value })),
    { id: 1, method: 'x', toJSON: () => ({ id: '1', method: 'x' }) },
    { id: 1, method: 'x', toJSON: () => ({ id: 1, method: 'y' }) },
    { id: 1, result: undefined, toJSON: () => ({ id: 1, result: null }) },
    { id: 1, result: null, toJSON: () => ({ id: 2, result: null }) },
    { id: 1, error: { code: 1, message: 'x' }, toJSON: () => ({ id: 1, result: null }) },
    { id: 1, result: null, toJSON: () => ({ id: 1, error: { code: 1, message: 'x' } }) },
    { id: 1, error: { code: 1, message: 'x', toJSON: () => ({ code: 'bad', message: 'x' }) } }];
  for (const value of invalid) assert.equal(encodeEnvelope(value, 1024), undefined);
});
