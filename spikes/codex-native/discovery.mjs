import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { admittedPath, resultPath, requestBudget } from './inventory.mjs';
import { nativeClient } from './client.mjs';

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
  if (mode !== 'prepare') { inference++; response.writeHead(403).end('Inspection inference refused'); return; }
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
const clients = [];
const evidence = { mode };
let progressBytes = 0;
function retainProgress(observation) {
  const line = `${JSON.stringify(observation)}\n`;
  const bytes = Buffer.byteLength(line);
  if (progressBytes + bytes > 512 * 1024) { evidence.progressTruncated = true; return; }
  progressBytes += bytes;
  process.stderr.write(line);
}
let verifySources;
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
  const client = nativeClient({ ...config, ...overrides }, retainProgress);
  clients.push(client);
  evidence.transcript = client.transcript;
  evidence.notifications = client.events;
  await client.call('initialize', { clientInfo: { name: 'switchboard_discovery_fixture', version: '0' }, capabilities: { experimentalApi: true } });
  client.initialized();
  return client;
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
    const request = { ...params, ...overrides, cursor };
    const reply = await client.rpc('thread/list', request);
    assert(!reply.error, JSON.stringify(reply));
    if (mode === 'malformed') listing.push({ params: request, reply });
    const result = reply.result;
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
async function pathObservations(client, records) {
  const inventory = JSON.parse(readFileSync('/opt/inventory.json', 'utf8'));
  const report = { inventory, files: [], negativeControls: [], listing: [], enumeration: 'in-progress' };
  evidence.pathInspection = report;
  retainProgress({ admittedInventory: inventory });
  const dispatch = requestBudget(32);
  for (const entry of inventory.entries.filter((entry) => entry.candidate)) {
    const path = admittedPath(root, entry.token, inventory.entries);
    const request = { rolloutPath: path };
    const reply = await dispatch((params) => client.rpc('getConversationSummary', params), request);
    report.files.push({ token: entry.token, request, reply,
      outcome: reply.error ? { kind: 'native-failure' } : { kind: 'summary', path: resultPath(root, reply.result?.summary?.path, inventory.entries) } });
  }
  report.enumeration = 'exhausted';
  for (const token of ['sessions/missing-negative-control', 'sessions']) {
    const request = { rolloutPath: admittedPath(root, token, inventory.entries, true) };
    const reply = await dispatch((params) => client.rpc('getConversationSummary', params), request);
    report.negativeControls.push({ token, request, reply });
  }
  for (const archived of [false, true]) {
    const context = { archived, pages: [], termination: 'truncated', reason: 'page-budget' };
    report.listing.push(context);
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 8; page++) {
      const request = { limit: 2, sourceKinds: sources, modelProviders: [], archived, currentAccountOnly: false,
        sortKey: 'created_at', sortDirection: 'desc', useStateDbOnly: false, ...(cursor ? { cursor } : {}) };
      const reply = await client.rpc('thread/list', request);
      const paths = (reply.result?.data ?? []).map((item) => ({ id: item.id, path: resultPath(root, item.path, inventory.entries) }));
      context.pages.push({ request, reply, paths });
      if (reply.error) { context.termination = 'native-failure'; delete context.reason; break; }
      assert(reply.result.data.length <= 2, 'Broad listing respects page size');
      const next = reply.result.nextCursor;
      if (!next) { context.termination = 'exhausted'; delete context.reason; break; }
      if (typeof next !== 'string' || next.length >= 512 || cursors.has(next)) {
        context.termination = 'cursor-refused'; context.reason = 'invalid-or-repeated'; break;
      }
      cursors.add(next);
      cursor = next;
    }
  }
  report.uniqueNativeIds = [...new Set(report.files.flatMap((file) => file.reply.result?.summary?.conversationId ?? []))];
  report.expected = records.filter((record) => record.name !== 'unauthorized').map(({ name, id, path }) => ({ name, id, token: path }));
  assert.deepEqual(report.files.map((file) => file.token), inventory.entries.filter((entry) => entry.candidate).map((entry) => entry.token));
  for (const file of [...report.files, ...report.negativeControls]) {
    assert.deepEqual(Object.keys(file.request), ['rolloutPath'], 'Path inspection never supplies a manifest ID');
  }
  for (const record of records.filter((record) => record.name !== 'unauthorized')) {
    const file = report.files.find((file) => file.token === record.path);
    assert(file, 'Every expected native fixture has an inventoried observation');
    if (mode === 'malformed' && record.name === 'first') {
      assert.equal(file.reply.error?.code, -32603);
      assert(file.reply.error.message.includes(file.request.rolloutPath), 'Malformed unknown-ID failure identifies the requested path');
      assert.equal(file.outcome.kind, 'native-failure');
    } else {
      assert.equal(file.reply.result?.summary.conversationId, record.id);
      assert.equal(file.reply.result.summary.cwd, record.cwd);
      assert.equal(file.reply.result.summary.modelProvider, record.modelProvider);
      assert.equal(file.outcome.path.kind, 'contained');
      assert.equal(file.outcome.path.inventoried, true);
    }
  }
  const auxiliary = report.files.find((file) => file.token === 'sessions/fixture-notes.txt');
  assert.equal(auxiliary.reply.error?.code, -32603, 'Auxiliary failure remains an unclassified file failure');
  const alias = report.files.find((file) => file.token === 'sessions/hardlink-alias.opaque');
  assert.equal(alias.reply.result?.summary.conversationId, records.find((record) => record.name === 'second').id);
  assert.equal(alias.outcome.path.kind, 'contained');
  assert.equal(report.uniqueNativeIds.length, mode === 'malformed' ? 6 : 7);
  for (const negative of report.negativeControls) assert.equal(negative.reply.error?.code, -32600);
  for (const context of report.listing) {
    assert.equal(context.termination, 'exhausted', 'Broad ordinary listing exhausted within its page budget');
    for (const page of context.pages) assert(page.paths.every((item) => item.path.kind === 'contained'));
  }
  return report;
}
const listing = [];
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
    evidence.sourceHashes = before;
    evidence.preservation = [];
    verifySources = (stage) => {
      assert.deepEqual(sourceFiles(), protectedFiles, `Source file set preserved at ${stage}`);
      assert.deepEqual(snapshot(protectedFiles), before, `Source bytes preserved at ${stage}`);
      evidence.preservation.push(stage);
      retainProgress({ sourcePreservation: stage, hashes: before });
    };
    verifySources('before startup');
    assert.throws(() => writeFileSync(`${root}/sessions/write-probe`, 'fixture'), (error) => ['EROFS', 'ENOTDIR'].includes(error.code));
    const client = await connect({ sqlite_home: '/tmp/private-index', log_dir: '/tmp/private-logs' });
    verifySources('after initialization');
    const resolved = await client.call('config/read', { includeLayers: false });
    assert.equal(resolved.config.sqlite_home, '/tmp/private-index');
    const expected = (names) => records.filter((record) => names.includes(record.name)).map((record) => record.id).sort();
    const ids = (items) => items.map((item) => item.id).sort();
    const report = Object.assign(evidence, { sourceFiles: protectedFiles.length, sqliteHome: resolved.config.sqlite_home });
    if (['indexed', 'unindexed', 'malformed'].includes(mode)) report.pathInspection = await pathObservations(client, records);
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
      if (mode === 'malformed') {
        const targets = [
          { kind: 'valid', threadId: expected(['second'])[0] },
          { kind: 'corrupt', threadId: expected(['first'])[0] },
          { kind: 'absent', threadId: randomUUID() },
        ];
        assert(targets.every((target) => target.threadId));
        assert(!records.some((record) => record.id === targets[2].threadId));
        report.inspection = [];
        for (const { kind, threadId } of targets) {
          const params = { threadId, includeTurns: true };
          report.inspection.push({ kind, params, reply: await client.rpc('thread/read', params) });
        }
        const [valid, corrupt, absent] = report.inspection;
        assert.equal(valid.reply.result?.thread.id, targets[0].threadId);
        assert(Array.isArray(valid.reply.result.thread.turns));
        assert.equal(corrupt.reply.error?.code, -32603);
        assert.match(corrupt.reply.error.message, /failed to read session metadata.*rollout.*is empty/);
        assert.equal(absent.reply.error?.code, -32600);
        assert.equal(absent.reply.error.message, `thread not loaded: ${targets[2].threadId}`);
        for (const { reply } of listing) assert.deepEqual(Object.keys(reply.result).sort(),
          ['backwardsCursor', 'data', 'nextCursor', 'readStates']);
        report.listing = listing;
        report.coverage = 'Malformed rollout omitted; raw metadata and notifications retained for inspection';
      }
      if (mode === 'symlink') report.scope = 'File and directory symlinks excluded by native enumeration';
    }
    verifySources('after requests');
    await client.stop();
    if (mode === 'malformed') {
      report.notifications = client.events;
      const corruptId = report.inspection.find((target) => target.kind === 'corrupt').params.threadId;
      assert(!JSON.stringify(client.events).includes(corruptId), 'Notifications do not identify omitted corrupt target');
    }
    verifySources('after drained shutdown');
    assert.equal(inference, 0);
    report.preservationSummary = 'read-only history and every original SQLite file unchanged at startup, listing, shutdown';
    report.inferenceRequests = inference;
    console.log(JSON.stringify(report));
  }
} catch (error) {
  if (evidence.pathInspection?.enumeration === 'in-progress') evidence.pathInspection.enumeration = 'failed';
  evidence.failure = { message: error.message, stack: error.stack };
  for (const client of clients) {
    try { await client.stop(); } catch (shutdown) { evidence.shutdownFailure = shutdown.message; }
  }
  try { verifySources?.('after failed drained shutdown'); } catch (preservation) { evidence.preservationFailure = preservation.message; }
  evidence.inferenceRequests = inference;
  console.log(JSON.stringify(evidence));
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
