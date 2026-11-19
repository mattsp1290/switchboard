import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [tsc, '-p', 'adapters/claude-host/tsconfig.json'], { cwd: root, stdio: 'inherit' });
const { discoverClaudeHostSessions } = await import('../../../dist/host/claude/sessions.js');

const binding = Object.freeze({
  engine: 'claude', nativeVersion: '0.3.323', account: 'crew', authorizedScope: '/work', nativeFormat: 'claude-session',
});
const bounds = Object.freeze({ maxResults: 10, maxExamined: 20, maxDurationMs: 60000 });
const signal = () => new AbortController().signal;
const row = (sessionId, summary = 'hello', lastModified = 10) => ({ sessionId, summary, lastModified });
const discover = (read, extra = {}) => discoverClaudeHostSessions({
  dir: '/work', binding, bounds, signal: signal(), read, ...extra,
});

test('a directory listing becomes session references and keeps the binding', async () => {
  const page = await discover(async (dir, limit) => {
    assert.equal(dir, '/work');
    assert.equal(limit, 21);
    return { kind: 'ok', sessions: [row('11111111-1111-4111-8111-111111111111'), row('22222222-2222-4222-8222-222222222222')] };
  });
  assert.equal(page.kind, 'ok');
  assert.equal(page.value.kind, 'complete');
  assert.equal(page.value.examined, 2);
  assert.deepEqual(page.value.skipped, { corrupt: 0, inaccessible: 0 });
  assert.deepEqual(page.value.sessions.map((session) => session.opaque), [
    '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  ]);
  assert.deepEqual(page.value.sessions[0].binding, binding);
});

test('an empty reader page is complete and does not claim the directory was proved empty', async () => {
  const page = await discover(async () => ({ kind: 'ok', sessions: [] }));
  assert.deepEqual(page, { kind: 'ok', value: {
    kind: 'complete', sessions: [], examined: 0, skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [],
  } });
});

test('malformed rows are corrupt and a repeated id is kept once', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const page = await discover(async () => ({ kind: 'ok', sessions: [
    row('not-a-uuid'), row(id, ''), row(id, 'kept', 1.5), row(id), row(id, 'again', 4),
  ] }));
  assert.equal(page.value.kind, 'complete');
  assert.equal(page.value.examined, 5);
  assert.equal(page.value.skipped.corrupt, 3);
  assert.deepEqual(page.value.sessions.map((session) => session.opaque), [id]);
});

test('the result cap stops before reading another row', async () => {
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const page = await discover(async () => ({ kind: 'ok', sessions: ids.map((id) => row(id)) }), {
    bounds: { maxResults: 1, maxExamined: 20, maxDurationMs: 60000 },
  });
  assert.equal(page.value.kind, 'truncated');
  assert.equal(page.value.reason, 'results');
  assert.equal(page.value.sessions.length, 1);
  assert.equal(page.value.examined, 1);
});

test('one row past the examine cap truncates the page', async () => {
  const sessions = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'].map((id) => row(id));
  const page = await discover(async (_dir, limit) => {
    assert.equal(limit, 3);
    return { kind: 'ok', sessions };
  }, { bounds: { maxResults: 2, maxExamined: 2, maxDurationMs: 60000 } });
  assert.equal(page.value.kind, 'truncated');
  assert.equal(page.value.reason, 'examined');
  assert.equal(page.value.examined, 2);
  assert.equal(page.value.sessions.length, 2);
});

test('a relative directory, a bad binding, and a refused reader never become a page', async () => {
  const read = async () => { throw new Error('unread'); };
  assert.equal((await discover(read, { dir: 'work' })).error.code, 'invalid-input');
  assert.equal((await discover(read, { binding: { ...binding, account: '' } })).error.code, 'invalid-input');
  assert.equal((await discover(async () => ({ kind: 'error', code: 'inaccessible' }))).error.code, 'inaccessible');
  assert.equal((await discover(async () => { throw new Error('broken'); })).error.code, 'native-failure');
  const aborted = new AbortController();
  aborted.abort();
  let called = false;
  const cancelled = await discover(async () => { called = true; return { kind: 'ok', sessions: [] }; }, { signal: aborted.signal });
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(called, false);
});
