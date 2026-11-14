import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:fs' && context.parentURL.endsWith('/codex-native/inventory.mjs')) {
    return { url: new URL('./codex-account-fs.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { accountReads, replyShape, accountLogin, accountProfile, accountRouting } = await import('../../spikes/codex-native/account-reads.mjs');
hook.deregister();
const records = ['accountA', 'accountB', 'apiKey', 'corrupt'].map((name, index) => ({
  name, id: `00000000-0000-4000-8000-00000000000${index}`, path: `sessions/${name}`, cwd: '/tmp/project', modelProvider: 'fixture',
  witness: { startedTurnId: `turn-${name}`, completedTurnId: `turn-${name}`, status: 'completed', userText: name, agentText: 'synthetic discovery fixture' },
}));
const inventory = { entries: records.map(({ path }) => ({ token: path, candidate: true })) };
function experiment(fault) {
  const calls = [];
  const stopped = [];
  const report = { hypothesis: 'H1', status: 'inconclusive', requesters: [] };
  function connect(requester) {
    let sequence = 0;
    const metadata = (record) => ({ ...record, sessionId: record.id, path: `/synthetic/history/${record.path}`, source: 'vscode', cliVersion: '0.169.0', turns: [] });
    return { stop: async () => { stopped.push(requester); }, call: async (method) => {
      calls.push(method);
      return method === 'config/read' ? { config: { sqlite_home: `/tmp/private-index-${requester}` } } : {};
    }, rpc: async (method, request) => {
      calls.push(method);
      let result;
      const record = records.find((record) => record.id === request.threadId);
      if (method === 'account/read') result = { userId: requester === 'apiKey' ? null : `user-${requester}`, requiresOpenaiAuth: true,
        account: requester === 'apiKey' ? { type: 'apiKey' } : { type: 'chatgpt', email: `${requester}@fixture.invalid` },
        workspaceRouting: requester === 'apiKey' ? null : { chatgptAccountId: fault === 'workspace' ? 'other' : requester } };
      if (method === 'account/read' && fault === 'user') result.userId = 'other';
      if (method === 'account/read' && fault === 'null-account') result = { account: null, userId: null, requiresOpenaiAuth: false, workspaceRouting: null };
      if (method === 'thread/list') {
        const visible = records.slice(0, 3).filter((record) => !request.currentAccountOnly || requester === 'apiKey' || record.name === requester || record.name === 'apiKey');
        const offset = Number(request.cursor ?? 0);
        result = { data: visible.slice(offset, offset + 1).map(metadata), nextCursor: offset + 1 < visible.length ? String(offset + 1) : null, backwardsCursor: null };
      }
      if (method === 'getConversationSummary') {
        const record = records.find((record) => request.rolloutPath.endsWith(record.path));
        if (record.name === 'corrupt') return { id: ++sequence, error: { code: -32603, message: 'generic failure' } };
        result = { summary: { conversationId: record.id, source: 'vscode', cwd: record.cwd, modelProvider: record.modelProvider,
          path: fault === 'path' ? '/synthetic/history/sessions/accountB' : request.rolloutPath } };
      }
      if (method === 'thread/read') {
        if (!record || record.name === 'corrupt' || fault === 'reject') return { id: ++sequence, error: { code: -32600, message: 'generic failure' } };
        result = { thread: metadata(record) };
        if (fault === 'creator') result.thread.creatorAccountId = 'synthetic';
      }
      if (method === 'thread/turns/list') result = { data: fault === 'empty' ? [] : [{
        id: fault === 'turn' || (fault === 'message-turn' && request.cursor) ? 'older-turn' : record.witness.completedTurnId,
        itemsView: 'summary', status: 'completed', items: [] }],
        nextCursor: fault === 'cursor' ? 'same' : fault === 'message-turn' && !request.cursor ? 'older' : null, backwardsCursor: null };
      if (method === 'thread/items/list') {
        const agent = Boolean(request.cursor);
        result = { data: [{ turnId: fault === 'association' ? 'other' : fault === 'message-turn' ? 'older-turn' : record.witness.completedTurnId,
          item: { id: fault === 'item-id' ? 'same' : agent ? `agent-${request.cursor}` : 'user', type: agent ? 'agentMessage' : 'userMessage',
            text: fault === 'agent-message' ? 'unrelated reply' : record.witness.agentText,
            content: [{ type: 'text', text: fault === 'user-message' ? 'unrelated prompt' : record.witness.userText }] } }],
          nextCursor: fault === 'pages' ? String(Number(request.cursor ?? 0) + 1) : agent ? null : 'next', backwardsCursor: null };
        if (fault === 'page-error') return { id: ++sequence, error: { code: -32603, message: 'generic page failure' } };
      }
      return { id: ++sequence, result };
    } };
  }
  return { report, calls, stopped, run: () => accountReads({ records, inventory, report, root: '/synthetic/history', params: {},
    accountLogin: (account) => ({ type: 'chatgptAuthTokens', chatgptAccountId: account }), verifySources: () => {},
    initialClient: connect('accountA'), connect: async (config) => connect(config.sqlite_home.split('-').at(-1)) }) };
}
test('actual account experiment separates visibility from known-ID read success', async () => {
  const fixture = experiment();
  await fixture.run();
  assert.equal(fixture.report.status, 'controls-passed-pending-lifecycle');
  const b = fixture.report.requesters[1];
  assert(!b.visibility.true.includes(records[0].id));
  assert(b.reads.some((read) => read.id === records[0].id));
  assert.deepEqual(b.failures.map((failure) => failure.kind), ['malformed-path', 'malformed-id', 'absent-id']);
  assert.deepEqual(fixture.stopped, ['accountA', 'accountB', 'apiKey']);
  assert(!fixture.calls.some((method) => /resume|turn\/start/.test(method)));
  assert.equal(JSON.stringify(replyShape({ accessToken: 'do-not-retain' })).includes('do-not-retain'), false);
});
test('actual account experiment retains partial inconclusive evidence on rejected or empty reads and rejects creator fields', async () => {
  for (const fault of ['reject', 'empty', 'creator', 'association', 'workspace', 'user', 'turn', 'user-message', 'agent-message',
    'item-id', 'cursor', 'pages', 'page-error', 'path', 'message-turn']) {
    const fixture = experiment(fault);
    await assert.rejects(fixture.run());
    assert.equal(fixture.report.status, 'inconclusive');
    assert(fixture.report.requesters[0].replies.length > 0);
    assert.deepEqual(fixture.stopped, ['accountA']);
  }
});
test('actual account experiment leaves the real custom-provider null reply inconclusive', async () => {
  const fixture = experiment('null-account');
  await assert.rejects(fixture.run(), /INCONCLUSIVE requester correspondence/);
  assert.equal(fixture.report.status, 'inconclusive');
  assert.equal(fixture.report.requesters[0].requesterCorrespondence, 'unproved');
  assert(!fixture.calls.includes('thread/list'));
  assert.deepEqual(fixture.stopped, ['accountA']);
});
test('actual H1 profile and routing handler keep auth discovery on a separate synthetic endpoint', () => {
  assert.deepEqual(accountProfile('http://127.0.0.1:1234', 'http://127.0.0.1:5678'), {
    'model_providers.fixture.requires_openai_auth': true, chatgpt_base_url: 'http://127.0.0.1:1234/backend-api',
  });
  for (const account of ['accountA', 'accountB']) {
    const request = { method: 'GET', url: '/backend-api/wham/accounts/check', headers: { authorization: `Bearer ${accountLogin(account).accessToken}` } };
    const response = { writeHead(code) { assert.equal(code, 200); return this; }, end(body) {
      assert.deepEqual(JSON.parse(body).accounts, [{ id: account, workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT' }]);
    } };
    accountRouting(request, response);
    assert.throws(() => accountRouting({ ...request, headers: {} }, response));
  }
  assert.throws(() => accountProfile('https://chatgpt.com'));
  assert.throws(() => accountProfile('http://127.0.0.1:1234', 'http://127.0.0.1:1234'));
  for (const path of ['config/bundle', 'settings/user', 'unexpected']) {
    let code;
    let body;
    accountRouting({ method: 'GET', url: `/backend-api/wham/${path}` }, { writeHead(value) { code = value; return this; }, end(value) { body = value; } });
    assert.equal(code, path === 'unexpected' ? 404 : 200);
    if (code === 200) assert.deepEqual(JSON.parse(body), path === 'config/bundle' ? {} : { commit_attribution_enabled: false });
  }
});
