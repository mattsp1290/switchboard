import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { qualificationImage } from '../../scripts/support/qualification-image.mjs';

test('direct qualification stays inert without its explicit gate', () => {
  const env = { ...process.env }; delete env.SWITCHBOARD_QUALIFY_CODEX_HOST;
  const result = spawnSync(process.execPath, ['scripts/qualify-codex-host-direct.mjs'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Skipped:/);
  assert.equal(result.stderr, '');
});
test('native qualification attachment is an exact 4 MiB valid PNG', () => {
  const png = qualificationImage();
  assert.equal(png.length, 4194304);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    chunks.push(type);
    const bytes = png.subarray(at + 4, at + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal(png.readUInt32BE(at + 8 + length), (crc ^ 0xffffffff) >>> 0, `${type} CRC`);
    if (type === 'IHDR') { assert.equal(png.readUInt32BE(at + 8), 64); assert.equal(png.readUInt32BE(at + 12), 64); }
    if (type === 'IDAT') assert.equal(inflateSync(png.subarray(at + 8, at + 8 + length)).length, 64 * 257);
    at += length + 12;
  }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'tEXt', 'IEND']);
});

import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedicatedHome, scopedCommand, scopedFileChange, stopChildren, closeAdapter, qualificationPassed, qualificationFingerprint, targetTerminals } from '../../scripts/support/codex-host-qualification.mjs';

const approval = (method, params) => ({ calls: [], kind: 'pending', approvals: [{ request: { data: { method, params } }, target: { tool: { nativeToolCallId: 'item' } } }] });
test('live command approval is restricted to the exact marker operation and workspace', () => {
  const method = 'item/commandExecution/requestApproval';
  const valid = { command: "/bin/sh -c '/usr/bin/touch /scratch/marker'", cwd: '/scratch' };
  assert(scopedCommand(approval(method, valid), '/scratch', '/scratch/marker'));
  for (const params of [{ ...valid, command: `${valid.command}; touch /other` }, { ...valid, cwd: '/other' }, { ...valid, command: 'rm -rf /scratch' }]) {
    assert(!scopedCommand(approval(method, params), '/scratch', '/scratch/marker'));
  }
  for (const marker of ["/scratch/marker';id", '/scratch/a b', '/scratch/a;id', '/scratch/$(id)']) {
    assert(!scopedCommand(approval(method, { command: `/bin/sh -lc '/usr/bin/touch ${marker}'`, cwd: '/scratch' }), '/scratch', marker));
  }
  assert(!scopedCommand(approval(method, { ...valid, command: "/bin/zsh -lc '/usr/bin/touch /scratch/marker'" }), '/scratch', '/scratch/marker'));
  const extra = approval(method, valid); extra.approvals.push(extra.approvals[0]);
  assert(!scopedCommand(extra, '/scratch', '/scratch/marker'));
});
test('live patch approval rejects extra files, moves and edits', () => {
  const pending = approval('item/fileChange/requestApproval', {});
  const change = { path: '/scratch/file.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new\n' };
  const item = { type: 'fileChange', id: 'item', changes: [change] };
  assert(scopedFileChange(pending, item, change.path));
  for (const changes of [[change, change], [{ ...change, path: '/other' }], [{ ...change, kind: { type: 'update', move_path: '/other' } }], [{ ...change, diff: `${change.diff}+other\n` }], [{ ...change, diff: '@@ -1 +1,2 @@\n-old\n+new\n+++ extra\n' }]]) {
    assert(!scopedFileChange(pending, { ...item, changes }, change.path));
  }
});
test('dedicated qualification home rejects aliases of the real home before native IO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-home-'));
  try {
    const normal = join(root, 'normal'); await mkdir(normal); await symlink(normal, join(root, 'alias'));
    await assert.rejects(dedicatedHome(join(root, 'alias'), normal), /dedicated-home-required/);
    const dedicated = join(root, 'dedicated'); await mkdir(dedicated);
    assert.equal(await dedicatedHome(dedicated, normal), dedicated.replace(/^\/var\//, '/private/var/'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('owned process group cleanup requires both group absence and parent exit', async () => {
  const calls = []; let alive = true;
  const exited = Promise.withResolvers();
  const group = { alive: () => alive, signal(signal) { calls.push(signal); alive = false; exited.resolve(); } };
  assert.equal(await stopChildren([{ group, exited: exited.promise }], 5), true); assert.deepEqual(calls, ['SIGTERM']);
  assert.equal(await stopChildren([{ group: { alive: () => true, signal() {} }, exited: Promise.resolve() }], 5), false);
  assert.equal(await stopChildren([{ group: { alive: () => false, signal() {} }, exited: new Promise(() => {}) }], 5), false);
});

test('qualification close timeouts fail while late rejection remains observed', async () => {
  const late = Promise.withResolvers();
  assert.equal(await closeAdapter({ close: () => late.promise }, 5), 'timeout');
  late.reject(new Error('late close')); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await closeAdapter({ close() { throw new Error('close'); } }), 'failed');
});

test('any failed optional scenario fails the aggregate qualification', () => {
  const scenarios = ['command-accept', 'command-cancel', 'command-interrupt', 'image-4mib'].map((id) => ({ id, status: 'passed' }));
  assert(qualificationPassed({ scenarios }));
  assert(!qualificationPassed({ scenarios, precondition: 'precondition-failed' }));
  assert(!qualificationPassed({ scenarios: [...scenarios, { id: 'file-change', status: 'failed', reason: 'cleanup-unconfirmed' }] }));
  assert(qualificationPassed({ scenarios: [...scenarios, { id: 'file-change', status: 'not-covered' }] }));
});

test('qualification fingerprints include codec, PNG generator and other transitive source/runtime files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-hash-'));
  try {
    for (const dir of ['src', 'adapters', 'scripts', 'dist']) await mkdir(join(root, dir));
    for (const file of ['package.json', 'package-lock.json']) await writeFile(join(root, file), '{}');
    await writeFile(join(root, 'src', 'wire.ts'), 'codec'); await writeFile(join(root, 'scripts', 'image.mjs'), 'png');
    await writeFile(join(root, 'dist', 'wire.js'), 'built codec');
    const original = await qualificationFingerprint(root);
    await writeFile(join(root, 'src', 'wire.ts'), 'changed codec');
    const changed = await qualificationFingerprint(root); assert.notEqual(changed.source.sha256, original.source.sha256);
    await writeFile(join(root, 'scripts', 'image.mjs'), 'changed png');
    assert.notEqual((await qualificationFingerprint(root)).source.sha256, changed.source.sha256);
    await writeFile(join(root, 'dist', 'wire.js'), 'changed built codec');
    assert.notEqual((await qualificationFingerprint(root)).runtime.sha256, original.runtime.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owned group cleanup reaps a descendant with independent stdio after its parent exits', { timeout: 10000 }, async () => {
  const childCode = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.stdout.write(String(child.pid));";
  const parent = spawn(process.execPath, ['-e', childCode], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; parent.stdout.on('data', (bytes) => { output += bytes; });
  const exited = new Promise((resolve, reject) => { parent.once('close', resolve); parent.once('error', reject); });
  const group = {
    alive() { try { process.kill(-parent.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } },
    signal(signal) { try { process.kill(-parent.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } },
  };
  try {
    await exited; assert(/^\d+$/.test(output)); assert(group.alive());
    assert.equal(await stopChildren([{ group, exited }], 2000), true); assert.equal(group.alive(), false);
  } finally { if (parent.pid) { try { group.signal('SIGKILL'); } catch {} } }
});

test('qualification terminals match the exact approved thread and turn before redaction', () => {
 const approval={request:{data:{params:{threadId:'thread',turnId:'turn'}}}};
 assert.deepEqual(targetTerminals([{threadId:'other',turnId:'turn',status:'completed'},{threadId:'thread',turnId:'old',status:'interrupted'}],approval),[]);
 assert.deepEqual(targetTerminals([{threadId:'thread',turnId:'turn',status:'interrupted'}],approval),['interrupted']);
});
