import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changeRead } from './fingerprint-io.mjs';
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
    for (const mutate of [async () => true, async () => { await truncate(path, 0); },
      async () => { await writeFile(path, body.replace('prefix', 'mutate')); },
      async () => { await rename(path, join(root, 'old')); await writeFile(path, body); }]) {
      await writeFile(path, body);
      changeRead(mutate);
      assert.equal(await readCodexHistoryFingerprint(root, 'thread'), undefined);
    }
  } finally { changeRead(undefined); await rm(root, { recursive: true, force: true }); }
});
