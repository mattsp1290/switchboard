import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { admittedPath, resultPath, requestBudget } from './inventory.mjs';

export const accountLogin = (account) => ({ type: 'chatgptAuthTokens', chatgptAccountId: account,
  accessToken: [Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp: 4102444800, email: `${account}@fixture.invalid`,
      'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: `user-${account}`, chatgpt_plan_type: 'plus' } })).toString('base64url'), 'synthetic'].join('.'),
});
export function accountProfile(backendOrigin, modelOrigin) {
  assert.match(backendOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(modelOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(backendOrigin, modelOrigin, 'Routing bootstrap and model origins stay separate');
  return { 'model_providers.fixture.requires_openai_auth': true, chatgpt_base_url: `${backendOrigin}/backend-api` };
}
export function accountRouting(request, response) {
  assert.equal(request.method, 'GET');
  if (request.url === '/backend-api/wham/config/bundle') return response.writeHead(200).end('{}');
  if (request.url === '/backend-api/wham/settings/user') return response.writeHead(200).end(JSON.stringify({ commit_attribution_enabled: false }));
  if (request.url !== '/backend-api/wham/accounts/check') return response.writeHead(404).end();
  const account = ['accountA', 'accountB'].find((account) => request.headers.authorization === `Bearer ${accountLogin(account).accessToken}`);
  assert(account, 'Only synthetic ChatGPT routing credentials');
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accounts: [{
    id: account, workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT',
  }] }));
}

export function replyShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return [...new Map(value.map((item) => {
    const shape = replyShape(item);
    return [JSON.stringify(shape), shape];
  })).values()];
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, replyShape(value[key])]));
}
function noCreator(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!/creator|account|user_?id/i.test(key), `H1 schema falsified by explicit identity field ${key}`);
    noCreator(child);
  }
}
function thread(value, expected) {
  assert.equal(value.id, expected.id);
  assert.equal(value.cwd, expected.cwd);
  assert.equal(value.modelProvider, expected.modelProvider);
  assert.equal(value.source, 'vscode');
  assert.equal(typeof value.sessionId, 'string');
  assert.equal(typeof value.cliVersion, 'string');
  assert(Array.isArray(value.turns));
  assert.equal(value.turns.length, 0, 'Metadata-only read');
}
export async function accountReads({ connect, initialClient, accountLogin, records, root, params, verifySources, inventory, report }) {
  const valid = records.filter((record) => record.name !== 'corrupt');
  assert.deepEqual(valid.map((record) => record.name), ['accountA', 'accountB', 'apiKey']);
  const corrupt = records.find((record) => record.name === 'corrupt');
  assert(corrupt);
  const absent = randomUUID();
  assert(!records.some((record) => record.id === absent));
  report.absentId = absent;
  for (const requester of ['accountA', 'accountB', 'apiKey']) {
    const client = requester === 'accountA' ? initialClient : await connect({ sqlite_home: `/tmp/private-index-${requester}`, log_dir: `/tmp/private-logs-${requester}` });
    const observation = { requester, replies: [], visibility: {}, paths: [], reads: [], failures: [] };
    report.requesters.push(observation);
    const inspectPath = requestBudget(32);
    const rpc = async (method, request, identity = true) => {
      const reply = await client.rpc(method, request);
      assert(reply && typeof reply === 'object' && Number.isInteger(reply.id));
      assert.equal(Object.hasOwn(reply, 'result'), !Object.hasOwn(reply, 'error'), 'Exactly one reply branch');
      observation.replies.push({ method, request, shape: replyShape(reply) });
      if (reply.error) {
        assert(Number.isInteger(reply.error.code));
        assert.equal(typeof reply.error.message, 'string');
      } else if (identity) noCreator(reply.result);
      return reply;
    };
    try {
      const resolved = await client.call('config/read', { includeLayers: false });
      assert.equal(resolved.config.sqlite_home, `/tmp/private-index-${requester}`);
      await client.call('account/logout', {});
      await client.call('account/login/start', requester === 'apiKey'
        ? { type: 'apiKey', apiKey: 'synthetic-discovery-key' } : accountLogin(requester));
      observation.requesterCorrespondence = 'unproved';
      const account = (await rpc('account/read', { refreshToken: false }, false)).result;
      assert(account && typeof account.requiresOpenaiAuth === 'boolean');
      assert(account.account !== null, 'INCONCLUSIVE requester correspondence unavailable from provider account projection');
      assert.equal(account.requiresOpenaiAuth, true);
      assert.equal(account.account?.type, requester === 'apiKey' ? 'apiKey' : 'chatgpt');
      if (requester !== 'apiKey') {
        assert.equal(account.userId, `user-${requester}`);
        assert.equal(account.account.email, `${requester}@fixture.invalid`);
        assert.equal(account.workspaceRouting?.chatgptAccountId, requester);
      } else {
        assert.equal(account.userId, null);
        assert.equal(account.workspaceRouting, null);
      }
      observation.requesterCorrespondence = 'synthetic current login only';
      verifySources(`after ${requester} initialization`);
      const page = async (method, options, validate) => {
        const items = [];
        const cursors = new Set();
        let cursor;
        for (let count = 0; count < 8; count++) {
          const request = { ...options, limit: 1, ...(cursor ? { cursor } : {}) };
          const reply = await rpc(method, request);
          assert(!reply.error, `INCONCLUSIVE ${method} rejected`);
          const result = reply.result;
          assert(Array.isArray(result.data) && result.data.length <= 1);
          assert(result.backwardsCursor === null || typeof result.backwardsCursor === 'string');
          assert(result.nextCursor === null || typeof result.nextCursor === 'string');
          result.data.forEach(validate);
          items.push(...result.data);
          if (result.nextCursor === null) return items;
          assert(result.nextCursor.length > 0 && result.nextCursor.length < 512 && !cursors.has(result.nextCursor));
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        throw new Error(`INCONCLUSIVE ${method} page budget exhausted`);
      };
      for (const currentAccountOnly of [true, false]) {
        const items = await page('thread/list', { ...params, currentAccountOnly }, (item) => {
          const record = valid.find((record) => record.id === item.id);
          assert(record, 'Only valid synthetic fixtures listed');
          thread(item, record);
        });
        const ids = items.map((item) => item.id).sort();
        assert.equal(new Set(ids).size, ids.length);
        const expected = valid.filter((record) => !currentAccountOnly || requester === 'apiKey'
          || record.name === requester || record.name === 'apiKey').map((record) => record.id).sort();
        assert.deepEqual(ids, expected, 'Visibility control must separate A and B');
        observation.visibility[String(currentAccountOnly)] = ids;
      }
      for (const entry of inventory.entries.filter((entry) => entry.candidate)) {
        const path = admittedPath(root, entry.token, inventory.entries);
        const reply = await inspectPath((request) => rpc('getConversationSummary', request), { rolloutPath: path });
        const record = records.find((record) => record.path === entry.token);
        assert(record, 'Inventory path independently selected before manifest assertion');
        if (record.name === 'corrupt') {
          assert(reply.error, 'Malformed native file must produce a failure control');
          observation.failures.push({ kind: 'malformed-path', code: reply.error.code });
        } else {
          const summary = reply.result?.summary;
          assert.equal(summary?.conversationId, record.id);
          assert.equal(summary.source, 'vscode');
          assert.equal(summary.cwd, record.cwd);
          assert.equal(summary.modelProvider, record.modelProvider);
          const association = resultPath(root, summary.path, inventory.entries);
          assert.equal(association.kind, 'contained');
          assert.equal(association.inventoried, true);
          assert.equal(association.token, entry.token, 'Exact inventory-selected summary path');
          observation.paths.push({ token: entry.token, id: summary.conversationId, association });
        }
      }
      assert.equal(observation.paths.length, valid.length);
      for (const record of valid) {
        const metadata = await rpc('thread/read', { threadId: record.id, includeTurns: false });
        assert(!metadata.error, 'H1 read-access falsified or inconclusive, reconcile native source and binary');
        thread(metadata.result.thread, record);
        assert.equal(metadata.result.thread.path, admittedPath(root, record.path, inventory.entries));
        const turns = await page('thread/turns/list', { threadId: record.id, sortDirection: 'asc', itemsView: 'summary' }, (turn) => {
          assert(typeof turn.id === 'string' && turn.id.length > 0);
          assert.equal(turn.itemsView, 'summary');
          assert.equal(turn.status, 'completed');
          assert(Array.isArray(turn.items));
        });
        assert(turns.length > 0, 'INCONCLUSIVE empty saved turns');
        const turnIds = turns.map((turn) => turn.id);
        assert.equal(new Set(turnIds).size, turnIds.length);
        const witness = record.witness;
        assert(witness && witness.startedTurnId === witness.completedTurnId && witness.status === 'completed');
        assert(turnIds.includes(witness.completedTurnId), 'Saved turn matches exact native creation');
        const items = await page('thread/items/list', { threadId: record.id, sortDirection: 'asc' }, (entry) => {
          assert(turnIds.includes(entry.turnId), 'Item belongs to an observed turn');
          assert(typeof entry.item?.id === 'string' && entry.item.id.length > 0);
          assert.equal(typeof entry.item.type, 'string');
        });
        assert(items.some((entry) => entry.item.type === 'userMessage'));
        assert(items.some((entry) => entry.item.type === 'agentMessage'));
        assert.equal(new Set(items.map((entry) => entry.item.id)).size, items.length);
        const saved = items.filter((entry) => entry.turnId === witness.completedTurnId);
        assert(saved.some(({ item }) => item.type === 'userMessage' && item.content?.some((part) => part.type === 'text' && part.text === witness.userText)), 'Exact saved user message');
        assert(saved.some(({ item }) => item.type === 'agentMessage' && item.text === witness.agentText), 'Exact saved assistant message');
        observation.reads.push({ id: record.id, token: record.path, witness, turns: turnIds,
          items: items.map((entry) => ({ turnId: entry.turnId, id: entry.item.id, type: entry.item.type })) });
      }
      for (const [kind, threadId] of [['malformed-id', corrupt.id], ['absent-id', absent]]) {
        const reply = await rpc('thread/read', { threadId, includeTurns: false });
        assert(reply.error, 'Failure control must fail independently of account policy');
        observation.failures.push({ kind, id: threadId, code: reply.error.code });
      }
      verifySources(`after ${requester} requests`);
    } finally {
      await client.stop();
      verifySources(`after ${requester} drained shutdown`);
    }
  }
  report.status = 'controls-passed-pending-lifecycle';
  report.meaning = 'Examined replies expose no creator witness; known-ID reads cross current-account visibility. No authority or coverage claim.';
  return report;
}
