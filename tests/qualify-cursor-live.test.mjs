import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { qualificationBody, replaceRecord } from '../scripts/cursor-live-record.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/qualify-cursor-live.mjs');
const tripwire = join(root, 'tests/support/native-sdk-tripwire.mjs');
const recordPath = join(root, 'docs/qualification/cursor-live.json');
const fields = [
  'sdk', 'sandbox', 'settingSources', 'modelSupplied', 'firstTurn', 'followUp',
  'toolCompleted', 'fileCreated', 'fileUpdated', 'resumedSameAgent', 'attempts',
];

test('a missing qualification variable exits before the record or the SDK', () => {
  const before = readFileSync(recordPath);
  const scripts = JSON.stringify(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts);
  assert.equal(scripts.includes('qualify-cursor-live.mjs'), false);
  const cases = [
    { keep: 'CURSOR_QUALIFICATION_MODEL', canary: 'canary-model', drop: 'CURSOR_API_KEY' },
    { keep: 'CURSOR_API_KEY', canary: 'canary-key', drop: 'CURSOR_QUALIFICATION_MODEL' },
  ];
  for (const item of cases) {
    const env = { ...process.env };
    delete env.CURSOR_API_KEY;
    delete env.CURSOR_QUALIFICATION_MODEL;
    env[item.keep] = item.canary;
    const result = spawnSync(process.execPath, ['--import', tripwire, script], { cwd: root, encoding: 'utf8', env });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 1);
    assert.equal(output.includes(item.canary), false);
    assert.equal(output.includes('native SDK tripwire'), false);
  }
  assert.deepEqual(readFileSync(recordPath), before);
});

test('the qualification record keeps its shape and a failed rename keeps the old bytes', async () => {
  const canaries = {
    apiKey: 'canary-key',
    model: 'canary-model',
    agentId: 'canary-agent',
    prompt: 'canary-prompt',
    path: '/tmp/canary-path',
    transcript: 'canary-transcript',
    cwd: '/tmp/canary-cwd',
    storeDirectory: '/tmp/canary-store',
  };
  const body = qualificationBody({
    sandboxOptions: { enabled: true },
    settingSources: ['project'],
    ...canaries,
  }, 1);
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed), fields);
  assert.equal(parsed.sdk, '1.4.2');
  assert.equal(parsed.sandbox, true);
  assert.deepEqual(parsed.settingSources, ['project']);
  assert.equal(parsed.modelSupplied, true);
  assert.equal(parsed.firstTurn, 'completed');
  assert.equal(parsed.followUp, 'completed');
  assert.equal(parsed.toolCompleted, true);
  assert.equal(parsed.fileCreated, true);
  assert.equal(parsed.fileUpdated, true);
  assert.equal(parsed.resumedSameAgent, true);
  assert.equal(parsed.attempts, 1);
  for (const canary of Object.values(canaries)) assert.equal(body.includes(canary), false);
  const directory = await mkdtemp(join(tmpdir(), 'cursor-live-record-'));
  const copy = join(directory, 'cursor-live.json');
  const original = await readFile(recordPath);
  try {
    await writeFile(copy, original);
    await assert.rejects(replaceRecord(directory, copy, body, {
      rename() { throw new Error('rename failed'); },
    }));
    assert.deepEqual(await readFile(copy), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
