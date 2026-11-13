import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthContext } from '@mattsp1290/switchboard';

const scope = (suffix = 'a') => ({
  engine: `native-${suffix}`, account: `account-${suffix}`,
  adapterInstanceId: `adapter-${suffix}`, sessionId: `session-${suffix}`,
});
const request = (id = 'one') => ({ boundary: 'request', invocationId: 'run-one', requestId: id });
const direct = (resolve, extra = {}) => ({ kind: 'direct', model: 'native/model-alias', resolve, ...extra });
const proxy = (resolve, extra = {}) => ({
  kind: 'litellm', model: 'tenant/model-alias', endpoint: 'http://proxy.internal/family/root',
  protocol: 'native-family-protocol', credentialPurpose: 'litellm-proxy', resolve, ...extra,
});
const credential = (token = 'fake-proxy-token') => ({ purpose: 'litellm-proxy', token });
const signal = () => new AbortController().signal;
function context(config, selectedScope = scope()) {
  const result = createAuthContext({ config, scope: selectedScope });
  assert.equal(result.kind, 'ok');
  return result.value;
}
function ok(result) {
  assert.equal(result.kind, 'ok');
  return result.value;
}
function error(result, code) {
  assert.deepEqual(result, { kind: 'error', error: {
    code, message: 'Authentication could not be resolved.',
  } });
}
function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: (value) => release(value) };
}

test('direct native sign-in preserves adapter material, options and qualified route', async () => {
  const material = { mechanism: 'native-sign-in', credentialHandle: { nativeIdentity: 'fake-native' } };
  const nativeOptions = { family: 'custom-native', feature: ['native-sign-in'] };
  const route = { endpoint: 'https://native.example/custom/messages', model: 'team/native/alias',
    protocol: 'family-specific', headers: { 'x-native-option': 'native-value' }, nativeOptions };
  const auth = context(direct(() => material, route));
  const resolved = ok(await auth.resolve(request(), signal()));
  assert.equal(resolved.kind, 'direct');
  assert.equal(resolved.material, material);
  assert.equal(resolved.nativeOptions, nativeOptions);
  assert.equal(Object.isFrozen(nativeOptions), false);
  assert.equal(Object.isFrozen(material), false);
  for (const field of ['endpoint', 'model', 'protocol']) assert.equal(resolved[field], route[field]);
  assert.deepEqual(resolved.headers, route.headers);
  assert.equal(Object.isFrozen(resolved), true);
  const nativeDefault = ok(await context(direct(() => material)).resolve(request(), signal()));
  assert.equal('endpoint' in nativeDefault, false);
  assert.equal('protocol' in nativeDefault, false);
});

test('config, scope and boundary mutations cannot cross concurrent credential scopes', async () => {
  const barriers = [deferred(), deferred(), deferred()];
  const seen = [];
  const selectedScope = scope('a');
  const headers = { 'x-native': 'initial' };
  const config = proxy((received, receivedSignal) => {
    const index = seen.length;
    seen.push({ received, receivedSignal });
    return barriers[index].promise;
  }, { headers });
  const authA = context(config, selectedScope);
  const authB = context(proxy(config.resolve), scope('b'));
  const selectedRequest = request('first');
  const firstSignal = signal();
  const first = authA.resolve(selectedRequest, firstSignal);
  const second = authB.resolve(request('second'), signal());
  const third = authA.resolve(request('third'), signal());
  selectedRequest.requestId = 'mutated';
  Object.assign(selectedScope, scope('mutated'));
  Object.assign(config, { model: 'mutated', endpoint: 'http://mutated.invalid',
    protocol: 'mutated', resolve: () => { throw Error('replacement must not run'); } });
  headers['x-native'] = 'mutated';
  assert.equal(seen.length, 3);
  assert.equal(seen[0].receivedSignal, firstSignal);
  assert.deepEqual(seen.map(({ received }) => [received.scope.engine, received.scope.account,
    received.scope.adapterInstanceId, received.scope.sessionId, received.requestId]), [
    ['native-a', 'account-a', 'adapter-a', 'session-a', 'first'],
    ['native-b', 'account-b', 'adapter-b', 'session-b', 'second'],
    ['native-a', 'account-a', 'adapter-a', 'session-a', 'third'],
  ]);
  for (const { received } of seen) {
    assert.equal(Object.isFrozen(received), true);
    assert.equal(Object.isFrozen(received.scope), true);
    assert.throws(() => { received.scope.account = 'bad'; }, TypeError);
  }
  assert.notEqual(seen[0].received, seen[2].received);
  assert.notEqual(seen[0].received.scope, seen[2].received.scope);
  barriers[1].release(credential('fake-b'));
  barriers[2].release(credential('fake-a-third'));
  barriers[0].release(credential('fake-a-first'));
  const values = (await Promise.all([first, second, third])).map(ok);
  assert.deepEqual(values.map(({ material }) => material.token), ['fake-a-first', 'fake-b', 'fake-a-third']);
  assert.equal(values[0].model, 'tenant/model-alias');
  assert.equal(values[0].endpoint, 'http://proxy.internal/family/root');
  assert.equal(values[0].protocol, 'native-family-protocol');
  assert.deepEqual(values[0].headers, { 'x-native': 'initial' });
  assert.equal(Object.isFrozen(values[0].headers), true);
  assert.equal(Object.isFrozen(config), false);
});

test('each explicit boundary resolves afresh, including work resumed by the caller', async () => {
  let rotation = 0;
  const boundaries = [];
  const auth = context(proxy((received) => {
    boundaries.push(received);
    rotation += 1;
    return credential(`fake-rotation-${rotation}`);
  }));
  const calls = [request('request-one'), request('request-two'),
    { boundary: 'invocation', invocationId: 'resumed-invocation' },
    { boundary: 'request', invocationId: 'resumed-invocation', requestId: 'resumed-request' }];
  for (const boundary of calls) {
    const result = ok(await auth.resolve(boundary, signal()));
    assert.equal(result.kind, 'litellm');
    assert.equal(result.credentialPurpose, 'litellm-proxy');
    assert.equal(result.material.token, `fake-rotation-${boundaries.length}`);
    assert.equal(Object.isFrozen(result.material), true);
  }
  assert.deepEqual(boundaries.map(({ scope: _scope, ...boundary }) => boundary), calls);
  assert.equal(rotation, 4);
});

test('invalid known configuration fails before resolution or native dispatch', () => {
  let calls = 0;
  const resolver = () => { calls += 1; return credential(); };
  const endpoints = ['', 'relative/path', 'https://', 'https:///host', 'ftp://proxy.example',
    'https://user:secret@proxy.example', 'https://@proxy.example', 'https://proxy.example?key=secret',
    'https://proxy.example#secret', 'https://proxy.example?', 'https://proxy.example#',
    'https://proxy.example\n/secret', ' https://proxy.example', 'https:\\proxy.example'];
  const configs = endpoints.map((endpoint) => proxy(resolver, { endpoint }));
  configs.push(proxy(resolver, { endpoint: undefined }), proxy(resolver, { protocol: undefined }),
    proxy(resolver, { credentialPurpose: 'upstream-provider' }), direct(resolver, { credentialPurpose: 'litellm-proxy' }),
    direct(resolver, { kind: 'unknown' }), direct(resolver, { resolve: 'not callable' }),
    direct(resolver, { model: '' }), direct(resolver, { model: '   ' }), direct(resolver, { model: 'bad\rmodel' }),
    direct(resolver, { model: 'm'.repeat(1025) }), direct(resolver, { protocol: '' }),
    direct(resolver, { headers: { 'bad name': 'value' } }), direct(resolver, { headers: { good: 'bad\nvalue' } }),
    direct(resolver, { headers: { good: 123 } }), direct(resolver, { headers: [] }),
    proxy(resolver, { upstreamToken: 'fake-upstream-must-not-tunnel' }),
    direct(resolver, { endpoint: 'not-a-url' }));
  for (const config of configs) error(createAuthContext({ config, scope: scope() }), 'invalid-config');
  for (const field of ['engine', 'account', 'adapterInstanceId', 'sessionId']) {
    error(createAuthContext({ config: proxy(resolver), scope: { ...scope(), [field]: '' } }), 'invalid-config');
  }
  assert.equal(calls, 0);
});

test('host-authorized HTTP and HTTPS roots and custom protocols remain exact', async () => {
  for (const endpoint of ['http://127.0.0.1:8000/root', 'http://private.proxy:8000/native/root/',
    'https://remote.example/team/root', 'http://[::1]:8000/root']) {
    const result = ok(await context(proxy(() => credential(), { endpoint })).resolve(request(), signal()));
    assert.equal(result.endpoint, endpoint);
    assert.equal(result.model, 'tenant/model-alias');
    assert.equal(result.protocol, 'native-family-protocol');
  }
});

test('proxy result validation cannot fall back to direct auth', async () => {
  const invalid = [undefined, null, '', 'fake-token', { token: 'fake-token' },
    { purpose: 'upstream-provider', token: 'fake-token' }, credential(''), credential('   '),
    credential('fake\ntoken'), credential('x'.repeat(16385)), { ...credential(), extra: 'fake-secret' }];
  let calls = 0;
  let dispatched = 0;
  for (const material of invalid) {
    const auth = context(proxy(() => { calls += 1; return material; }));
    const result = await auth.resolve(request(), signal());
    if (result.kind === 'ok') dispatched += 1;
    error(result, 'credential-unavailable');
    assert.equal(JSON.stringify(result).includes('fake-secret'), false);
  }
  assert.equal(calls, invalid.length);
  assert.equal(dispatched, 0);
});

test('resolver exceptions, rejected thenables and throwing result accessors return safe failures', async () => {
  const canary = 'fake-sensitive-canary';
  const throwing = { purpose: 'litellm-proxy', get token() { throw Error(canary); } };
  const resolvers = [() => { throw Error(canary, { cause: canary }); },
    async () => { throw { token: canary, stack: canary }; },
    () => ({ then() { throw Error(canary); } }), () => throwing];
  for (const resolve of resolvers) {
    const result = await context(proxy(resolve)).resolve(request(), signal());
    error(result, 'credential-unavailable');
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal('cause' in result.error, false);
    assert.equal('stack' in result.error, false);
  }
  error(await context(direct(() => { throw Error(canary); })).resolve(request(), signal()), 'credential-unavailable');
});

test('invalid boundaries fail before resolution and abort prevents successful credential dispatch', async () => {
  let calls = 0;
  const waiting = deferred();
  const auth = context(proxy(() => { calls += 1; return waiting.promise; }));
  for (const boundary of [null, {}, { boundary: 'invocation', invocationId: '' },
    { boundary: 'request', invocationId: 'run' }, { boundary: 'request', invocationId: 'run', requestId: '' },
    { boundary: 'invocation', invocationId: 'run', requestId: 'mixed' }]) {
    error(await auth.resolve(boundary, signal()), 'invalid-boundary');
  }
  const before = new AbortController();
  before.abort('fake-abort-secret');
  error(await auth.resolve(request(), before.signal), 'aborted');
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = auth.resolve(request(), during.signal);
  during.abort('fake-abort-secret');
  waiting.release(credential());
  error(await pending, 'aborted');
  assert.equal(calls, 1);
  const rejected = deferred();
  const rejectedAuth = context(direct(async () => { await rejected.promise; throw Error('fake-secret'); }));
  const late = new AbortController();
  const rejectedPending = rejectedAuth.resolve(request(), late.signal);
  late.abort();
  rejected.release();
  error(await rejectedPending, 'aborted');
});

test('known fields are captured once before validation, including accessor-backed inputs', async () => {
  const selectedScope = scope();
  let accountReads = 0;
  Object.defineProperty(selectedScope, 'account', {
    enumerable: true, get() { accountReads += 1; return accountReads === 1 ? 'account-a' : ''; },
  });
  let endpointReads = 0;
  const config = proxy(() => credential());
  Object.defineProperty(config, 'endpoint', {
    enumerable: true, get() { endpointReads += 1; return endpointReads === 1 ? 'http://proxy.internal/root' : 'bad'; },
  });
  const auth = context(config, selectedScope);
  const result = ok(await auth.resolve(request(), signal()));
  assert.equal(result.endpoint, 'http://proxy.internal/root');
  assert.equal(accountReads, 1);
  assert.equal(endpointReads, 1);
  let tokenReads = 0;
  const material = { purpose: 'litellm-proxy', get token() {
    tokenReads += 1;
    return tokenReads === 1 ? 'fake-valid-token' : '';
  } };
  const resolved = ok(await context(proxy(() => material)).resolve(request(), signal()));
  assert.equal(resolved.material.token, 'fake-valid-token');
  assert.equal(tokenReads, 1);
  const throwingConfig = direct(() => 'fake-direct');
  Object.defineProperty(throwingConfig, 'model', { get() { throw Error('fake-config-canary'); } });
  error(createAuthContext({ config: throwingConfig, scope: scope() }), 'invalid-config');
});
