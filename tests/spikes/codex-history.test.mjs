import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

const hook = registerHooks({ resolve(specifier, context, next) {
  if (['node:fs', 'node:http', 'node:child_process'].includes(specifier) && /codex-native\/(discovery|history-copy|inventory|client)\.mjs/.test(context.parentURL)) {
    return { url: new URL('./codex-history-boundary.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
async function discovery({ mode = 'account-reads', sidecars = ['-wal', '-shm'], fault, affected = 'accountA' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'codex-history-'));
  const source = join(work, 'source');
  mkdirSync(join(source, 'sessions'), { recursive: true });
  const records = ['accountA', 'accountB', 'apiKey', 'corrupt'].map((name, index) => ({ name,
    id: `00000000-0000-4000-8000-00000000000${index}`, path: `sessions/${name}.jsonl`, cwd: '/tmp/project', modelProvider: 'fixture',
    witness: { startedTurnId: `turn-${name}`, completedTurnId: `turn-${name}`, status: 'completed', userText: name, agentText: 'synthetic discovery fixture' } }));
  for (const record of records) writeFileSync(join(source, record.path), record.name === 'corrupt' ? '{invalid-json\n' : `opaque ${record.name}`);
  for (const suffix of ['', ...sidecars]) writeFileSync(join(source, `thread_history_1.sqlite${suffix}`), `opaque history ${suffix}`);
  writeFileSync(join(source, 'state_5.sqlite'), 'opaque metadata index');
  const files = [...records.map((record) => record.path), ...readdirSync(source).filter((file) => file.endsWith('.sqlite') || file.includes('.sqlite-'))].sort();
  const hashes = files.map((token) => ({ token, sha256: createHash('sha256').update(readFileSync(join(source, token))).digest('hex') }));
  const inventory = { entries: files.map((token) => ({ token, size: lstatSync(join(source, token)).size, candidate: token.startsWith('sessions/') })), hashes };
  if (fault === 'missing') rmSync(join(source, 'thread_history_1.sqlite'));
  if (fault === 'hash') hashes.find((entry) => entry.token === 'thread_history_1.sqlite').sha256 = '0'.repeat(64);
  if (fault === 'preexisting') mkdirSync(join(work, `private-index-${affected}`));
  if (fault === 'aggregate') inventory.entries.find((entry) => entry.token === 'thread_history_1.sqlite').size = 9 * 1024 * 1024;
  const spawns = [];
  const sent = [];
  const state = { work, records, inventory, fault, affected, port: 12000, copies: [], spawn(_binary, args) {
    const config = Object.fromEntries(args.filter((arg) => arg.includes('=')).map((arg) => [arg.slice(0, arg.indexOf('=')), JSON.parse(arg.slice(arg.indexOf('=') + 1))]));
    spawns.push(config);
    if (!['account-reads', 'prepare-accounts'].includes(mode)) throw new Error('Inert old-mode spawn reached');
    const requester = config.sqlite_home?.split('-').at(-1);
    if (mode === 'account-reads') {
      const directory = join(work, config.sqlite_home.slice('/tmp/'.length));
      assert.deepEqual(readdirSync(directory).sort(), ['', ...sidecars].map((suffix) => `thread_history_1.sqlite${suffix}`).sort());
      for (const file of readdirSync(directory)) assert(readFileSync(join(directory, file)).equals(readFileSync(join(source, file))));
    }
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    let created = 0;
    let active;
    const metadata = (record) => ({ ...record, sessionId: record.id, path: `/root/.codex/${record.path}`, source: 'vscode', cliVersion: '0.169.0', turns: [] });
    child.stdin = new Writable({ write(chunk, _, done) {
      const request = JSON.parse(chunk);
      sent.push(request);
      if (!request.id) { done(); return; }
      const { method, params } = request;
      const record = records.find((record) => record.id === params.threadId);
      let result = {};
      let error;
      if (method === 'config/read') result = { config };
      if (method === 'account/read') result = { requiresOpenaiAuth: true, userId: requester === 'apiKey' ? null : `user-${requester}`,
        account: requester === 'apiKey' ? { type: 'apiKey' } : { type: 'chatgpt', email: `${requester}@fixture.invalid` },
        workspaceRouting: requester === 'apiKey' ? null : { chatgptAccountId: requester } };
      if (method === 'thread/list') {
        const visible = records.slice(0, 3).filter((record) => !params.currentAccountOnly || requester === 'apiKey' || record.name === requester || record.name === 'apiKey');
        const offset = Number(params.cursor ?? 0);
        result = { data: visible.slice(offset, offset + 1).map(metadata), nextCursor: offset + 1 < visible.length ? String(offset + 1) : null, backwardsCursor: null };
      }
      if (method === 'getConversationSummary') {
        const target = records.find((record) => params.rolloutPath.endsWith(record.path));
        if (target.name === 'corrupt') error = { code: -32603, message: 'malformed rollout metadata' };
        else result = { summary: { conversationId: target.id, cwd: target.cwd, modelProvider: target.modelProvider, source: 'vscode', path: params.rolloutPath } };
      }
      if (method === 'thread/read') {
        if (!record || record.name === 'corrupt') error = { code: -32603, message: 'generic failure' };
        else result = { thread: metadata(record) };
      }
      if (method === 'thread/turns/list') result = { data: [{ id: record.witness.completedTurnId, status: 'completed', itemsView: 'summary', items: [] }], nextCursor: null, backwardsCursor: null };
      if (method === 'thread/items/list') result = { data: [{ turnId: record.witness.completedTurnId,
        item: params.cursor ? { id: 'agent', type: 'agentMessage', text: record.witness.agentText }
          : { id: 'user', type: 'userMessage', content: [{ type: 'text', text: record.witness.userText }] } }], nextCursor: params.cursor ? null : 'next', backwardsCursor: null };
      if (method === 'thread/start') { active = records[created++]; result = { thread: metadata(active) }; }
      if (method === 'turn/start') result = { turn: { id: active.witness.startedTurnId } };
      child.stdout.write(`${JSON.stringify({ id: request.id, ...(error ? { error } : { result }) })}\n`);
      if (method === 'turn/start') child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: active.id, turn: { id: active.witness.completedTurnId, status: 'completed' } } })}\n`);
      done();
    } });
    child.kill = (signal) => { child.signalCode = signal; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close'); }); return true; };
    return child;
  } };
  const saved = { argv: process.argv, exitCode: process.exitCode, log: console.log, write: process.stderr.write };
  const output = [];
  try {
    globalThis.codexHistory = state;
    process.argv = [process.execPath, 'discovery.mjs', mode];
    process.exitCode = undefined;
    console.log = (value) => output.push(JSON.parse(value));
    process.stderr.write = () => true;
    await import(`../../spikes/codex-native/discovery.mjs?cold=${randomUUID()}`);
    return { report: output[0], code: process.exitCode ?? 0, spawns, copies: state.copies, sent,
      originals: files.filter((file) => file !== 'thread_history_1.sqlite' || fault !== 'missing').map((file) => ({ token: file, sha256: createHash('sha256').update(readFileSync(join(source, file))).digest('hex') })), hashes };
  } finally {
    process.argv = saved.argv; process.exitCode = saved.exitCode; console.log = saved.log; process.stderr.write = saved.write;
    delete globalThis.codexHistory;
    rmSync(work, { recursive: true, force: true });
  }
}
test('actual discovery cold-copies the exact family before A, B, and API-key spawn', async () => {
  for (const sidecars of [[], ['-wal'], ['-shm'], ['-wal', '-shm']]) {
    const result = await discovery({ sidecars });
    assert.equal(result.code, 0);
    assert.equal(result.report.accounts.status, 'negative-public-read-result');
    assert.deepEqual(result.report.copies.map((copy) => copy.requester), ['accountA', 'accountB', 'apiKey']);
    assert(result.report.copies.every((copy) => copy.status === 'complete-before-spawn'));
    assert.equal(new Set(result.report.copies.flatMap((copy) => copy.files.map((file) => file.inode))).size, 3 * (1 + sidecars.length));
    assert.deepEqual(result.spawns.map((config) => config.sqlite_home), result.report.copies.map((copy) => copy.destination));
    assert.deepEqual(result.originals, result.hashes);
    assert.equal(result.report.inferenceRequests, 0);
    assert(!result.sent.some((request) => /resume|turn\/start|persist/.test(request.method)));
    assert(result.report.preservation.includes('after final shutdown attempts'));
  }
});
test('actual discovery refuses incomplete, changed, aliased, unsupported, or excessive cold copies before affected spawn', async () => {
  for (const fault of ['missing', 'hash', 'preexisting', 'copy', 'sidecar', 'missing-sidecar', 'alias', 'alias-reader', 'partial', 'destination-hash', 'injected', 'changed', 'aggregate']) {
    for (const affected of ['accountA', 'accountB', 'apiKey']) {
      const result = await discovery({ fault, affected });
      assert.equal(result.code, 1, `${fault} ${affected}`);
      const expected = ['missing', 'hash'].includes(fault) ? 0 : fault === 'aggregate' ? 2 : ['accountA', 'accountB', 'apiKey'].indexOf(affected);
      assert.equal(result.spawns.length, expected, `${fault} ${affected}`);
      assert.notEqual(result.report.accounts?.status, 'negative-public-read-result');
      assert.equal(result.report.inferenceRequests, 0);
      if (fault !== 'changed' && fault !== 'hash') assert.deepEqual(result.originals, result.hashes.filter((entry) => fault !== 'missing' || entry.token !== 'thread_history_1.sqlite'));
    }
  }
  const journal = await discovery({ sidecars: ['-journal'] });
  assert.equal(journal.code, 1);
  assert.equal(journal.spawns.length, 0);
});
test('actual preparation exports exact native turn witnesses and older modes bypass cold copies', async () => {
  const prepared = await discovery({ mode: 'prepare-accounts' });
  assert.equal(prepared.code, 0);
  assert.equal(prepared.copies.length, 0);
  assert.deepEqual(prepared.report.records.map((record) => record.witness), ['accountA', 'accountB', 'apiKey', 'corrupt'].map((name) => ({
    startedTurnId: `turn-${name}`, completedTurnId: `turn-${name}`, status: 'completed', userText: name, agentText: 'synthetic discovery fixture',
  })));
  for (const mode of ['prepare', 'indexed', 'unindexed', 'malformed', 'inaccessible', 'symlink']) {
    const result = await discovery({ mode });
    assert.equal(result.spawns.length, 1);
    assert.equal(result.copies.length, 0);
    assert.match(result.report.failure.message, /Inert old-mode spawn reached/);
  }
  hook.deregister();
});
