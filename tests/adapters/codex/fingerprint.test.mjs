import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = new URL('../../../src/adapters/codex/fingerprint.ts', import.meta.url).href;
const { readCodexHistoryFingerprint } = await import(source);

const line = (type, payload) => JSON.stringify({ type, payload });
const thread = '0192a0b0-0000-7000-8000-000000000001';

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-codex-fingerprint-'));
  await mkdir(join(root, 'sessions', '2026', '11', '19'), { recursive: true });
  return root;
}

test('the fingerprint is the one rollout named for the thread', async () => {
  const root = await home();
  const sessions = join(root, 'sessions', '2026', '11', '19');
  const quoted = line('event_msg', { type: 'task_complete', turn_id: 'quoted-turn' });
  await writeFile(join(sessions, 'other.jsonl'), `${quoted}\n${JSON.stringify({ note: thread })}\n`);
  for (let index = 0; index < 201; index += 1) await writeFile(join(sessions, `noise-${index}.jsonl`), '{}\n');
  const body = [
    line('response_item', { type: 'task_complete', turn_id: 'not-an-event' }),
    line('event_msg', { type: 'task_complete', turn_id: 'first-turn' }),
    line('event_msg', { type: 'task_complete', turn_id: 'last-turn' }),
  ].join('\n');
  const path = join(sessions, `rollout-2026-11-19T12-00-00-${thread}.jsonl`);
  await writeFile(path, `${body}\n`);
  const fingerprint = await readCodexHistoryFingerprint(root, thread);
  assert.equal(fingerprint.turnId, 'last-turn');
  assert.equal(fingerprint.bytes, Buffer.byteLength(`${body}\n`));
  assert.equal(fingerprint.sha256, createHash('sha256').update(`${body}\n`).digest('hex'));
});

test('zero or two named rollouts are not a fingerprint', async () => {
  const root = await home();
  const sessions = join(root, 'sessions', '2026', '11', '19');
  assert.equal(await readCodexHistoryFingerprint(root, thread), undefined);
  const body = `${line('event_msg', { type: 'task_complete', turn_id: 'turn' })}\n`;
  await writeFile(join(sessions, `a-${thread}.jsonl`), body);
  await writeFile(join(sessions, `b-${thread}.jsonl`), body);
  assert.equal(await readCodexHistoryFingerprint(root, thread), undefined);
  assert.equal(await readCodexHistoryFingerprint(root, ''), undefined);
});

test('an oversized named rollout makes the history ambiguous', async () => {
  const root = await home();
  const sessions = join(root, 'sessions', '2026', '11', '19');
  const body = `${line('event_msg', { type: 'task_complete', turn_id: 'turn' })}\n`;
  await writeFile(join(sessions, `small-${thread}.jsonl`), body);
  await writeFile(join(sessions, `big-${thread}.jsonl`), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal(await readCodexHistoryFingerprint(root, thread), undefined);
});

test('a symlink named for the thread is not read', async () => {
  const root = await home();
  const sessions = join(root, 'sessions', '2026', '11', '19');
  const real = join(sessions, 'real.jsonl');
  await writeFile(real, `${line('event_msg', { type: 'task_complete', turn_id: 'turn' })}\n`);
  await symlink(real, join(sessions, `link-${thread}.jsonl`));
  assert.equal(await readCodexHistoryFingerprint(root, thread), undefined);
});
