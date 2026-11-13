import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSafeError, normalizeError, serializeDiagnostic, summarizeDiagnostic, createEventStream } from '@mattsp1290/switchboard';

const messages = {
  unsupported: 'The operation is unsupported.',
  busy: 'The adapter is busy.',
  closed: 'The adapter is closed.',
  'invalid-input': 'The input is invalid.',
  'native-failure': 'The native operation failed.',
  'invalid-config': 'The authentication configuration is invalid.',
  'invalid-boundary': 'The authentication boundary is invalid.',
  'credential-unavailable': 'The credential is unavailable.',
  aborted: 'The operation was aborted.',
};
const categories = ['endpoint', 'headers', 'credentials', 'checkpoint', 'native-data'];
const fallbackError = { code: 'native-failure', message: messages['native-failure'] };
const fallbackJSON = '{"kind":"redacted","category":"native-data"}';
const canaries = Array.from({ length: 17 }, (_, index) => `secret-canary-${index}-\u{1f512}-never-project`);
function checkProjection(value) {
  const json = serializeDiagnostic(value);
  for (const text of [json, JSON.stringify(value)]) {
    assert(Buffer.byteLength(text, 'utf8') <= 512);
    for (const canary of canaries) assert.equal(text.includes(canary), false);
  }
  assert(Object.isFrozen(value));
  return json;
}

test('every qualified domain code gets its fixed bounded error wrapper', () => {
  for (const [code, message] of Object.entries(messages)) {
    const error = createSafeError(code);
    assert.deepEqual(error, { code, message });
    assert.equal(normalizeError(error), error);
    const diagnostic = summarizeDiagnostic('error', error);
    assert.equal(diagnostic.error, error);
    assert.deepEqual(diagnostic, { kind: 'error', error: { code, message } });
    assert.equal(checkProjection(error), checkProjection(diagnostic));
    assert.deepEqual(JSON.parse(serializeDiagnostic(error)), diagnostic);
  }
  for (const category of categories) {
    const diagnostic = summarizeDiagnostic(category, undefined);
    assert.deepEqual(diagnostic, { kind: 'redacted', category });
    checkProjection(diagnostic);
  }
});

test('unowned structural native codes, errors, clones and forgeries lose provenance', () => {
  const error = createSafeError('busy');
  const diagnostic = summarizeDiagnostic('error', error);
  const invalidErrors = [
    { code: 'busy' }, { ...error }, structuredClone(error), JSON.parse(JSON.stringify(error)),
    Object.create(error), new Proxy(error, {}), diagnostic,
    new Error(canaries[0]), { code: 'busy', message: canaries[1] },
  ];
  for (const value of invalidErrors) {
    assert.deepEqual(normalizeError(value), fallbackError);
    checkProjection(normalizeError(value));
  }
  for (const value of [
    { ...diagnostic }, structuredClone(diagnostic), JSON.parse(JSON.stringify(diagnostic)),
    Object.create(diagnostic), new Proxy(diagnostic, {}), ...invalidErrors.filter((value) => value !== diagnostic),
  ]) assert.equal(serializeDiagnostic(value), fallbackJSON);
  for (const category of categories) {
    const record = summarizeDiagnostic(category, error);
    assert.deepEqual(normalizeError(record), fallbackError);
    assert.equal(serializeDiagnostic({ ...record }), fallbackJSON);
  }
});

test('all returned records and nested errors are immutable', () => {
  for (const code of Object.keys(messages)) {
    const error = createSafeError(code);
    const diagnostic = summarizeDiagnostic('error', error);
    assert.throws(() => { error.code = 'closed'; }, TypeError);
    assert.throws(() => { diagnostic.error.message = canaries[0]; }, TypeError);
    assert.throws(() => { diagnostic.error = createSafeError('closed'); }, TypeError);
    assert.throws(() => { Object.setPrototypeOf(error, {}); }, TypeError);
    assert.throws(() => { Object.defineProperty(error, 'toJSON', { value: () => canaries[0] }); }, TypeError);
    assert.deepEqual(error, { code, message: messages[code] });
    checkProjection(diagnostic);
  }
  for (const category of categories) {
    const value = summarizeDiagnostic(category, null);
    assert.throws(() => { value.category = 'error'; }, TypeError);
    assert.throws(() => { value.secret = canaries[0]; }, TypeError);
    checkProjection(value);
  }
});

test('secrets across endpoint, headers, credentials, checkpoints and nested native errors are suppressed whole', () => {
  const exception = new Error(canaries[10], { cause: new Error(canaries[12]) });
  exception.stack = canaries[11];
  const input = {
    endpoint: `https://${canaries[0]}:${canaries[1]}@host/${canaries[2]}?token=${canaries[3]}`,
    headers: { [canaries[4]]: canaries[5] }, credentials: { token: canaries[6] },
    checkpoint: { binding: { account: canaries[7] }, opaque: canaries[8] },
    native: { namespace: canaries[9], data: [exception, [[canaries[13]]]] },
    [canaries[14]]: { code: 'busy', message: canaries[15], cause: canaries[16] },
  };
  for (const value of [input, exception, input.native, input.checkpoint, input.headers]) {
    checkProjection(normalizeError(value));
    checkProjection(summarizeDiagnostic('error', value));
    assert.equal(serializeDiagnostic(value), fallbackJSON);
    for (const category of categories) {
      const diagnostic = summarizeDiagnostic(category, value);
      assert.deepEqual(diagnostic, { kind: 'redacted', category });
      checkProjection(diagnostic);
    }
  }
});

test('malformed runtime boundaries and hostile nested values run zero hooks and throw no exceptions', () => {
  let hooks = 0;
  const hostile = () => { hooks++; throw new Error(canaries[0]); };
  const trapNames = ['get', 'set', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf',
    'setPrototypeOf', 'defineProperty', 'deleteProperty', 'isExtensible', 'preventExtensions', 'apply', 'construct'];
  const traps = Object.fromEntries(trapNames.map((name) => [name, hostile]));
  const revoked = Proxy.revocable({}, traps);
  revoked.revoke();
  const revokedFunction = Proxy.revocable(function () {}, traps);
  revokedFunction.revoke();
  const getter = Object.defineProperties({}, Object.fromEntries(
    ['code', 'message', 'cause', 'stack', 'toJSON', canaries[1]].map((name) => [name, { get: hostile, enumerable: true }]),
  ));
  const coercion = { toJSON: hostile, toString: hostile, valueOf: hostile, [Symbol.toPrimitive]: hostile };
  const cycle = { nested: getter };
  cycle.self = cycle;
  let deep = coercion;
  for (let index = 0; index < 10000; index++) deep = { nested: deep };
  const values = [undefined, null, true, 42, NaN, 1n, Symbol('secret'), canaries[2], '', 'constructor',
    '__proto__', 'toString', {}, [], new Array(2 ** 32 - 1), cycle, deep, getter, coercion,
    new Proxy({}, traps), new Proxy(function () {}, traps), revoked.proxy, revokedFunction.proxy,
    { code: 'busy', native: [revoked.proxy, getter, coercion, cycle, deep] },
    new Proxy(createSafeError('busy'), traps), new Proxy(summarizeDiagnostic('headers', null), traps)];
  for (const value of values) {
    let thrown = false;
    try {
      assert.deepEqual(createSafeError(value), fallbackError);
      checkProjection(createSafeError(value));
      assert.deepEqual(normalizeError(value), fallbackError);
      checkProjection(normalizeError(value));
      assert.equal(serializeDiagnostic(value), fallbackJSON);
      assert.equal(serializeDiagnostic(summarizeDiagnostic(value, value)), fallbackJSON);
      for (const category of ['error', ...categories]) checkProjection(summarizeDiagnostic(category, value));
    } catch {
      thrown = true;
    }
    assert.equal(thrown, false, 'No helper or output projection throws for malformed input.');
  }
  assert.equal(hooks, 0);
});

test('an installed event stream delivers owned projections for listener serialization', async () => {
  const stream = createEventStream({ maxObservers: 1, capacity: 32 });
  const received = [];
  const delivered = Promise.withResolvers();
  const events = [summarizeDiagnostic('error', createSafeError('busy')),
    summarizeDiagnostic('error', new Error(canaries[0])),
    ...categories.map((category) => summarizeDiagnostic(category, { [canaries[1]]: canaries[2] }))];
  const subscribed = stream.subscribe((event) => {
    received.push(checkProjection(event));
    if (received.length === events.length) delivered.resolve();
  });
  assert.equal(subscribed.kind, 'ok');
  for (const event of events) assert.equal(stream.publish(event).enqueued, 1);
  await delivered.promise;
  assert.deepEqual(received, events.map(serializeDiagnostic));
  stream.close();
  assert.equal(await subscribed.value.ended, 'closed');
});


test('records from a separate installed package instance have no local provenance', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'switchboard-diagnostics-instance-'));
  try {
    const name = '@mattsp1290/switchboard';
    const installed = dirname(dirname(fileURLToPath(import.meta.resolve(name))));
    const destination = join(temporary, 'node_modules', ...name.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(installed, destination, { recursive: true });
    const entry = join(temporary, 'consumer.mjs');
    writeFileSync(entry, `export * from '${name}';`);
    const other = await import(pathToFileURL(entry).href);
    const foreignError = other.createSafeError('busy');
    const foreignDiagnostic = other.summarizeDiagnostic('error', foreignError);
    assert.equal(other.normalizeError(foreignError), foreignError);
    assert.deepEqual(normalizeError(foreignError), fallbackError);
    assert.equal(serializeDiagnostic(foreignError), fallbackJSON);
    assert.equal(serializeDiagnostic(foreignDiagnostic), fallbackJSON);
    assert.equal(other.serializeDiagnostic(createSafeError('busy')), fallbackJSON);
    checkProjection(summarizeDiagnostic('error', foreignError));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
