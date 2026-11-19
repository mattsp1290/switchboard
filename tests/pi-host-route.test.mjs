import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { admitPiHostTransport } from '../dist/host/pi/route.js';
import { isPiHostSystemEntry, validatePiHostSessionState } from '../dist/host/pi/contract.js';

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
  let resolved = false;
  const refuse = (protocol) => admitPiHostTransport({
    stream: false, invocationId: 'open-1',
    route: { config: hostRoute(() => { resolved = true; return { purpose: 'host-route', form: 'none' }; }, { protocol, credentialForm: 'none' }), scope },
  });
  const subscription = refuse('subscription');
  const titled = refuse(' Subscription ');
  const passthrough = refuse('PASSTHROUGH');
  const responses = refuse('responses');
  const spaced = refuse('switchboard-host ');
  assert.equal(direct.kind, 'error');
  assert.equal(proxy.kind, 'error');
  assert.equal(resolved, false);
  assert.equal(subscription.error.message, 'Subscription passthrough is absent.');
  assert.equal(titled.error.message, 'Subscription passthrough is absent.');
  assert.equal(passthrough.error.message, 'Subscription passthrough is absent.');
  assert.match(responses.error.message, /switchboard-host/);
  assert.match(spaced.error.message, /switchboard-host/);
  assert.match(direct.error.message, /does not fall back/);
});

test('a host route rotates credentials, keeps headers, and redacts the token', async () => {
  const seen = [];
  const bodies = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => { chunks.push(chunk); });
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      seen.push(request.headers);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ events: [{ kind: 'text', text: 'ok' }] }));
    });
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
  const leaked = 'route-token-leaked-value';
  const stale = admitPiHostTransport({
    stream: false, invocationId: 'open-2',
    route: { config: hostRoute(() => ({ purpose: 'host-route', form: 'bearer', token: leaked, headers: { 'Content-Type': 'text/plain' } }),
      { endpoint: `http://127.0.0.1:${port}`, headers: { Authorization: 'Bearer stale-token' } }), scope },
  });
  assert.equal(stale.kind, 'ok');
  const replaced = await stale.value.request(body, signal());
  assert.equal(replaced.kind, 'ok');
  assert.equal(seen.at(-1).authorization, `Bearer ${leaked}`);
  assert.equal(seen.at(-1).authorization.includes('stale-token'), false);
  assert.equal(seen.at(-1)['content-type'], 'application/json');
  assert.equal(bodies.at(-1).includes(leaked), false);
  assert.equal(bodies.at(-1).includes('stale-token'), false);
  const beforePlain = seen.length;
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(leaked);
  });
  const unreadable = await stale.value.request(body, signal());
  assert.equal(unreadable.kind, 'error');
  assert.equal(unreadable.error.message, 'The host route request failed.');
  assert.equal(unreadable.error.message.includes(leaked.slice(0, 10)), false);
  server.removeAllListeners('request');
  const headerSecret = 'shortsec';
  server.on('request', (request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(headerSecret);
  });
  const shortSecret = admitPiHostTransport({
    stream: false, invocationId: 'open-3',
    route: { config: hostRoute(() => ({ purpose: 'host-route', form: 'bearer', token: 'rotated-token', headers: { 'x-account': headerSecret } }),
      { endpoint: `http://127.0.0.1:${port}` }), scope },
  });
  const shortBody = await shortSecret.value.request(body, signal());
  assert.equal(shortBody.error.message, 'The host route request failed.');
  assert.equal(shortBody.error.message.includes(headerSecret), false);
  const anonymous = admitPiHostTransport({
    stream: false, invocationId: 'open-4',
    route: { config: hostRoute(() => ({ purpose: 'host-route', form: 'none' }), {
      endpoint: `http://127.0.0.1:${port}`, credentialForm: 'none', headers: { Authorization: 'Bearer leftover' },
    }), scope },
  });
  const blocked = await anonymous.value.request(body, signal());
  assert.equal(blocked.error.code, 'invalid-input');
  assert.equal(seen.length, beforePlain + 2);
  await new Promise((resolve) => { server.close(resolve); });
});
