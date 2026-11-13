import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

mkdirSync('/tmp/project');
writeFileSync('/tmp/auth-mode', 'token');
writeFileSync('/tmp/auth-count', '0');
writeFileSync('/tmp/credential.mjs', `import {readFileSync,writeFileSync} from 'node:fs';
const count=Number(readFileSync('/tmp/auth-count','utf8'))+1;
writeFileSync('/tmp/auth-count',String(count));
if(readFileSync('/tmp/auth-mode','utf8')==='fail')process.exit(7);
process.stdout.write('fixture-token-'+count);`);
const credentialCalls = () => Number(readFileSync('/tmp/auth-count', 'utf8'));
const calls = [];
let behavior = 'answer';
let caseName = 'cache';
let responseId = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    assert(body.length <= 1024 * 1024, 'Bounded inference body');
  }
  assert(calls.length < 100, 'Bounded HTTP request count');
  const call = { case: caseName, method: request.method, path: request.url, token: request.headers.authorization };
  calls.push(call);
  if (request.url !== '/v1/responses') {
    assert.equal(request.method, 'GET');
    assert(request.url.startsWith('/v1/models?'));
    response.writeHead(404).end(); return;
  }
  assert.equal(request.method, 'POST');
  const input = JSON.parse(body);
  assert.equal(input.model, 'fixture-model');
  assert.equal(input.stream, true);
  if (behavior === 'reject') {
    behavior = 'answer';
    call.status = 401;
    response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Fixture expired token', type: 'authentication_error' } }));
    return;
  }
  call.status = 200;
  const id = `resp_${++responseId}`;
  const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit({ type: 'response.created', response: { id, status: 'in_progress' } });
  if (behavior === 'hold') return;
  let item = { type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }] };
  if (behavior === 'approval') {
    assert(input.tools.some((tool) => tool.name === 'exec_command'), 'Native advertised exec_command');
    item = { type: 'function_call', id: `fc_${responseId}`, call_id: `call_${responseId}`, name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'touch /tmp/approval-must-not-exist', yield_time_ms: 1000 }), status: 'completed' };
    behavior = 'answer';
  } else {
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'fixture answer' });
  }
  if (behavior === 'disconnect') { response.end(); return; }
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const config = {
  model_provider: 'fixture', model: 'fixture-model', check_for_update_on_startup: false, 'analytics.enabled': false,
  'model_providers.fixture.name': 'Fixture', 'model_providers.fixture.base_url': `http://127.0.0.1:${server.address().port}/v1`,
  'model_providers.fixture.wire_api': 'responses', 'model_providers.fixture.supports_websockets': false,
  'model_providers.fixture.auth.command': '/usr/local/bin/node', 'model_providers.fixture.auth.args': ['/tmp/credential.mjs'],
  'model_providers.fixture.auth.timeout_ms': 1000, 'model_providers.fixture.auth.refresh_interval_ms': 300000,
  'model_providers.fixture.request_max_retries': 0, 'model_providers.fixture.stream_max_retries': 0,
};
const children = [];
async function until(predicate, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out: ${label}`);
}
async function connect(refresh = 300000) {
  const settings = { ...config, 'model_providers.fixture.auth.refresh_interval_ms': refresh };
  const args = Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  const child = spawn('/opt/codex', ['app-server', ...args], { cwd: '/tmp/project', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  children.push(child);
  const events = [];
  const replies = new Map();
  let sequence = 0;
  let bytes = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  child.stdout.on('data', (chunk) => { bytes += chunk.length; assert(bytes < 2 * 1024 * 1024, 'Bounded native output'); });
  const lines = createInterface({ input: child.stdout });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  lines.on('line', (line) => {
    const value = JSON.parse(line);
    if (Object.hasOwn(value, 'id') && !value.method) replies.set(value.id, value);
    else {
      events.push(value);
      if (Object.hasOwn(value, 'id')) {
        assert.equal(value.method, 'item/commandExecution/requestApproval', 'Only expected approval requests');
        send({ id: value.id, result: { decision: 'decline' } });
      }
    }
  });
  const rpc = async (method, params) => {
    const id = ++sequence;
    send({ id, method, params });
    return until(() => { assert.equal(child.exitCode, null, stderr); return replies.get(id); }, method);
  };
  const call = async (method, params) => {
    const value = await rpc(method, params);
    assert(!value.error, JSON.stringify(value));
    return value.result;
  };
  const initialized = await call('initialize', { clientInfo: { name: 'switchboard_fixture', version: '0' } });
  assert.equal(typeof initialized.userAgent, 'string');
  send({ method: 'initialized' });
  return { events, call, rpc, stop: async (signal = 'SIGTERM') => {
    child.kill(signal);
    await until(() => child.exitCode !== null || child.signalCode !== null, 'Native process stopped');
    lines.close();
  } };
}
const inference = (name) => calls.filter((call) => call.case === name && call.path === '/v1/responses');
const threadOptions = { cwd: '/tmp/project', approvalPolicy: 'untrusted', sandbox: 'read-only' };
async function turn(client, threadId, status = 'completed') {
  const { turn: started } = await client.call('turn/start', { threadId, input: [{ type: 'text', text: 'Fixture only.', text_elements: [] }] });
  const completed = await until(() => client.events.find((event) => event.method === 'turn/completed' && event.params.turn.id === started.id), 'Turn completion');
  assert.equal(completed.params.turn.status, status, JSON.stringify(completed));
  return completed;
}
const results = {};
try {
  let client = await connect();
  const startOnly = await client.call('thread/start', threadOptions);
  await client.stop();
  client = await connect();
  const initial = await client.call('thread/list', { limit: 10 });
  assert.deepEqual(initial.data, []);
  assert((await client.rpc('thread/resume', { threadId: startOnly.thread.id, ...threadOptions })).error, 'Start-only ID is not durable');
  results.startOnly = 'ID returned before first turn is not resumable after process exit';
  const { thread } = await client.call('thread/start', threadOptions);
  assert.equal(typeof thread.id, 'string');
  await turn(client, thread.id);
  const cachedCount = credentialCalls();
  const cachedToken = `Bearer fixture-token-${cachedCount}`;
  await turn(client, thread.id);
  assert.equal(inference('cache').length, 2);
  assert.deepEqual(inference('cache').map((call) => call.token), [cachedToken, cachedToken]);
  assert.equal(credentialCalls(), cachedCount);
  results.cache = 'two turns reuse bearer without another helper invocation';
  caseName = '401'; behavior = 'reject';
  await turn(client, thread.id);
  assert.deepEqual(inference('401').map((call) => [call.status, call.token]), [[401, cachedToken], [200, `Bearer fixture-token-${cachedCount + 1}`]]);
  assert.equal(credentialCalls(), cachedCount + 1);
  results.authRejection = 'one rejected request, one renewal, one accepted request';
  await client.stop();
  const prefix = readFileSync(thread.path);
  caseName = 'resume';
  client = await connect();
  const listed = await client.call('thread/list', { limit: 10 });
  assert(listed.data.some((entry) => entry.id === thread.id), 'External native thread discovered by another process');
  const resumed = await client.call('thread/resume', { threadId: thread.id, ...threadOptions });
  assert.equal(resumed.thread.id, thread.id);
  assert(resumed.thread.turns.length >= 3, 'Native saved turns restored');
  assert.equal(inference('resume').length, 0, 'Discovery/resume causes no inference');
  await turn(client, thread.id);
  assert.equal(credentialCalls(), cachedCount + 2, 'New process acquires its own credential');
  assert.equal(inference('resume')[0].token, `Bearer fixture-token-${cachedCount + 2}`);
  assert(readFileSync(thread.path).subarray(0, prefix.length).equals(prefix), 'Saved history byte prefix unchanged');
  results.externalResume = 'new process discovers native thread, resumes and appends without rewriting saved prefix';
  caseName = 'approval'; behavior = 'approval';
  await turn(client, thread.id);
  const approval = client.events.find((event) => event.method === 'item/commandExecution/requestApproval');
  assert(approval, 'Native command approval observed');
  assert.equal(approval.params.threadId, thread.id);
  assert(!existsSync('/tmp/approval-must-not-exist'), 'Declined command never executes');
  assert(client.events.some((event) => event.method === 'item/completed' && event.params.item.type === 'commandExecution' && event.params.item.status === 'declined'));
  results.approval = 'native command request declined; marker absent';
  caseName = 'cancel'; behavior = 'hold';
  const { turn: active } = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Hold fixture.', text_elements: [] }] });
  await until(() => inference('cancel').length === 1, 'Accepted held response');
  await client.call('turn/interrupt', { threadId: thread.id, turnId: active.id });
  const interrupted = await until(() => client.events.find((event) => event.method === 'turn/completed' && event.params.turn.id === active.id), 'Interrupted completion');
  assert.equal(interrupted.params.turn.status, 'interrupted');
  assert.equal(inference('cancel').length, 1);
  results.cancel = 'native interrupted terminal state after one accepted request';
  caseName = 'disconnect'; behavior = 'disconnect';
  const failed = await turn(client, thread.id, 'failed');
  assert(failed.params.turn.error);
  assert(client.events.some((event) => event.method === 'item/agentMessage/delta' && event.params.turnId === failed.params.turn.id), 'Partial output reached native client before failure');
  assert.equal(inference('disconnect').length, 1, 'No inference resubmission after accepted partial stream');
  results.acceptedDisconnect = 'one accepted partial response, failed turn, no resubmission with both retry limits zero';
  caseName = 'transport-loss'; behavior = 'hold';
  await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Lose transport after acceptance.', text_elements: [] }] });
  await until(() => inference('transport-loss').length === 1, 'Accepted request before process loss');
  await client.stop('SIGKILL');
  const lostPrefix = readFileSync(thread.path);
  client = await connect();
  await client.call('thread/resume', { threadId: thread.id, ...threadOptions });
  await delay(100);
  assert.equal(inference('transport-loss').length, 1, 'Resume never resubmits accepted work after process loss');
  assert(readFileSync(thread.path).subarray(0, lostPrefix.length).equals(lostPrefix));
  results.transportLoss = 'accepted request then killed native process; fresh resume preserves prefix without inference resubmission';
  await client.stop();
  caseName = 'expiry'; behavior = 'answer';
  client = await connect(50);
  await client.call('thread/resume', { threadId: thread.id, ...threadOptions });
  await turn(client, thread.id);
  await delay(100);
  await turn(client, thread.id);
  assert.equal(inference('expiry').length, 2);
  assert.notEqual(inference('expiry')[0].token, inference('expiry')[1].token, 'Expired credential replaced');
  results.expiry = '50ms credential interval replaces bearer before later turn';
  caseName = 'credential-failure';
  const beforeFailure = credentialCalls();
  writeFileSync('/tmp/auth-mode', 'fail');
  await delay(100);
  await turn(client, thread.id);
  assert(credentialCalls() > beforeFailure, 'Proactive refresh attempted');
  assert.equal(inference('credential-failure').length, 1);
  assert.equal(inference('credential-failure')[0].token, inference('expiry')[1].token, 'Failed proactive refresh retains cached token');
  results.cachedCredentialFailure = 'failed proactive renewal uses cached token; fixture still accepts it';
  caseName = '401-failed-renewal'; behavior = 'reject';
  await turn(client, thread.id, 'failed');
  assert.deepEqual(inference('401-failed-renewal').map((call) => call.status), [401], 'Failed renewal never retries rejected inference');
  results.rejectedCredentialFailure = 'one 401, failed renewal, failed turn, no accepted inference';
  await client.stop();
  caseName = 'initial-credential-failure'; behavior = 'reject';
  client = await connect();
  await client.call('thread/resume', { threadId: thread.id, ...threadOptions });
  await turn(client, thread.id, 'failed');
  assert.deepEqual(inference('initial-credential-failure').map((call) => [call.status, call.token]), [[401, undefined]]);
  results.initialCredentialFailure = 'new process sends unauthenticated request; fixture 401 produces failed turn';
  console.log(JSON.stringify({ node: process.versions.node, architecture: process.arch, results,
    credentialCommands: credentialCalls(), inference: calls.filter((call) => call.path === '/v1/responses'),
    metadataRequests: calls.filter((call) => call.path !== '/v1/responses').length }));
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
