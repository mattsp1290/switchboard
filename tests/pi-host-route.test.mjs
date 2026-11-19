import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(join(root, 'dist', 'index.js')) || !existsSync(join(root, 'dist', 'host', 'pi', 'route.js'))) {
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [tsc, '-p', 'adapters/pi-host/tsconfig.json'], { cwd: root, stdio: 'inherit' });
}
const { admitPiHostTransport } = await import('../dist/host/pi/route.js');
const { isPiHostSystemEntry, validatePiHostSessionState } = await import('../dist/host/pi/contract.js');

const scope = { engine: 'pi', account: 'account-a', adapterInstanceId: 'adapter-a', sessionId: 'session-a' };
const signal = () => new AbortController().signal;
const hostRoute = (resolve, extra = {}) => ({
  kind: 'host-route', model: 'fixture/model', endpoint: 'http://127.0.0.1:9', protocol: 'switchboard-host',
  credentialPurpose: 'host-route', credentialForm: 'bearer', principal: 'crew-relay', resolve, ...extra,
});
const body = { model: 'host', protocol: 'switchboard-host', instructions: 'Be brief.', turns: [], tools: [] };

test('a system entry is the session role the host can filter', () => {
  assert.equal(isPiHostSystemEntry({ role: 'system' }), true);
  assert.equal(isPiHostSystemEntry({ role: 'assistant' }), false);
  const state = { formatVersion: 1, sessionId: 'session-a', turns: [{ segment: 1, role: 'system', text: 'Be brief.' }] };
  assert.equal(validatePiHostSessionState(state), true);
  assert.equal(validatePiHostSessionState({ ...state, formatVersion: 2 }), false);
});

test('a stream admits no route and does not resolve one', () => {
  let resolved = false;
  const admitted = admitPiHostTransport({
    stream: true, invocationId: 'open-1',
    route: { config: hostRoute(() => { resolved = true; }), scope },
  });
  assert.equal(admitted.kind, 'error');
  assert.equal(resolved, false);
  assert.equal(admitPiHostTransport({ stream: true, invocationId: 'open-1', route: undefined }).value.kind, 'stream');
});

test('direct and LiteLLM routes are refused and subscription passthrough stays absent', () => {
  const direct = admitPiHostTransport({
    stream: false, invocationId: 'open-1',
    route: { config: { kind: 'direct', model: 'fixture/model', resolve: () => { throw new Error('called'); } }, scope },
  });
  const proxy = admitPiHostTransport({
    stream: false, invocationId: 'open-1',
    route: { config: { kind: 'litellm', model: 'fixture/model', endpoint: 'http://127.0.0.1:9', protocol: 'responses',
      credentialPurpose: 'litellm-proxy', resolve: () => ({ token: 'proxy-token' }) }, scope },
  });
  const subscription = admitPiHostTransport({
    stream: false, invocationId: 'open-1',
    route: { config: hostRoute(() => ({ purpose: 'host-route', form: 'none' }), { protocol: 'subscription', credentialForm: 'none' }), scope },
  });
  assert.equal(direct.kind, 'error');
  assert.equal(proxy.kind, 'error');
  assert.equal(subscription.error.message, 'Subscription passthrough is absent.');
  assert.match(direct.error.message, /does not fall back/);
});

test('a host route rotates credentials, keeps headers, and redacts the token', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ events: [{ kind: 'text', text: 'ok' }] }));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  let calls = 0;
  const admitted = admitPiHostTransport({
    stream: false, invocationId: 'open-1',
    route: { config: hostRoute(() => {
      calls += 1;
      return { purpose: 'host-route', form: 'bearer', token: `route-token-${calls}`, headers: { 'x-account': 'acct' } };
    }, { endpoint: `http://127.0.0.1:${port}`, headers: { 'x-crew': 'one' } }), scope },
  });
  assert.equal(admitted.kind, 'ok');
  const first = await admitted.value.request(body, signal());
  const second = await admitted.value.request(body, signal());
  const [left, right] = await Promise.all([admitted.value.request(body, signal()), admitted.value.request(body, signal())]);
  assert.equal(first.kind, 'ok');
  assert.equal(second.events[0].text, 'ok');
  assert.equal(left.kind, 'ok');
  assert.equal(right.kind, 'ok');
  assert.equal(seen[0].authorization, 'Bearer route-token-1');
  assert.equal(seen[1].authorization, 'Bearer route-token-2');
  assert.equal(seen[0]['x-crew'], 'one');
  assert.equal(seen[0]['x-account'], 'acct');
  assert.notEqual(seen[2].authorization, seen[3].authorization);
  const thrown = admitPiHostTransport({
    stream: false, invocationId: 'open-2',
    route: { config: hostRoute(() => ({ purpose: 'host-route', form: 'bearer', token: 'route-token-leaked' }),
      { endpoint: `http://127.0.0.1:${port}` }), scope },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('socket failed for route-token-leaked'); };
  try {
    const redacted = await thrown.value.request(body, signal());
    assert.equal(redacted.error.message.includes('route-token-leaked'), false);
    assert.match(redacted.error.message, /\[redacted\]/);
  } finally {
    globalThis.fetch = original;
    await new Promise((resolve) => { server.close(resolve); });
  }
});
