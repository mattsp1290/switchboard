import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as real from 'node:fs';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  utimesSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { clientWireSource } from './codex-wire-source.mjs';

const hook = registerHooks({ resolve(specifier, context, next) {
  const wire = clientWireSource(specifier, context);
  if (wire) return wire;
  if (['node:fs', 'node:http', 'node:child_process'].includes(specifier) && /codex-native\/(discovery|history-copy|inventory|client)\.mjs/.test(context.parentURL)) {
    return { url: new URL('./codex-history-boundary.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { SELECTORS, compareFile, inventoryOf, limits, observeSource, verifySource } = await import('../../spikes/codex-native/inventory.mjs');
function nativeChild(respond) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.stdin = new Writable({ write(chunk, _, done) { respond(JSON.parse(chunk), child.stdout); done(); } });
  child.stdout.once('end', () => { child.stderr.end(); setImmediate(() => child.emit('close')); });
  child.kill = (signal) => {
    child.signalCode = signal;
    setImmediate(() => { if (!child.stdout.writableEnded) child.stdout.end(); });
    return true;
  };
  return child;
}
const flooding = (out, count) => {
  for (let index = 0; index < count; index++) out.write(`${JSON.stringify({ method: 'fixture/flood', params: { index, pad: 'x'.repeat(1024) } })}\n`);
};
async function entry(mode, state, args = []) {
  const saved = { argv: process.argv, exitCode: process.exitCode, log: console.log, write: process.stderr.write };
  const output = [];
  const progress = [];
  try {
    globalThis.codexHistory = state;
    process.argv = [process.execPath, 'discovery.mjs', mode, ...args];
    process.exitCode = undefined;
    console.log = (value) => output.push(JSON.parse(value));
    process.stderr.write = (line) => { progress.push(String(line)); return true; };
    await import(`../../spikes/codex-native/discovery.mjs?run=${randomUUID()}`);
    return { report: output[0], code: process.exitCode ?? 0, progress };
  } finally {
    process.argv = saved.argv; process.exitCode = saved.exitCode; console.log = saved.log; process.stderr.write = saved.write;
    delete globalThis.codexHistory;
  }
}
async function discovery({ mode = 'account-reads', sidecars = ['-wal', '-shm'], fault, affected = 'accountA', mutate, flood = 0 } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'codex-history-'));
  const source = join(work, 'source');
  mkdirSync(join(source, 'sessions'), { recursive: true });
  const records = ['accountA', 'accountB', 'apiKey', 'corrupt'].map((name, index) => ({ name,
    id: `00000000-0000-4000-8000-00000000000${index}`, path: `sessions/${name}.jsonl`, cwd: '/tmp/project', modelProvider: 'fixture',
    witness: { startedTurnId: `turn-${name}`, completedTurnId: `turn-${name}`, status: 'completed', userText: name, agentText: 'synthetic discovery fixture' } }));
  for (const record of records) writeFileSync(join(source, record.path), record.name === 'corrupt' ? '{invalid-json\n' : `opaque ${record.name}`);
  for (const suffix of ['', ...sidecars]) writeFileSync(join(source, `thread_history_1.sqlite${suffix}`), `opaque history ${suffix}`);
  if (fault === 'oversized') writeFileSync(join(source, 'thread_history_1.sqlite'), Buffer.alloc(9 * 1024 * 1024));
  if (fault === 'export') writeFileSync(join(source, 'sessions', 'large.jsonl'), Buffer.alloc(6 * 1024 * 1024));
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
    let created = 0;
    let active;
    const metadata = (record) => ({ ...record, sessionId: record.id, path: `/root/.codex/${record.path}`, source: 'vscode', cliVersion: '0.169.0', turns: [] });
    return nativeChild((request, out) => {
      sent.push(request);
      if (!request.id) return;
      const { method, params } = request;
      const record = records.find((record) => record.id === params.threadId);
      let result = {};
      let error;
      if (method === 'config/read') result = { config };
      if (method === 'account/read') result = { requiresOpenaiAuth: true, userId: requester === 'apiKey' ? null : `user-${requester}`,
        account: requester === 'apiKey' ? { type: 'apiKey' } : { type: 'chatgpt', email: `${requester}@fixture.invalid` },
        workspaceRouting: requester === 'apiKey' ? null : { chatgptAccountId: requester } };
      if (method === 'thread/list') {
        if (requester === 'accountB' && !params.cursor && params.currentAccountOnly) mutate?.(source);
        if (requester === 'accountA' && flood) { flooding(out, flood); flood = 0; }
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
      out.write(`${JSON.stringify({ id: request.id, ...(error ? { error } : { result }) })}\n`);
      if (method === 'turn/start') out.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: active.id, turn: { id: active.witness.completedTurnId, status: 'completed' } } })}\n`);
    });
  } };
  try {
    const result = await entry(mode, state);
    return { ...result, spawns, copies: state.copies, sent,
      originals: files.filter((file) => file !== 'thread_history_1.sqlite' || fault !== 'missing').map((file) => ({ token: file, sha256: createHash('sha256').update(readFileSync(join(source, file))).digest('hex') })), hashes };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
// Actual old-mode 'inaccessible' entry to full completion; the fake native mutates the protected source while serving thread/list.
async function inaccessible(mutate, { flood = 0, build } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'codex-inaccessible-'));
  const source = join(work, 'source');
  mkdirSync(join(source, 'archived_sessions'), { recursive: true });
  writeFileSync(join(source, 'sessions'), 'synthetic invalid directory');
  writeFileSync(join(source, 'archived_sessions', 'archived.jsonl'), 'opaque archived');
  build?.(source);
  const state = { work, records: [], port: 12000, copies: [], spawn: () => nativeChild(({ id, method }, out) => {
    if (method === 'thread/list') { mutate?.(source); flooding(out, flood); }
    if (id) out.write(`${JSON.stringify(method === 'thread/list' ? { id, error: { code: -32603, message: 'Not a directory (os error 20)' } }
      : { id, result: method === 'config/read' ? { config: { sqlite_home: '/tmp/private-index' } } : {} })}\n`);
  }) };
  try { return await entry('inaccessible', state); } finally { rmSync(work, { recursive: true, force: true }); }
}
const full = ['before startup', 'after initialization', 'after requests', 'after drained shutdown', 'after final shutdown attempts'];
const preserved = (result) => result.code === 0 && result.report.failure?.code === -32603
  && JSON.stringify(result.report.preservation) === JSON.stringify(full) && /unchanged/.test(result.report.preservationSummary ?? '');
const notPreserved = (result) => assert(!preserved(result),
  `false preservation: code=${result.code} preservation=${JSON.stringify(result.report.preservation)} summary=${result.report.preservationSummary}`);
const sameByteSwap = (target) => {
  const before = lstatSync(target).ino;
  writeFileSync(`${target}.replacement`, readFileSync(target));
  renameSync(`${target}.replacement`, target);
  assert.notEqual(lstatSync(target).ino, before, 'replacement has a new inode');
};
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
    assert.equal(result.report.preservation.at(-1), 'after final shutdown attempts');
    assert.match(result.report.preservationSummary, /unchanged in metadata and bytes/);
  }
});
test('actual discovery refuses incomplete, changed, aliased, unsupported, or excessive cold copies before affected spawn', async () => {
  for (const fault of ['missing', 'hash', 'preexisting', 'copy', 'sidecar', 'missing-sidecar', 'alias', 'alias-reader', 'partial', 'destination-hash', 'injected', 'changed', 'aggregate', 'oversized']) {
    for (const affected of ['accountA', 'accountB', 'apiKey']) {
      const result = await discovery({ fault, affected });
      assert.equal(result.code, 1, `${fault} ${affected}`);
      // aggregate inflates only the path lstat size, so the 24 MiB copy budget still refuses before the third copy.
      const expected = ['missing', 'hash', 'oversized'].includes(fault) ? 0 : fault === 'aggregate' ? 2 : ['accountA', 'accountB', 'apiKey'].indexOf(affected);
      assert.equal(result.spawns.length, expected, `${fault} ${affected}`);
      assert.notEqual(result.report.accounts?.status, 'negative-public-read-result');
      assert.equal(result.report.inferenceRequests, 0);
      if (fault === 'oversized') assert.equal(result.report.sourceRefusal.reason, 'per-file byte budget exceeded');
      if (fault !== 'changed' && fault !== 'hash') assert.deepEqual(result.originals, result.hashes.filter((entry) => fault !== 'missing' || entry.token !== 'thread_history_1.sqlite'));
    }
  }
  const journal = await discovery({ sidecars: ['-journal'] });
  assert.equal(journal.code, 1);
  assert.equal(journal.spawns.length, 0);
});
test('actual inaccessible discovery reports preservation for a healthy source through all five checkpoints', async () => {
  const result = await inaccessible();
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.preservation, full);
  assert(preserved(result));
  assert.deepEqual(result.report.source.entries.map((entry) => `${entry.token}:${entry.kind}`),
    ['archived_sessions:directory', 'archived_sessions/archived.jsonl:file', 'sessions:file']);
});
test('actual inaccessible discovery refuses a byte change at the after-requests checkpoint', async () => {
  const result = await inaccessible((source) => writeFileSync(join(source, 'sessions'), 'changed bytes'));
  assert.equal(result.code, 1);
  assert.match(result.report.failure.message, /Source bytes preserved at after requests/);
});
test('actual inaccessible discovery refuses an empty directory added inside a selected tree', async () => {
  const result = await inaccessible((source) => mkdirSync(join(source, 'archived_sessions', 'added-empty')));
  notPreserved(result);
  assert.equal(result.report.sourceRefusal.stage, 'after requests');
  assert.equal(result.report.sourceRefusal.token, 'archived_sessions');
});
test('actual inaccessible discovery records an unselected root addition without protecting it', async () => {
  const result = await inaccessible((source) => mkdirSync(join(source, 'added-empty')));
  assert(preserved(result));
  assert.deepEqual(result.report.source.rootChanges, { added: ['added-empty'], removed: [], addedCount: 1, removedCount: 0 });
  assert.match(result.report.preservationSummary, /1 added and 0 removed unselected root entries recorded, not protected/);
});
test('actual inaccessible discovery refuses a selected file replaced by the same bytes at a new inode', async () => {
  const result = await inaccessible((source) => sameByteSwap(join(source, 'sessions')));
  notPreserved(result);
  assert.deepEqual([result.report.sourceRefusal.token, result.report.sourceRefusal.field], ['sessions', 'inode']);
});
test('actual discovery refuses selected root additions in ordinary and H1 modes', async () => {
  const ordinary = await inaccessible((source) => writeFileSync(join(source, 'new.sqlite'), ''));
  notPreserved(ordinary);
  assert.deepEqual([ordinary.report.sourceRefusal.reason, ordinary.report.sourceRefusal.token], ['file added', 'new.sqlite']);
  const h1 = await discovery({ mutate: (source) => writeFileSync(join(source, 'thread_history_x'), '') });
  assert.equal(h1.code, 1);
  assert.equal(h1.spawns.length, 2);
  assert.deepEqual([h1.report.sourceRefusal.stage, h1.report.sourceRefusal.token], ['after accountB requests', 'thread_history_x']);
});
test('actual H1 discovery refuses directory and inode changes before the next requester spawn', async () => {
  for (const mutate of [(source) => mkdirSync(join(source, 'sessions', 'added-empty')), (source) => sameByteSwap(join(source, 'sessions/accountA.jsonl'))]) {
    const result = await discovery({ mutate });
    assert.equal(result.code, 1);
    assert.equal(result.spawns.length, 2, 'API-key requester never spawns');
    assert.equal(result.report.accounts.status, 'inconclusive');
    assert.equal(result.report.sourceRefusal.stage, 'after accountB requests', 'first refusal survives the drained-shutdown checkpoint');
    assert.equal(result.report.sourceRefusal.termination, 'refused');
    assert.equal(result.report.preservationSummary, undefined);
  }
});
test('actual discovery emits one reserved progress overflow marker, bounds source evidence and withholds preservation and H1 success', async () => {
  const old = await inaccessible(undefined, { flood: 600 });
  const h1 = await discovery({ flood: 600 });
  for (const result of [old, h1]) {
    assert.equal(result.code, 1);
    const markers = result.progress.filter((line) => line.includes('"progressOverflow"'));
    assert.equal(markers.length, 1);
    assert.equal(result.progress.at(-1), markers[0]);
    assert(result.progress.reduce((sum, line) => sum + Buffer.byteLength(line), 0) <= 512 * 1024);
    assert.equal(result.report.failure.message, 'Required bounded progress was truncated');
    assert.equal(result.report.preservationSummary, undefined);
  }
  assert.equal(old.report.preservation.at(-1), 'after final shutdown attempts', 'every checkpoint passed; overflow alone withholds the claim');
  assert.notEqual(h1.report.accounts.status, 'negative-public-read-result');
  const long = await inaccessible(undefined, { build: (source) => {
    for (let index = 0; index < 100; index++) writeFileSync(join(source, 'archived_sessions', `${String(index).padStart(200, 'n')}.jsonl`), '');
  } });
  assert.equal(long.code, 1);
  assert.equal(long.report.source.entriesOmitted, 103, 'evidence is bounded before it is built');
  assert.equal(long.report.failure.message, 'Required bounded source evidence was omitted');
  assert.deepEqual(long.report.preservation, [], 'refused before startup');
  assert.equal(long.report.preservationSummary, undefined);
});
const LEGACY = { id: '00000000-0000-4000-8000-00000000000a', path: 'sessions/2026/rollout-legacy.jsonl' };
const NATIVE = Buffer.from('{"opaque":"native legacy"}\n');
async function legacyEntry(mode, { control, bytes, fault, stderr = '' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'codex-legacy-'));
  const source = join(work, 'source');
  mkdirSync(join(source, 'sessions/2026'), { recursive: true });
  mkdirSync(join(source, 'archived_sessions'));
  if (bytes) writeFileSync(join(source, LEGACY.path), bytes);
  if (fault === 'stale-private') mkdirSync(join(work, 'private-index'));
  const witness = { startedTurnId: 'turn-legacy', completedTurnId: 'turn-legacy', status: 'completed', userText: 'legacy', agentText: 'synthetic discovery fixture' };
  const records = [{ name: 'legacy', ...LEGACY, cwd: '/tmp/project', modelProvider: 'fixture', witness }];
  const inventory = inventoryOf(observeSource(source, SELECTORS.ordinary, { fs: real }));
  const sent = [];
  const thread = (historyMode) => ({ id: LEGACY.id, historyMode, path: `/root/.codex/${LEGACY.path}`, turns: [] });
  const state = { work, records, inventory, port: 12000, copies: [], spawn: () => {
    const child = nativeChild(({ id, method, params }, out) => {
      sent.push({ method, params });
      if (!id) return;
      const reply = (result) => out.write(`${JSON.stringify({ id, result })}\n`);
      if (method === 'thread/start') return reply({ thread: { ...thread(fault === 'paginated' ? 'paginated' : params.historyMode), path: null } });
      if (method === 'turn/start') {
        writeFileSync(join(source, LEGACY.path), fault === 'unterminated' ? '{"opaque":"native legacy"}' : NATIVE);
        reply({ turn: { id: 'turn-legacy' } });
        return out.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: LEGACY.id, turn: { id: 'turn-legacy', status: 'completed' } } })}\n`);
      }
      if (method === 'config/read') return reply({ config: { sqlite_home: '/tmp/private-index', log_dir: '/tmp/private-logs' } });
      if (control === 'tail' && method === 'thread/read' && mode === 'legacy-read') return out.write(`${JSON.stringify({ id, error: { code: -32603, message: 'synthetic' } })}\n`);
      if (method === 'thread/read') return reply({ thread: thread('legacy') });
      if (method === 'getConversationSummary') return reply({ summary: { conversationId: LEGACY.id, path: params.rolloutPath } });
      reply({ data: [], nextCursor: method === 'thread/items/list' && !params.cursor ? 'next' : null, backwardsCursor: null });
    });
    child.stderr.write(stderr);
    return child;
  } };
  try { return { ...(await entry(mode, state, control ? [control] : [])), sent, source }; }
  finally { rmSync(work, { recursive: true, force: true }); }
}
test('actual Legacy creator exports one drained native rollout and refuses unhonored or unterminated Legacy history', async () => {
  const { legacySources } = await import('../../spikes/codex-native/legacy-tail.mjs');
  const created = await legacyEntry('prepare-legacy');
  assert.equal(created.code, 0);
  assert.deepEqual(created.sent.find((request) => request.method === 'thread/start').params.historyMode, 'legacy');
  assert.deepEqual(created.sent.filter((request) => request.method !== 'initialized').map((request) => request.method), ['initialize', 'thread/start', 'turn/start', 'thread/read']);
  assert.deepEqual(created.report.record, { name: 'legacy', id: LEGACY.id, cwd: '/tmp/project', modelProvider: 'fixture', path: LEGACY.path, witness:
    { startedTurnId: 'turn-legacy', completedTurnId: 'turn-legacy', status: 'completed', userText: 'legacy', agentText: 'synthetic discovery fixture' } });
  assert.deepEqual([created.report.creator.startHistoryMode, created.report.creator.readHistoryMode], ['legacy', 'legacy']);
  assert.deepEqual(created.report.drain.map((client) => [client.closed, client.signal]), [[true, 'SIGTERM']]);
  assert.deepEqual(created.report.protocol.transcript.map((observation) => observation.request.method), ['initialize', 'thread/start', 'turn/start', 'thread/read']);
  const sources = legacySources(created.report);
  assert(sources.healthy.equals(NATIVE));
  assert(sources.tail.equals(Buffer.concat([NATIVE, Buffer.from('{invalid-json\n')])));
  assert.equal(sources.whole.toString(), '{invalid-json\n');
  assert(sources['absent-id'].equals(NATIVE), 'The absent-ID home holds the healthy rollout');
  assert.equal(sources['absent-path'], null);
  for (const [fault, message] of [['paginated', /experimental Legacy history option/], ['unterminated', /end in one newline/]]) {
    const refused = await legacyEntry('prepare-legacy', { fault });
    assert.equal(refused.code, 1);
    assert.match(refused.report.failure.message, message);
    assert.equal(refused.report.rollout, undefined);
  }
});
test('actual Legacy reader dispatches the fixed public sequence in a fresh home and retains drain, stderr and checkpoints', async () => {
  const { ABSENT_ID } = await import('../../spikes/codex-native/legacy-tail.mjs');
  const tail = Buffer.concat([NATIVE, Buffer.from('{invalid-json\n')]);
  const read = await legacyEntry('legacy-read', { control: 'tail', bytes: tail, stderr: 'synthetic native warning\n' });
  assert.equal(read.code, 0);
  const params = { threadId: LEGACY.id };
  assert.deepEqual(read.report.legacy.steps.map(({ method, params }) => ({ method, params })), [
    { method: 'getConversationSummary', params: { rolloutPath: `/root/.codex/${LEGACY.path}` } },
    { method: 'thread/read', params: { ...params, includeTurns: false } },
    { method: 'thread/read', params: { ...params, includeTurns: true } },
    { method: 'thread/turns/list', params: { ...params, sortDirection: 'asc', itemsView: 'summary', limit: 1 } },
    { method: 'thread/items/list', params: { ...params, sortDirection: 'asc', limit: 1 } },
    { method: 'thread/items/list', params: { ...params, sortDirection: 'asc', limit: 1, cursor: 'next' } }]);
  assert.equal(read.report.legacy.steps[1].reply.error.code, -32603, 'A rejection is retained, not thrown');
  assert.equal(read.report.legacy.sequence, 'complete');
  assert.deepEqual(read.report.preservation, ['before startup', 'after initialization', 'after requests', 'after drained shutdown', 'after final shutdown attempts']);
  assert.match(read.report.preservationSummary, /unchanged/);
  assert.equal(Buffer.from(read.report.drain[0].stderr.base64, 'base64').toString(), 'synthetic native warning\n');
  assert.equal(read.report.drain[0].stderr.truncated, false);
  const stale = await legacyEntry('legacy-read', { control: 'healthy', bytes: NATIVE, fault: 'stale-private' });
  assert.equal(stale.code, 1);
  assert.match(stale.report.failure.message, /Fresh empty private SQLite and logs/);
  assert(!stale.sent.length, 'No native spawn without a fresh private home');
  const absentPath = await legacyEntry('legacy-read', { control: 'absent-path' });
  assert.equal(absentPath.code, 0);
  assert.equal(absentPath.report.legacy.steps[0].params.rolloutPath, `/root/.codex/${LEGACY.path}`, 'Absent path is the exact native path in an empty home');
  assert(absentPath.report.legacy.steps.slice(1).every((step) => step.params.threadId === LEGACY.id));
  const absentId = await legacyEntry('legacy-read', { control: 'absent-id', bytes: NATIVE });
  assert.equal(absentId.code, 0);
  assert.equal(absentId.report.legacy.steps[0].params.rolloutPath, `/root/.codex/${LEGACY.path}`);
  assert(absentId.report.legacy.steps.slice(1).every((step) => step.params.threadId === ABSENT_ID), 'Only absent-id asks for the never-created ID');
  for (const [control, bytes] of [['absent-path', NATIVE], ['absent-id', undefined]]) {
    assert.equal((await legacyEntry('legacy-read', { control, bytes })).code, 1, `${control} with the wrong home refuses before dispatch`);
  }
});
test('Legacy conclusion is only uncertified success, bounded rejection or inconclusive', async () => {
  const { legacyConclusion } = await import('../../spikes/codex-native/legacy-tail.mjs');
  const drain = [{ closed: true, stderr: { truncated: false } }];
  const record = { id: LEGACY.id, path: LEGACY.path, witness: { completedTurnId: 'turn-legacy', userText: 'legacy', agentText: 'synthetic discovery fixture' } };
  const ok = (result) => ({ id: 1, result });
  const error = { id: 1, error: { code: -32603, message: 'synthetic' } };
  const healthy = () => [
    ['getConversationSummary', ok({ summary: { conversationId: LEGACY.id, path: `/root/.codex/${LEGACY.path}` } })],
    ['thread/read', ok({ thread: { id: LEGACY.id, historyMode: 'legacy', path: `/root/.codex/${LEGACY.path}`, turns: [] } })],
    ['thread/read', error, true],
    ['thread/turns/list', ok({ data: [{ id: 'turn-legacy', status: 'completed' }], nextCursor: null })],
    ['thread/items/list', ok({ data: [{ turnId: 'turn-legacy', item: { type: 'userMessage', content: [{ type: 'text', text: 'legacy' }] } },
      { turnId: 'turn-legacy', item: { type: 'agentMessage', text: 'synthetic discovery fixture' } }], nextCursor: null })]];
  const reader = (pairs, extra = {}) => ({ preservationSummary: 'unchanged', inferenceRequests: 0, drain: [{ closed: true, stderr: { truncated: false } }],
    legacy: { sequence: 'complete', configSha256: 'same', steps: pairs.map(([method, reply, includeTurns]) => ({ method, params: { includeTurns }, reply })) }, ...extra });
  const rejected = () => healthy().map(([method, , turns]) => [method, error, turns]);
  const absentId = () => healthy().map(([method, reply, turns]) => [method, method === 'getConversationSummary' ? reply : error, turns]);
  const readers = (overrides = {}) => ({ healthy: reader(healthy()), tail: reader(healthy()), whole: reader(rejected()),
    'absent-id': reader(absentId()), 'absent-path': reader(rejected()), ...overrides });
  assert.equal(legacyConclusion({ record, drain }, readers()).outcome, 'successful-reads-uncertified');
  const rejection = legacyConclusion({ record, drain }, readers({ tail: reader(healthy().map(([method, reply, turns]) => [method, method === 'thread/read' ? error : reply, turns])) }));
  assert.equal(rejection.outcome, 'bounded-public-rejection');
  assert.deepEqual(rejection.compared.map((step) => [step.informative, step.sameAsAbsentPath]), [[true, false], [true, true], [false, true], [true, false], [true, false]]);
  const uninformative = legacyConclusion({ record, drain }, readers({ tail: reader(healthy().map(([method, reply, turns]) => [method, turns ? ok({}) : reply, turns])) }));
  assert.equal(uninformative.outcome, 'successful-reads-uncertified', 'A step the healthy control could not answer never decides the tail');
  for (const [overrides, reason, prepared] of [
    [{ tail: reader(healthy(), { preservationSummary: undefined }) }, 'tail harness'],
    [{ tail: { ...reader(healthy()), acquisition: 'partial' } }, 'tail acquisition'],
    [{ whole: reader(rejected(), { drain: [{ closed: true, stderr: { truncated: true } }] }) }, 'whole drain and stderr'],
    [{ 'absent-path': reader(rejected(), { legacy: { sequence: 'complete', configSha256: 'other', steps: [] } }) }, 'absent-path configuration'],
    [{ tail: reader(healthy()) }, 'creator drain and stderr', { record, drain: [] }],
    [{ healthy: reader(healthy().map(([method, reply, turns]) => [method, method === 'thread/read' && !turns ? ok({ thread: { ...reply.result.thread, historyMode: 'paginated' } }) : reply, turns])) }, 'healthy Legacy metadata'],
    [{ healthy: reader(healthy().slice(0, 4).concat([['thread/items/list', ok({ data: [], nextCursor: null })]])) }, 'healthy turn and message association'],
    [{ whole: reader(healthy()) }, 'whole-file control rejected publicly'],
    [{ 'absent-id': reader(rejected()) }, 'absent-id control rejected'],
    [{ 'absent-id': reader(healthy()) }, 'absent-id control rejected'],
    [{ 'absent-path': reader(healthy()) }, 'absent-path control rejected'],
  ]) {
    const conclusion = legacyConclusion(prepared ?? { record, drain }, readers(overrides));
    assert.equal(conclusion.outcome, 'inconclusive');
    assert(conclusion.reasons.includes(reason), `${reason}: ${conclusion.reasons}`);
  }
  const precondition = legacyConclusion({ mode: 'prepare-legacy', failure: { message: 'Public start must honor the experimental Legacy history option' }, acquisition: 'partial' }, {});
  assert.deepEqual(precondition, { outcome: 'inconclusive', reasons: ['creator precondition'],
    precondition: { stage: 'creator', acquisition: 'partial', failure: 'Public start must honor the experimental Legacy history option' } });
});
test('actual preparation exports exact native turn witnesses and older modes bypass cold copies', async () => {
  const prepared = await discovery({ mode: 'prepare-accounts' });
  assert.equal(prepared.code, 0);
  assert.equal(prepared.copies.length, 0);
  assert.deepEqual(prepared.report.records.map((record) => record.witness), ['accountA', 'accountB', 'apiKey', 'corrupt'].map((name) => ({
    startedTurnId: `turn-${name}`, completedTurnId: `turn-${name}`, status: 'completed', userText: name, agentText: 'synthetic discovery fixture',
  })));
  const exported = Object.entries(prepared.report.files).map(([token, encoded]) => ({ token,
    sha256: createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex') })).sort((left, right) => left.token < right.token ? -1 : 1);
  assert.deepEqual(exported, prepared.originals, 'export is the exact selected file set and bytes, without directories');
  const encodings = [];
  const toString = Buffer.prototype.toString;
  Buffer.prototype.toString = function (encoding, ...rest) { encodings.push(encoding); return toString.call(this, encoding, ...rest); };
  let capped;
  try { capped = await discovery({ mode: 'prepare-accounts', fault: 'export' }); } finally { Buffer.prototype.toString = toString; }
  assert.equal(capped.code, 1);
  assert.match(capped.report.failure.message, /Prepared export cap exceeded before encoding/);
  assert.equal(capped.report.files, undefined);
  assert(!encodings.includes('base64'), 'no base64 is built before the export cap refuses');
  for (const mode of ['prepare', 'indexed', 'unindexed', 'malformed', 'inaccessible', 'symlink']) {
    const result = await discovery({ mode });
    assert.equal(result.spawns.length, 1);
    assert.equal(result.copies.length, 0);
    assert.match(result.report.failure.message, /Inert old-mode spawn reached/);
    if (mode !== 'prepare') assert.equal(result.report.source.selector, mode === 'symlink' ? 'symlink' : 'ordinary');
  }
  hook.deregister();
});
const tree = (t, build) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-observe-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sessions'));
  writeFileSync(join(root, 'sessions/a.jsonl'), 'alpha');
  writeFileSync(join(root, 'state_5.sqlite'), 'state');
  build?.(root);
  return root;
};
// Unit tests pass the real fs: the module's default fs is the history boundary, which maps only /root/.codex and /tmp.
const observe = (root, selection = SELECTORS.ordinary, options = {}) => observeSource(root, selection, { fs: real, ...options });
// A real-fs wrapper that counts calls and tracks every open descriptor and directory handle.
const tracked = (overrides = {}) => {
  const open = new Set();
  const dirs = new Set();
  const paths = new Map();
  const calls = { opened: [], read: [], lstat: new Set(), opendir: [] };
  const fs = { ...real, ...overrides,
    lstatSync: (path) => { calls.lstat.add(path); return (overrides.lstatSync ?? real.lstatSync)(path); },
    openSync: (...args) => { calls.opened.push(args[0]); const fd = real.openSync(...args); open.add(fd); paths.set(fd, args[0]); return fd; },
    closeSync: (fd) => { open.delete(fd); real.closeSync(fd); },
    readSync: (...args) => { calls.read.push(paths.get(args[0])); return (overrides.readSync ?? real.readSync)(...args); },
    opendirSync: (path) => {
      calls.opendir.push(path);
      const directory = real.opendirSync(path);
      dirs.add(directory);
      return { readSync: () => (overrides.dirRead ?? (() => directory.readSync()))(), closeSync: () => { dirs.delete(directory); directory.closeSync(); } };
    } };
  return { fs, calls, closed: () => open.size === 0 && dirs.size === 0 };
};
const refusal = (run) => {
  try { run(); } catch (error) { assert(error.evidence, error.stack); return error.evidence; }
  return assert.fail('expected a source refusal');
};
const refusesAfter = (t, build, mutate, selection = SELECTORS.ordinary) => {
  const root = tree(t, build);
  const baseline = observe(root, selection);
  mutate(root);
  return refusal(() => verifySource(baseline, 'after'));
};
test('bounded observation refuses file, directory, family and missing-tree additions and removals', (t) => {
  const base = observe(tree(t));
  assert.deepEqual([...base.entries.keys()].sort(), ['archived_sessions', 'sessions', 'sessions/a.jsonl', 'state_5.sqlite']);
  assert.equal(base.entries.get('archived_sessions').kind, 'missing');
  assert.equal(verifySource(base, 'healthy').stage, 'healthy');
  const empty = observe(tree(t, (root) => mkdirSync(join(root, 'archived_sessions'))));
  assert.equal(empty.entries.get('archived_sessions').kind, 'directory');
  verifySource(empty, 'empty tree');
  const wal = (root) => writeFileSync(join(root, 'state_5.sqlite-wal'), '');
  for (const [build, mutate, expected] of [
    [undefined, (root) => mkdirSync(join(root, 'sessions/added')), ['metadata changed', 'sessions']],
    [undefined, (root) => mkdirSync(join(root, 'archived_sessions')), ['metadata changed', 'archived_sessions', 'kind']],
    [undefined, wal, ['file added', 'state_5.sqlite-wal']],
    [undefined, (root) => rmSync(join(root, 'state_5.sqlite')), ['entry removed', 'state_5.sqlite']],
    [wal, (root) => rmSync(join(root, 'state_5.sqlite-wal')), ['entry removed', 'state_5.sqlite-wal']],
    [undefined, (root) => rmSync(join(root, 'sessions'), { recursive: true }), ['metadata changed', 'sessions', 'kind']],
  ]) {
    const evidence = refusesAfter(t, build, mutate);
    assert.deepEqual([evidence.reason, evidence.token, ...(expected[2] ? [evidence.field] : [])], expected);
    assert.equal(evidence.cause, 'change');
  }
  // A file added to a small directory need not change the parent's metadata (ext4 size and nlink, coarse times).
  const added = refusesAfter(t, undefined, (root) => writeFileSync(join(root, 'sessions/b.jsonl'), ''));
  assert(['metadata changed:sessions', 'file added:sessions/b.jsonl'].includes(`${added.reason}:${added.token}`), JSON.stringify(added));
  const frozen = (path) => String(path).endsWith('/sessions') ? { ...real.lstatSync(path), mtimeMs: 1, ctimeMs: 1, size: 1, nlink: 1,
    isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false } : real.lstatSync(path);
  for (const [mutate, reason, token] of [[(root) => writeFileSync(join(root, 'sessions/b.jsonl'), ''), 'file added', 'sessions/b.jsonl'],
    [(root) => mkdirSync(join(root, 'sessions/added')), 'directory added', 'sessions/added']]) {
    const root = tree(t);
    const fs = tracked({ lstatSync: frozen });
    const baseline = observe(root, SELECTORS.ordinary, { fs: fs.fs });
    mutate(root);
    const evidence = refusal(() => verifySource(baseline, 'frozen parent'));
    assert.deepEqual([evidence.reason, evidence.token], [reason, token]);
  }
});
test('bounded observation refuses kind, inode, mode, link, size and time changes but keeps hardlink aliases', (t) => {
  for (const [mutate, token, field] of [
    [(root) => chmodSync(join(root, 'sessions/a.jsonl'), 0o600), 'sessions/a.jsonl', 'mode'],
    [(root) => linkSync(join(root, 'sessions/a.jsonl'), join(root, 'alias-outside-selection')), 'sessions/a.jsonl', 'links'],
    [(root) => utimesSync(join(root, 'state_5.sqlite'), 1, 1), 'state_5.sqlite', 'modified'],
    [(root) => sameByteSwap(join(root, 'state_5.sqlite')), 'state_5.sqlite', 'inode'],
    [(root) => real.appendFileSync(join(root, 'state_5.sqlite'), '!'), 'state_5.sqlite', 'size'],
    [(root) => { rmSync(join(root, 'state_5.sqlite')); mkdirSync(join(root, 'state_5.sqlite')); }, 'state_5.sqlite', 'kind'],
  ]) {
    const evidence = refusesAfter(t, undefined, mutate);
    assert.deepEqual([evidence.reason, evidence.token, evidence.field], ['metadata changed', token, field]);
  }
  const hard = observe(tree(t, (root) => linkSync(join(root, 'sessions/a.jsonl'), join(root, 'sessions/alias.opaque'))));
  verifySource(hard, 'hardlinks');
  assert.equal(hard.entries.get('sessions/alias.opaque').inode, hard.entries.get('sessions/a.jsonl').inode);
  assert.equal(hard.entries.get('sessions/a.jsonl').links, 2);
});
test('bounded observation refuses short, growing and substituted reads and compares retained bytes directly', (t) => {
  const root = tree(t, (path) => writeFileSync(join(path, 'sessions/big.jsonl'), Buffer.alloc(200 * 1024, 7)));
  const base = observe(root);
  const big = join(root, 'sessions/big.jsonl');
  const large = (fd) => real.fstatSync(fd).size > 100_000;
  let swapped = false;
  for (const [readSync, reason] of [
    [(fd, buffer, offset, length, position) => position > 0 && large(fd) ? 0 : real.readSync(fd, buffer, offset, length, position), 'short read'],
    [(fd, buffer, offset, length, position) => position === 200 * 1024 && length === 1 ? 1 : real.readSync(fd, buffer, offset, length, position), 'grew during read'],
    // Inert byte substitution with identical metadata: a direct-comparison control, not a hash collision.
    [(fd, buffer, offset, length, position) => {
      const count = real.readSync(fd, buffer, offset, length, position);
      if (position === CHUNK && large(fd)) buffer[offset] ^= 1;
      return count;
    }, 'bytes changed'],
    [(fd, buffer, offset, length, position) => {
      const count = real.readSync(fd, buffer, offset, length, position);
      if (!swapped && large(fd)) { swapped = true; sameByteSwap(big); }
      return count;
    }, 'changed during read'],
  ]) {
    const fs = tracked({ readSync });
    const evidence = refusal(() => verifySource({ ...base, fs: fs.fs }, 'reads'));
    assert.deepEqual([evidence.reason, evidence.token], [reason, 'sessions/big.jsonl']);
    assert(fs.closed());
  }
  verifySource({ ...observe(root), digest: '0'.repeat(64) }, 'digest is evidence only and never compared');
  const expected = observe(root).entries.get('sessions/big.jsonl').bytes;
  writeFileSync(join(root, 'copy'), expected);
  assert.equal(compareFile(real, join(root, 'copy'), expected), createHash('sha256').update(expected).digest('hex'));
  const flipped = Buffer.from(expected);
  flipped[CHUNK] ^= 1;
  writeFileSync(join(root, 'copy'), flipped);
  assert.throws(() => compareFile(real, join(root, 'copy'), expected), /Complete cold copy bytes/);
});
const CHUNK = 64 * 1024;
test('bounded observation refuses special files, entry, depth, byte and deadline limits before reading, opening or descending', (t) => {
  const special = tracked({ lstatSync: (path) => String(path).endsWith('a.jsonl')
    ? { ...real.lstatSync(path), isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false } : real.lstatSync(path) });
  assert.equal(refusal(() => observe(tree(t), SELECTORS.ordinary, { fs: special.fs })).reason, 'special file');
  assert(!special.calls.opened.some((path) => path.endsWith('a.jsonl')), 'a special file is never opened');
  const many = tracked();
  const wide = tree(t, (root) => { for (let index = 0; index < 130; index++) writeFileSync(join(root, `sessions/${index}.jsonl`), ''); });
  assert.equal(refusal(() => observe(wide, SELECTORS.ordinary, { fs: many.fs })).reason, 'entry budget exceeded');
  assert(many.calls.lstat.size <= limits.entries + 1, 'no entry beyond the budget is examined');
  const deep = tracked();
  const nested = tree(t, (root) => mkdirSync(join(root, 'sessions/1/2/3/4/5/6/7/8'), { recursive: true }));
  assert.deepEqual(refusal(() => observe(nested, SELECTORS.ordinary, { fs: deep.fs })).token, 'sessions/1/2/3/4/5/6/7/8');
  assert(!deep.calls.opendir.some((path) => path.endsWith('/8')), 'depth nine is never opened');
  const over = tracked();
  const oversized = tree(t, (root) => writeFileSync(join(root, 'sessions/over.jsonl'), Buffer.alloc(8 * 1024 * 1024 + 1)));
  assert.equal(refusal(() => observe(oversized, SELECTORS.ordinary, { fs: over.fs })).reason, 'per-file byte budget exceeded');
  const aggregate = tree(t, (root) => { for (const name of ['x', 'y']) writeFileSync(join(root, `sessions/${name}.jsonl`), Buffer.alloc(5 << 20)); });
  assert.equal(refusal(() => observe(aggregate)).reason, 'aggregate byte budget exceeded');
  const late = refusal(() => observe(tree(t), SELECTORS.ordinary, { overrides: { milliseconds: -1 } }));
  assert.deepEqual([late.reason, late.cause, late.termination], ['deadline exceeded', 'policy', 'refused']);
  // Directory order is filesystem-defined (ext4 hashes it), so the small fixture files may be read first.
  assert(over.calls.opened.some((path) => path.endsWith('over.jsonl')), 'the oversized file is opened and measured');
  assert(!over.calls.read.some((path) => path.endsWith('over.jsonl')), 'an oversized file is refused before any read or allocation');
  for (const fs of [special, many, deep, over]) assert(fs.closed());
});
test('bounded observation closes every descriptor and directory on each refusal', (t) => {
  const root = tree(t);
  const failure = Object.assign(new Error('synthetic'), { code: 'EIO' });
  for (const overrides of [{ fstatSync: () => { throw failure; } }, { readSync: () => { throw failure; } }, { dirRead: () => { throw failure; } }]) {
    const fs = tracked(overrides);
    const evidence = refusal(() => observe(root, SELECTORS.ordinary, { fs: fs.fs }));
    assert.deepEqual([evidence.reason, evidence.cause], ['observation failed: EIO', 'policy']);
    assert.equal(typeof evidence.counters.examined, 'number');
    assert(fs.closed());
  }
});
test('selectors keep ordinary and H1 root rules distinct and characterize only permitted symlinks', (t) => {
  const family = tree(t, (root) => { for (const name of ['thread_history_1.sqlite-journal', 'logs_2.sqlite-foo']) writeFileSync(join(root, name), 'j'); });
  assert.deepEqual([...observe(family).entries.keys()].filter((token) => !token.startsWith('sessions')).sort(), ['archived_sessions', 'state_5.sqlite']);
  assert.deepEqual([...observe(family, SELECTORS.h1).entries.keys()].filter((token) => token.includes('.sqlite')).sort(),
    ['logs_2.sqlite-foo', 'state_5.sqlite', 'thread_history_1.sqlite-journal']);
  const auxiliary = (count) => (root) => { for (let index = 0; index < count; index++) writeFileSync(join(root, `aux-${index}`), ''); };
  assert.equal(observe(tree(t, auxiliary(120))).names.size, 120);
  const exhausted = tracked();
  assert.equal(refusal(() => observe(tree(t, auxiliary(130)), SELECTORS.ordinary, { fs: exhausted.fs })).reason, 'entry budget exceeded');
  assert(exhausted.closed());
  const linked = tree(t, (root) => { symlinkSync('/unauthorized/x.jsonl', join(root, 'sessions/link.jsonl')); symlinkSync('/unauthorized', join(root, 'sessions/2099')); });
  for (const selection of [SELECTORS.ordinary, SELECTORS.h1]) assert.equal(refusal(() => observe(linked, selection)).reason, 'symlink');
  const characterized = observe(linked, SELECTORS.symlink);
  const link = characterized.entries.get('sessions/2099');
  assert.deepEqual([link.kind, link.target.toString()], ['symlink', '/unauthorized']);
  assert(![...characterized.entries.keys()].some((token) => token.startsWith('sessions/2099/')), 'never followed or descended');
  const retargeted = new Map(characterized.entries).set('sessions/2099', { ...link, target: Buffer.from('/elsewhere') });
  assert.equal(refusal(() => verifySource({ ...characterized, entries: retargeted }, 'retarget')).reason, 'symlink target changed');
  const ancestor = join(tree(t), 'sessions');
  rmSync(ancestor, { recursive: true });
  writeFileSync(ancestor, 'synthetic invalid directory');
  const control = observe(dirname(ancestor));
  assert.deepEqual(['sessions', 'archived_sessions'].map((token) => control.entries.get(token).kind), ['file', 'missing']);
  const host = tree(t);
  symlinkSync(dirname(host), `${host}-alias`);
  t.after(() => rmSync(`${host}-alias`));
  assert.equal(refusal(() => observe(join(`${host}-alias`, basename(host)), SELECTORS.host)).reason, 'root has symlink ancestors');
  const foreign = tracked({ lstatSync: (path) => String(path).endsWith('a.jsonl') ? { ...real.lstatSync(path), dev: -1,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } : real.lstatSync(path) });
  assert.equal(refusal(() => observe(host, SELECTORS.host, { fs: foreign.fs })).reason, 'foreign device');
  const inventory = inventoryOf(observe(host, SELECTORS.host));
  assert.deepEqual(Object.keys(inventory.entries[0]), ['token', 'device', 'inode', 'size', 'mode', 'links', 'modified', 'changed', 'directory', 'candidate']);
  assert.deepEqual(inventory.entries.filter((entry) => entry.candidate).map((entry) => entry.token), ['sessions/a.jsonl']);
});
