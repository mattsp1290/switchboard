import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthContext } from '@mattsp1290/switchboard';

const scope = { engine: 'codex', account: 'account-a', adapterInstanceId: 'adapter-a', sessionId: 'session-a' };
const request = { boundary: 'request', invocationId: 'run-one', requestId: 'one' };
const signal = () => new AbortController().signal;
const route = (credentialForm, resolve, extra = {}) => ({
  kind: 'host-route', model: 'fixture/model', endpoint: 'http://127.0.0.1:41234', protocol: 'responses',
  credentialPurpose: 'host-route', credentialForm, principal: 'crew-relay', resolve, ...extra,
});
function context(config) {
  const result = createAuthContext({ config, scope });
  assert.equal(result.kind, 'ok');
  return result.value;
}
const unresolved = { kind: 'error', error: { code: 'credential-unavailable', message: 'Authentication could not be resolved.' } };

test('a no-auth loopback route resolves without material and keeps its principal across ports', async () => {
  for (const port of [41234, 52345]) {
    const resolved = await context(route('none', () => ({ purpose: 'host-route', form: 'none' }),
      { endpoint: `http://127.0.0.1:${port}` })).resolve(request, signal());
    assert.equal(resolved.kind, 'ok');
    assert.deepEqual(resolved.value.material, { purpose: 'host-route', form: 'none' });
    assert.equal(resolved.value.principal, 'crew-relay');
    assert.equal(resolved.value.endpoint, `http://127.0.0.1:${port}`);
    assert.equal(Object.isFrozen(resolved.value), true);
  }
});

test('a host bearer resolves per boundary with its account header and no /v1 suffix', async () => {
  let calls = 0;
  const auth = context(route('bearer', (resolution) => {
    calls++;
    assert.equal(resolution.scope.account, 'account-a');
    return { purpose: 'host-route', form: 'bearer', token: `fake-token-${calls}`, headers: { 'chatgpt-account-id': 'fake-account' } };
  }, { endpoint: 'https://chatgpt.example/backend-api/codex' }));
  const first = await auth.resolve(request, signal());
  const second = await auth.resolve({ ...request, requestId: 'two' }, signal());
  assert.equal(first.value.material.token, 'fake-token-1');
  assert.equal(second.value.material.token, 'fake-token-2');
  assert.deepEqual(first.value.material.headers, { 'chatgpt-account-id': 'fake-account' });
  assert.equal(Object.isFrozen(first.value.material.headers), true);
  assert.equal(first.value.credentialForm, 'bearer');
});

test('the helper form resolves without material', async () => {
  const resolved = await context(route('helper', () => ({ purpose: 'host-route', form: 'helper' }))).resolve(request, signal());
  assert.deepEqual(resolved.value.material, { purpose: 'host-route', form: 'helper' });
});

test('material that does not match the declared form is unavailable, never another route', async () => {
  const cases = [
    ['none', { purpose: 'host-route', form: 'bearer', token: 'fake-token' }],
    ['bearer', { purpose: 'host-route', form: 'none' }],
    ['bearer', { purpose: 'litellm-proxy', token: 'fake-token' }],
    ['bearer', { purpose: 'host-route', form: 'bearer', token: '' }],
    ['bearer', { purpose: 'host-route', form: 'bearer', token: 'fake-token', headers: { 'bad header': 'x' } }],
    ['bearer', { purpose: 'host-route', form: 'bearer', token: 'fake-token', extra: true }],
    ['helper', { purpose: 'host-route', form: 'helper', token: 'fake-token' }],
  ];
  for (const [form, material] of cases) {
    assert.deepEqual(await context(route(form, () => material)).resolve(request, signal()), unresolved);
  }
});

test('host route configuration requires its purpose, form, principal, endpoint and protocol', () => {
  const resolve = () => ({ purpose: 'host-route', form: 'none' });
  for (const extra of [
    { credentialPurpose: 'litellm-proxy' }, { credentialForm: 'env-key' }, { principal: '' }, { principal: undefined },
    { endpoint: 'http://user:secret@127.0.0.1:1' }, { endpoint: undefined }, { protocol: undefined }, { unknownField: 1 },
  ]) {
    const result = createAuthContext({ config: route('none', resolve, extra), scope });
    assert.equal(result.kind, 'error', JSON.stringify(extra));
    assert.equal(result.error.code, 'invalid-config');
  }
});

test('the litellm-proxy route is unchanged beside the host route', async () => {
  const auth = context({ kind: 'litellm', model: 'alias', endpoint: 'http://proxy.internal/v1', protocol: 'responses',
    credentialPurpose: 'litellm-proxy', resolve: () => ({ purpose: 'litellm-proxy', token: 'fake-proxy-token' }) });
  const resolved = await auth.resolve(request, signal());
  assert.equal(resolved.value.kind, 'litellm');
  assert.deepEqual(resolved.value.material, { purpose: 'litellm-proxy', token: 'fake-proxy-token' });
  assert.equal(createAuthContext({ config: route('none', () => ({}), { credentialPurpose: 'litellm-proxy', kind: 'litellm' }),
    scope }).kind, 'error');
});
