import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function groupAbsent(pid) {
  try { process.kill(-pid, 0); return false; }
  catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

async function until(predicate, milliseconds) {
  const end = performance.now() + milliseconds;
  while (!predicate() && performance.now() < end) await delay(20);
  return predicate();
}

for (const mode of ['success', 'diagnostic', 'nonzero', 'signal', 'missing', 'ordinary', 'ignored']) {
  test(`compiler command preserves ${mode} outcome`, { skip: process.platform === 'win32' }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'switchboard-command-')));
    let child;
    let closed = false;
    let spawnError;
    let status;
    let signal;
    let expired = false;
    let started = false;
    let heartbeatContinued = false;
    let groupCeased = false;
    const failures = [];
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/compiler-command-owner.mjs', import.meta.url)), mode, root], {
        cwd: root, env: Object.assign(Object.create(null), { TMPDIR: root, LANG: 'C', TZ: 'UTC' }),
        detached: true, stdio: 'ignore',
      });
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (code, reason) => { status = code; signal = reason; closed = true; });
      if (mode === 'ordinary' || mode === 'ignored') {
        const heartbeat = join(root, 'heartbeat');
        const ticking = () => existsSync(heartbeat) && Number(readFileSync(heartbeat, 'utf8')) > 0;
        await until(() => closed || ticking(), 6000);
        started = ticking();
        const initial = started ? readFileSync(heartbeat, 'utf8') : undefined;
        expired = !await until(() => closed, 6000);
        heartbeatContinued = started && readFileSync(heartbeat, 'utf8') !== initial;
      } else expired = !await until(() => closed, 6000);
    } catch (error) { failures.push(error); }
    try {
      if (child?.pid && !groupAbsent(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } catch (error) { failures.push(error); }
    try {
      assert(await until(() => !child || closed, 3000), `Owner close uncertain; retained ${root}`);
    } catch (error) { failures.push(error); }
    try {
      groupCeased = !child?.pid || await until(() => groupAbsent(child.pid), 3000);
      assert(groupCeased, `Group cessation uncertain; retained ${root}`);
    } catch (error) { failures.push(error); }
    try { assert.ifError(spawnError); }
    catch (error) { failures.push(error); }
    try {
      writeFileSync(join(root, 'supervision.json'), JSON.stringify({
        pid: child?.pid, status, signal, closed, groupCeased, expired, started, heartbeatContinued,
        failures: failures.map((error) => String(error?.stack ?? error)),
      }));
    } catch (error) { failures.push(error); }
    if (failures.length) throw new Error(`Compiler command ${mode} failed; retained ${root}`, {
      cause: new AggregateError(failures, 'Command observation and cleanup failures'),
    });
    try {
      assert(!expired, 'command must return without the external watchdog killing its group');
      assert.equal(status, 0);
      assert.equal(signal, null);
      const result = JSON.parse(readFileSync(join(root, 'returned.json'), 'utf8'));
      const evidence = JSON.parse(readFileSync(join(root, 'evidence.json'), 'utf8'));
      assert.equal(evidence.cwd, root);
      for (const key of ['status', 'signal', 'stdout', 'stderr']) assert.deepEqual(evidence[key], result[key], key);
      assert.equal(evidence.error ?? null, result.error);
      if (mode === 'ordinary' || mode === 'ignored') {
        assert(started, 'The timeout child installed its signal policy and produced a heartbeat');
        assert(heartbeatContinued, 'The timeout child continued its heartbeat before cessation');
        assert.equal(result.code, 'ETIMEDOUT');
        assert.equal(result.status, null);
        assert.equal(result.signal, 'SIGKILL');
        assert.equal(result.stdout, 'partial stdout\n');
        assert.equal(result.stderr, 'partial stderr\n');
      } else if (mode === 'missing') {
        assert.equal(result.code, 'ENOENT');
        assert.equal(result.status, null);
        assert.equal(result.signal, null);
      } else if (mode === 'signal') {
        assert.equal(result.code, null);
        assert.equal(result.status, null);
        assert.equal(result.signal, 'SIGTERM');
      } else {
        assert.equal(result.code, null);
        assert.equal(result.status, { success: 0, diagnostic: 1, nonzero: 2 }[mode]);
        assert.equal(result.signal, null);
        assert.equal(result.stdout, mode === 'success' ? 'inert stdout\n'
          : mode === 'diagnostic' ? 'fixture.ts(1,1): error TS2322: synthetic diagnostic\n' : '');
        assert.equal(result.stderr, mode === 'success' ? 'inert stderr\n' : '');
      }
      rmSync(root, { recursive: true });
      assert(!existsSync(root));
    } catch (error) {
      throw new Error(`Compiler command ${mode} failed; retained ${root}`, { cause: error });
    }
  });
}
