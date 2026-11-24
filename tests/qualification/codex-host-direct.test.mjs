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
import { dedicatedHome, scopedCommand, scopedFileChange, verifyFinalFiles, stopChildren, closeAdapter, qualificationPassed, qualificationFingerprint, targetTerminals } from '../../scripts/support/codex-host-qualification.mjs';

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
  for (const changes of [[change, change], [{ ...change, path: '/other' }], [{ ...change, kind: { type: 'update', move_path: '/other' } }], [{ ...change, diff: '@@ -1 +1 @@\n-old\n+new \n' }], [{ ...change, diff: `${change.diff}+other\n` }], [{ ...change, diff: '@@ -1 +1,2 @@\n-old\n+new\n+++ extra\n' }]]) {
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
    for (const dir of ['src/core', 'src/adapters/codex', 'scripts/support', 'dist/core', 'dist/adapters/codex', 'adapters/cursor']) await mkdir(join(root, dir), { recursive: true });
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'src/index.ts', 'dist/index.js', 'scripts/qualify-codex-host-direct.mjs', 'scripts/live-baseline-engines.mjs', 'scripts/support/codex-host-qualification.mjs']) await writeFile(join(root, file), '{}');
    await writeFile(join(root, 'src/adapters/codex/wire.ts'), 'codec'); await writeFile(join(root, 'scripts/support/qualification-image.mjs'), 'png');
    await writeFile(join(root, 'dist/adapters/codex/wire.js'), 'built codec');
    const original = await qualificationFingerprint(root);
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}');
    assert.notEqual((await qualificationFingerprint(root)).source.sha256, original.source.sha256);
    await writeFile(join(root, 'tsconfig.json'), '{}');
    await writeFile(join(root, 'adapters/cursor/unrelated.ts'), 'unrelated');
    assert.deepEqual(await qualificationFingerprint(root), original);
    await writeFile(join(root, 'src/adapters/codex/wire.ts'), 'changed codec');
    const changed = await qualificationFingerprint(root); assert.notEqual(changed.source.sha256, original.source.sha256);
    await writeFile(join(root, 'scripts/support/qualification-image.mjs'), 'changed png');
    assert.notEqual((await qualificationFingerprint(root)).source.sha256, changed.source.sha256);
    await writeFile(join(root, 'dist/adapters/codex/wire.js'), 'changed built codec');
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

test('live scenario deadline owns a referenced timer and releases it after completion',async(t)=>{
 const {scenarioDeadline}=await import('../../scripts/support/codex-host-qualification.mjs');const schedule=globalThis.setTimeout;let timer;
 t.mock.method(globalThis,'setTimeout',(...args)=>{timer=schedule(...args);return timer;});
 const deadline=scenarioDeadline(new AbortController().signal,10000);assert.equal(timer.hasRef(),true);deadline.dispose();assert.equal(deadline.signal.aborted,false);
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {scenarioDeadline} from ${JSON.stringify(new URL('../../scripts/support/codex-host-qualification.mjs',import.meta.url).href)};const deadline=scenarioDeadline(new AbortController().signal,10000);deadline.dispose();`],{timeout:1000,encoding:'utf8'});assert.equal(child.status,0,child.stderr);
});

import { pathToFileURL } from 'node:url';
import { launch, snapshotQualificationSource } from '../../scripts/qualify-codex-host-direct.mjs';

for (const fault of ['malformed-patch', 'overflow']) test(`the actual qualification writer refuses ${fault} evidence`, { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qualification-writer-'));
  const children = [];
  try {
    const params = { threadId: 'thread', turnId: 'turn', itemId: 'item' };
    const changes = [{ path: join(cwd, 'file.txt'), kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new\n' }];
    const frames = [{ method: 'item/started', params: { ...params, item: { type: 'fileChange', id: 'item', changes } } },
      ...Array.from({ length: fault === 'overflow' ? 17 : 1 }, (_, n) => ({ id: `approval-${n}`, method: 'item/fileChange/requestApproval', params })),
      ...(fault === 'malformed-patch' ? [{ method: 'item/fileChange/patchUpdated', params: { ...params, changes: [null] } }] : []),
      { method: 'fixture/ready' }];
    const fixture = join(cwd, 'fixture.mjs');
    await writeFile(fixture, `process.stdout.write(${JSON.stringify(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n')});process.stdin.resume();`);
    const native = await launch({ executable: process.execPath, args: ['node', fixture], cwd, env: { PATH: '/usr/bin:/bin' } }, [], children, [], [], [], []);
    const ready = Promise.withResolvers(); let buffered = '';
    native.channel.listen({ data(bytes) { buffered += Buffer.from(bytes).toString(); if (buffered.includes('fixture/ready')) ready.resolve(); }, ended() {}, diagnostic() {} });
    await Promise.race([ready.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture deadline')), 3000).unref())]);
    const frame = { id: fault === 'overflow' ? 'approval-16' : 'approval-0', result: { decision: 'accept' } };
    await assert.rejects(native.channel.write(Buffer.from(JSON.stringify(frame) + '\n'), new AbortController().signal));
  } finally { assert.equal(await stopChildren(children), true); await rm(cwd, { recursive: true, force: true }); }
});

test('qualification imports the copied modules even if the original helper changes', async () => {
  const source = await mkdtemp(join(tmpdir(), 'qualification-snapshot-')); let snapshot;
  try {
    for (const path of ['src', 'scripts/support', 'node_modules']) await mkdir(join(source, path), { recursive: true });
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json']) await writeFile(join(source, path), '{}');
    await writeFile(join(source, 'scripts/support/helper.mjs'), 'export const value = "before";');
    await writeFile(join(source, 'scripts/qualify-codex-host-direct.mjs'), 'export { value } from "./support/helper.mjs";');
    snapshot = await snapshotQualificationSource(source);
    await writeFile(join(source, 'scripts/support/helper.mjs'), 'export const value = "after";');
    const loaded = await import(pathToFileURL(join(snapshot, 'scripts/qualify-codex-host-direct.mjs')).href);
    assert.equal(loaded.value, 'before');
  } finally { if (snapshot) await rm(snapshot, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
});

import { exists, snapshotQualificationBinary } from '../../scripts/qualify-codex-host-direct.mjs';
import { execFileSync } from 'node:child_process';
test('qualification excludes account and effective home aliases',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qualification-dual-home-'));try{const account=join(root,'account');const effective=join(root,'effective');await mkdir(account);await mkdir(effective);await symlink(account,join(root,'alias'));await assert.rejects(dedicatedHome(join(root,'alias'),effective,account),/dedicated-home-required/);}finally{await rm(root,{recursive:true,force:true});}
});
test('marker absence requires ENOENT rather than any inspection error',async()=>{
 assert.equal(await exists('/marker',async()=>{throw Object.assign(new Error('absent'),{code:'ENOENT'});}),false);await assert.rejects(exists('/marker',async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});}),{code:'EACCES'});
});
test('qualification launches the captured binary after its installed path is replaced',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qualification-binary-'));try{const source=join(root,'installed');await writeFile(source,'#!/bin/sh\nprintf before\n',{mode:0o700});const snapshot=await snapshotQualificationBinary(source,root);await writeFile(source,'#!/bin/sh\nprintf after\n');assert.equal(execFileSync(snapshot,{encoding:'utf8'}),'before');}finally{await rm(root,{recursive:true,force:true});}
});
test('file qualification writer admits only the selected one-time approval', {timeout:10000},async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'qualification-once-'));const children=[];try{
 const params={threadId:'thread',turnId:'turn',itemId:'item'};const changes=[{path:join(cwd,'file.txt'),kind:{type:'update',move_path:null},diff:'@@ -1 +1 @@\n-old\n+new\n'}];const frames=[{method:'item/started',params:{...params,item:{type:'fileChange',id:'item',changes}}},{id:'approval',method:'item/fileChange/requestApproval',params},{method:'fixture/ready'}];const fixture=join(cwd,'fixture.mjs');await writeFile(fixture,`process.stdout.write(${JSON.stringify(frames.map(f=>JSON.stringify(f)).join('\n')+'\n')});process.stdin.resume();`);const native=await launch({executable:process.execPath,args:['node',fixture],cwd,env:{PATH:'/usr/bin:/bin'}},[],children,[],[],[],[]);const ready=Promise.withResolvers();let buffered='';native.channel.listen({data(bytes){buffered+=Buffer.from(bytes).toString();if(buffered.includes('fixture/ready'))ready.resolve();},ended(){},diagnostic(){}});await ready.promise;const reply=decision=>Buffer.from(JSON.stringify({id:'approval',result:{decision}})+'\n');await assert.rejects(native.channel.write(reply('acceptForSession'),new AbortController().signal),/file-decision-mismatch/);await native.channel.write(reply('accept'),new AbortController().signal);
 }finally{assert.equal(await stopChildren(children),true);await rm(cwd,{recursive:true,force:true});}
});

import { waitForTargetTerminals } from '../../scripts/support/codex-host-qualification.mjs';
test('qualification waits for the selected raw terminal arriving after other activity',async()=>{
 const selected={request:{data:{params:{threadId:'thread',turnId:'selected'}}}};const terminals=[{threadId:'thread',turnId:'other',status:'completed'}];const waiting=waitForTargetTerminals(terminals,selected,AbortSignal.timeout(1000));setTimeout(()=>terminals.push({threadId:'thread',turnId:'selected',status:'interrupted'}),5);assert.deepEqual(await waiting,['interrupted']);await assert.rejects(waitForTargetTerminals([],selected,AbortSignal.timeout(5)));
});
test('private source snapshots reject absolute helper symlinks before import',async()=>{
 const source=await mkdtemp(join(tmpdir(),'qualification-linked-source-'));try{for(const dir of ['src','scripts/support','node_modules'])await mkdir(join(source,dir),{recursive:true});for(const file of ['package.json','package-lock.json','tsconfig.json'])await writeFile(join(source,file),'{}');const target=join(source,'outside.mjs');await writeFile(target,'export const value="outside";');await symlink(target,join(source,'scripts/support/helper.mjs'));await assert.rejects(snapshotQualificationSource(source),/unhashed-symlink/);}finally{await rm(source,{recursive:true,force:true});}
});


test('file qualification refuses an extra grantRoot even for its scoped patch', () => {
  const file = '/tmp/qualification/file.txt';
  const pending = { kind: 'pending', calls: [], approvals: [{ request: { data: { method: 'item/fileChange/requestApproval', params: { grantRoot: '/tmp' } } }, target: { tool: { nativeToolCallId: 'patch' } } }] };
  const item = { type: 'fileChange', id: 'patch', changes: [{ path: file, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }] };
  assert.equal(scopedFileChange(pending, item, file), false);
  pending.approvals[0].request.data.params.grantRoot = null;
  assert.equal(scopedFileChange(pending, item, file), true);
});
test('final qualification detects writes performed during process cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-final-'));
  const path = join(root, 'marker'); const expected = [{ path, present: false }];
  try {
    assert.equal(await verifyFinalFiles(expected), true);
    let alive = true;
    const group = { alive: () => alive, signal() { alive = false; } };
    const exited = new Promise(resolve => { group.signal = () => { void writeFile(path, 'late').then(() => { alive = false; resolve(); }); }; });
    assert.equal(await stopChildren([{ group, exited }], 1000), true);
    assert.equal(await verifyFinalFiles(expected), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('final qualification requires regular synthetic fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qualification-types-'));
  try {
    const directory = join(root, 'directory'); await mkdir(directory);
    assert.equal(await verifyFinalFiles([{ path: directory, present: true }]), false);
    const target = join(root, 'target'); const link = join(root, 'link'); await writeFile(target, 'new\n'); await symlink(target, link);
    assert.equal(await verifyFinalFiles([{ path: link, present: true, contents: 'new\n' }]), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
