import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const mode = process.argv[2];
assert(['prepare', 'indexed', 'unindexed', 'malformed', 'inaccessible', 'symlink'].includes(mode));
const root = '/root/.codex';
for (const cwd of ['/tmp/project', '/tmp/other']) mkdirSync(cwd);
let inference = 0;
let requests = 0;
const server = createServer(async (request, response) => {
  assert(++requests <= 30, 'Bounded fixture request count');
  let body = '';
  for await (const chunk of request) { body += chunk; assert(body.length < 1024 * 1024); }
  if (request.method === 'GET' && request.url.startsWith('/v1/models?')) { response.writeHead(404).end(); return; }
  assert.equal(mode, 'prepare', 'Discovery never dispatches inference');
  assert.equal(request.url, '/v1/responses');
  assert.equal(request.method, 'POST');
  assert.equal(JSON.parse(body).stream, true);
  const id = `resp_${++inference}`;
  const item = { type: 'message', id: `msg_${inference}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'synthetic discovery fixture', annotations: [] }] };
  const emit = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit({ type: 'response.created', response: { id, status: 'in_progress' } });
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { id, status: 'completed', output: [item] } });
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const config = { model_provider: 'fixture', model: 'fixture-model', check_for_update_on_startup: false, 'analytics.enabled': false, 'features.apps': false };
for (const provider of ['fixture', 'other']) Object.assign(config, {
  [`model_providers.${provider}.name`]: provider,
  [`model_providers.${provider}.base_url`]: `http://127.0.0.1:${server.address().port}/v1`,
  [`model_providers.${provider}.wire_api`]: 'responses',
  [`model_providers.${provider}.supports_websockets`]: false,
  [`model_providers.${provider}.request_max_retries`]: 0,
  [`model_providers.${provider}.stream_max_retries`]: 0,
});
const children = [];
const accountLogin = (account) => ({ type: 'chatgptAuthTokens', chatgptAccountId: account,
  accessToken: [Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp: 4102444800, email: `${account}@fixture.invalid`,
      'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: `user-${account}`, chatgpt_plan_type: 'plus' } })).toString('base64url'), 'synthetic'].join('.'),
});
async function until(predicate, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}
async function connect(overrides = {}) {
  const args = Object.entries({ ...config, ...overrides }).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  const child = spawn('/opt/codex', ['app-server', ...args], { cwd: '/tmp/project', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  children.push(child);
  const events = [];
  const replies = new Map();
  let sequence = 0;
  let bytes = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on('data', (chunk) => { bytes += chunk.length; assert(bytes < 2 * 1024 * 1024); });
  const lines = createInterface({ input: child.stdout });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  lines.on('line', (line) => {
    const value = JSON.parse(line);
    if (Object.hasOwn(value, 'id') && !value.method) replies.set(value.id, value);
    else { assert(!Object.hasOwn(value, 'id'), 'No server requests during synthetic discovery'); events.push(value); }
  });
  const rpc = async (method, params) => {
    assert(++sequence <= 80, 'Bounded protocol request count');
    const id = sequence;
    send({ id, method, params });
    return until(() => { assert(child.exitCode === null && child.signalCode === null, stderr); return replies.get(id); }, method);
  };
  const call = async (method, params) => { const reply = await rpc(method, params); assert(!reply.error, JSON.stringify(reply)); return reply.result; };
  await call('initialize', { clientInfo: { name: 'switchboard_discovery_fixture', version: '0' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized' });
  return { events, call, rpc, stop: async () => {
    child.kill('SIGTERM');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'Native shutdown');
    lines.close();
  } };
}
function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...filesUnder(`${directory}/${entry.name}`).map((file) => `${entry.name}/${file}`));
    else files.push(entry.name);
  }
  return files.sort();
}
function sourceFiles() {
  return readdirSync(root).filter((file) => (file === 'sessions' && lstatSync(`${root}/${file}`).isFile()) || /\.sqlite(?:-(?:wal|shm))?$/.test(file))
    .concat(['sessions', 'archived_sessions'].flatMap((dir) => filesUnder(`${root}/${dir}`).map((file) => `${dir}/${file}`))).sort();
}
function snapshot(files) {
  return Object.fromEntries(files.map((file) => [file, lstatSync(`${root}/${file}`).isSymbolicLink()
    ? `symlink:${readlinkSync(`${root}/${file}`)}` : createHash('sha256').update(readFileSync(`${root}/${file}`)).digest('hex')]));
}
const sources = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const params = { limit: 1, sourceKinds: sources, modelProviders: ['fixture'], cwd: '/tmp/project', archived: false,
  currentAccountOnly: true, sortKey: 'created_at', sortDirection: 'desc', useStateDbOnly: false };
async function pages(client, overrides = {}) {
  const items = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 8; page++) {
    const result = await client.call('thread/list', { ...params, ...overrides, cursor });
    assert(result.data.length <= 1, 'Native respects page size');
    items.push(...result.data);
    if (!result.nextCursor) { assert.equal(new Set(items.map((item) => item.id)).size, items.length); return items; }
    assert(!cursors.has(result.nextCursor), 'Native cursor advances');
    assert(result.nextCursor.length < 512);
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Discovery page budget exceeded');
}
try {
  if (mode === 'prepare') {
    const client = await connect();
    const records = [];
    for (const [name, cwd, modelProvider, account] of [
      ['first', '/tmp/project', 'fixture'], ['second', '/tmp/project', 'fixture'],
      ['otherCwd', '/tmp/other', 'fixture'], ['otherProvider', '/tmp/project', 'other'],
      ['archived', '/tmp/project', 'fixture'], ['unauthorized', '/tmp/project', 'fixture'],
      ['accountA', '/tmp/project', 'fixture', 'accountA'], ['accountB', '/tmp/project', 'fixture', 'accountB'],
    ]) {
      if (account) await client.call('account/login/start', accountLogin(account));
      const { thread } = await client.call('thread/start', { cwd, modelProvider, approvalPolicy: 'never', sandbox: 'read-only' });
      const { turn } = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: name, text_elements: [] }] });
      const completed = await until(() => client.events.find((event) => event.method === 'turn/completed' && event.params.turn.id === turn.id), name);
      assert.equal(completed.params.turn.status, 'completed');
      let path = thread.path;
      if (name === 'archived') {
        await client.call('thread/archive', { threadId: thread.id });
        const archived = await client.call('thread/list', { ...params, archived: true });
        path = archived.data.find((item) => item.id === thread.id)?.path;
      }
      assert(path?.startsWith(`${root}/`), 'Native-returned path is inside the synthetic home');
      records.push({ name, id: thread.id, cwd, modelProvider, path: path.slice(root.length + 1) });
    }
    await client.stop();
    const files = sourceFiles();
    for (const record of records) assert(files.includes(record.path), 'Native persisted its returned fixture path');
    assert(files.some((file) => file.startsWith('state_')));
    assert(files.some((file) => file.startsWith('thread_history_')));
    console.log(JSON.stringify({ records, files: Object.fromEntries(files.map((file) => [file, readFileSync(`${root}/${file}`).toString('base64')])) }));
  } else {
    const records = JSON.parse(readFileSync('/opt/records.json', 'utf8'));
    const authorized = records.filter((record) => record.name !== 'unauthorized');
    const protectedFiles = sourceFiles();
    const before = snapshot(protectedFiles);
    assert.throws(() => writeFileSync(`${root}/sessions/write-probe`, 'fixture'), (error) => ['EROFS', 'ENOTDIR'].includes(error.code));
    const client = await connect({ sqlite_home: '/tmp/private-index', log_dir: '/tmp/private-logs' });
    assert.deepEqual(snapshot(protectedFiles), before, 'Source preserved through startup');
    const resolved = await client.call('config/read', { includeLayers: false });
    assert.equal(resolved.config.sqlite_home, '/tmp/private-index');
    const expected = (names) => records.filter((record) => names.includes(record.name)).map((record) => record.id).sort();
    const ids = (items) => items.map((item) => item.id).sort();
    const report = { mode, sourceFiles: protectedFiles.length, sqliteHome: resolved.config.sqlite_home };
    if (mode === 'inaccessible') {
      const reply = await client.rpc('thread/list', params);
      assert.equal(reply.error?.code, -32603);
      assert.match(reply.error.message, /Not a directory/);
      report.failure = reply.error;
    } else {
      const dbAtStartup = await pages(client, { useStateDbOnly: true });
      const visible = await pages(client);
      assert.deepEqual(ids(dbAtStartup), ids(visible), 'Startup backfill populates private cache before scan listing');
      assert.deepEqual(ids(visible), expected(mode === 'malformed' ? ['second'] : ['first', 'second']));
      assert(visible.every((item) => item.source === 'vscode'));
      assert.deepEqual(ids(await pages(client, { useStateDbOnly: true })), ids(visible), 'Private cache serves indexed discovery');
      assert.deepEqual(ids(await pages(client, { currentAccountOnly: false })), [...ids(visible), ...expected(['accountA', 'accountB'])].sort());
      for (const filter of [{ sourceKinds: ['appServer'] }, { modelProviders: ['absent'] }, { cwd: '/tmp/project/child' }]) {
        assert.deepEqual(await pages(client, filter), [], 'Explicit exclusion filter');
      }
      assert.deepEqual(ids(await pages(client, { cwd: '/tmp/other' })), expected(['otherCwd']));
      assert.deepEqual(ids(await pages(client, { modelProviders: ['other'] })), expected(['otherProvider']));
      assert.deepEqual(ids(await pages(client, { archived: true })), expected(['archived']));
      const all = await pages(client, { modelProviders: [], cwd: null });
      assert(!ids(all).includes(expected(['unauthorized'])[0]), 'Outside native root is not discovered');
      assert(all.every((item) => authorized.some((record) => record.id === item.id)));
      for (const filter of [{ cursor: 'not-a-native-cursor' }, { sourceKinds: ['invalid-source'] }, { excludedThreadIds: ['invalid-id'] }]) {
        const reply = await client.rpc('thread/list', { ...params, ...filter });
        assert(reply.error, 'Malformed public input fails explicitly');
      }
      for (const account of ['accountA', 'accountB']) {
        await client.call('account/login/start', accountLogin(account));
        assert.deepEqual(ids(await pages(client)), [...ids(visible), ...expected([account])].sort(), 'Synthetic account plus shared history');
      }
      await client.call('account/logout', {});
      await client.call('account/login/start', { type: 'apiKey', apiKey: 'synthetic-discovery-key' });
      assert.deepEqual(ids(await pages(client)), [...ids(visible), ...expected(['accountA', 'accountB'])].sort(), 'API key sees all accounts');
      report.visible = ids(visible);
      report.filters = 'source, provider, exact cwd, archive, two synthetic accounts, shared history, API key visibility';
      report.pagination = 'one item per page, unique IDs and cursors, at most eight pages';
      report.malformedRequests = 'cursor, source enum, thread ID rejected';
      if (mode === 'malformed') report.coverage = 'Malformed rollout omitted without structured coverage warning';
      if (mode === 'symlink') report.scope = 'File and directory symlinks excluded by native enumeration';
    }
    assert.deepEqual(snapshot(protectedFiles), before, 'Source preserved through listing');
    await client.stop();
    assert.deepEqual(sourceFiles(), protectedFiles, 'No source files added or removed');
    assert.deepEqual(snapshot(protectedFiles), before, 'Source preserved through shutdown');
    assert.equal(inference, 0);
    report.preservation = 'read-only history and every original SQLite file unchanged at startup, listing, shutdown';
    report.inferenceRequests = inference;
    console.log(JSON.stringify(report));
  }
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
