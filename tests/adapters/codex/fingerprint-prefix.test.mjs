import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, rename, rm, truncate, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changeRead, changeFinalStat, changeOpen, contentReads } from './fingerprint-io.mjs';
const source = new URL('../../../src/adapters/codex/fingerprint.ts', import.meta.url).href;
const io = new URL('./fingerprint-io.mjs', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === source && specifier === 'node:fs/promises') return { url: io, shortCircuit: true };
  return next(specifier, context);
} });
const { readCodexHistoryFingerprint } = await import(source);
hook.deregister();
test('fingerprint hashes the opening prefix and refuses mutation, replacement and short reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-prefix-'));
  await mkdir(join(root, 'sessions'));
  const path = join(root, 'sessions', 'rollout-thread.jsonl');
  const body = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'prefix' } })}\n`;
  try {
    await writeFile(path, body);
    changeRead(async () => { await appendFile(path, 'later append\n'); });
    assert.deepEqual(await readCodexHistoryFingerprint(root, 'thread'), { bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'), turnId: 'prefix' });
    await writeFile(path, body);
    changeRead(async () => { await appendFile(path, 'later append\n'); });
    assert.equal(await readCodexHistoryFingerprint(root, 'thread', true), undefined, 'resume verification refuses growth during the read');
    for (const mutate of [async () => true, async () => { await truncate(path, 0); },
      async () => { await writeFile(path, body.replace('prefix', 'mutate')); },
      async () => { await rename(path, join(root, 'old')); await writeFile(path, body); }]) {
      await writeFile(path, body);
      changeRead(mutate);
      assert.equal(await readCodexHistoryFingerprint(root, 'thread'), undefined);
    }
  } finally { changeRead(undefined); await rm(root, { recursive: true, force: true }); }
});

test('fingerprint rejects a rewrite between the final descriptor and named stat and an escaped sessions root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-final-stat-'));
  const outside = await mkdtemp(join(tmpdir(), 'codex-outside-'));
  const path = join(root, 'sessions', 'rollout-thread.jsonl');
  const body = '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"prefix"}}\n';
  try {
    await mkdir(join(root, 'sessions')); await writeFile(path, body);
    changeFinalStat(async () => { await writeFile(path, body.replace('prefix', 'mutate')); });
    assert.equal(await readCodexHistoryFingerprint(root, 'thread'), undefined);
    changeFinalStat(undefined); await rm(join(root, 'sessions'), { recursive: true });
    await writeFile(join(outside, 'rollout-thread.jsonl'), body); await symlink(outside, join(root, 'sessions'));
    assert.equal(await readCodexHistoryFingerprint(root, 'thread'), undefined);
  } finally { changeFinalStat(undefined); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('a directory replaced between enumeration and open is refused before content reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-open-race-'));
  const outside = await mkdtemp(join(tmpdir(), 'codex-open-outside-'));
  try {
    await mkdir(join(root, 'sessions'));
    const body = '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"owned"}}\n';
    await writeFile(join(root, 'sessions', 'rollout-thread.jsonl'), body);
    await writeFile(join(outside, 'rollout-thread.jsonl'), body);
    changeOpen(async () => { await rename(join(root, 'sessions'), join(root, 'old-sessions')); await symlink(outside, join(root, 'sessions')); });
    assert.equal(await readCodexHistoryFingerprint(root, 'thread'), undefined);
    assert.equal(contentReads(), 0);
  } finally { changeOpen(undefined); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
