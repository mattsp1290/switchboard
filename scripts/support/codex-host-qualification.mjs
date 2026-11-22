import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function dedicatedHome(home, defaultHome) {
  if (!home || !isAbsolute(home)) throw new Error('dedicated-home-required');
  const canonical = await realpath(home);
  const actual = await stat(canonical);
  if (!actual.isDirectory()) throw new Error('dedicated-home-required');
  let normal;
  try { normal = await realpath(defaultHome); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (normal) {
    const identity = await stat(normal);
    if (canonical === normal || (actual.dev === identity.dev && actual.ino === identity.ino)) throw new Error('dedicated-home-required');
  }
  return canonical;
}

// The live gate may approve only its one synthetic operation, never arbitrary model output.
export function scopedCommand(pending, cwd, marker) {
  if (pending.kind !== 'pending' || pending.calls.length || pending.approvals.length !== 1) return false;
  const { method, params } = pending.approvals[0].request.data;
  if (method !== 'item/commandExecution/requestApproval' || params.cwd !== cwd) return false;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(cwd) || !/^\/[A-Za-z0-9._/-]+$/.test(marker)) return false;
  const command = `/usr/bin/touch ${marker}`;
  const allowed = [command, `/bin/sh -c '${command}'`];
  return allowed.includes(params.command);
}

export function scopedFileChange(pending, item, file) {
  if (pending.kind !== 'pending' || pending.calls.length || pending.approvals.length !== 1) return false;
  const approval = pending.approvals[0];
  if (approval.request.data.method !== 'item/fileChange/requestApproval' || item?.id !== approval.target.tool.nativeToolCallId
    || item.type !== 'fileChange' || !Array.isArray(item.changes) || item.changes.length !== 1) return false;
  const change = item.changes[0];
  if (change.path !== file || change.kind?.type !== 'update' || change.kind.move_path != null || typeof change.diff !== 'string') return false;
  const lines = change.diff.trimEnd().split('\n');
  if (lines[0]?.startsWith('--- ') && lines[1]?.startsWith('+++ ')) lines.splice(0, 2);
  return lines.length === 3 && /^@@ -1(?:,1)? \+1(?:,1)? @@$/.test(lines[0])
    && lines[1] === '-old' && lines[2] === '+new';
}

async function reapedWithin(exited, timeoutMs) {
  let timer;
  try { return await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
export async function stopChildren(children, timeoutMs = 5000) {
  async function stopped(group, exited) {
    const deadline = Date.now() + timeoutMs;
    while (group.alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(25, timeoutMs)));
    return !group.alive() && await reapedWithin(exited, Math.max(1, deadline - Date.now()));
  }
  let clean = true;
  for (const { group, exited } of children) {
    try {
      if (group.alive()) group.signal('SIGTERM');
      if (await stopped(group, exited)) continue;
      if (group.alive()) group.signal('SIGKILL');
      if (!(await stopped(group, exited))) clean = false;
    } catch { clean = false; }
  }
  return clean;
}

export async function closeAdapter(adapter, timeoutMs = 10000) {
  let timer;
  const closed = Promise.resolve().then(() => adapter?.close()).then((result) => result?.kind === 'error' ? 'failed' : 'closed', () => 'failed');
  try { return await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export function qualificationPassed(report) {
  const mandatory = ['command-accept', 'command-cancel', 'command-interrupt', 'image-4mib'];
  return !report.precondition && mandatory.every((id) => report.scenarios.some((scenario) => scenario.id === id && scenario.status === 'passed'))
    && report.scenarios.every((scenario) => scenario.status !== 'failed');
}

export async function qualificationFingerprint(root, runtimeRoot = root) {
  async function tree(base, directories, include, manifests) {
    const files = [...manifests];
    async function walk(directory) {
      for (const entry of await readdir(join(base, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error('unhashed-symlink');
        if (entry.isDirectory()) await walk(path);
        else if (include(path)) files.push(path);
      }
    }
    for (const directory of directories) await walk(directory);
    const digest = createHash('sha256');
    for (const path of files.sort()) digest.update(`${path}\0${createHash('sha256').update(await readFile(join(base, path))).digest('hex')}\n`);
    return { sha256: digest.digest('hex'), files: files.length };
  }
  const source = await tree(root, ['src/core', 'src/adapters/codex'], (path) => path.endsWith('.ts'), ['src/index.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'scripts/qualify-codex-host-direct.mjs', 'scripts/live-baseline-engines.mjs', 'scripts/support/codex-host-qualification.mjs', 'scripts/support/qualification-image.mjs']);
  const runtime = await tree(runtimeRoot, ['dist/core', 'dist/adapters/codex'], (path) => path.endsWith('.js'), ['dist/index.js', 'package.json']);
  return { source, runtime };
}

/** Correlate privately; serialize only status enums into the durable report. */
export function targetTerminals(terminals, approval) {
  const params = approval?.request?.data?.params;
  if (typeof params?.threadId !== 'string' || typeof params.turnId !== 'string') return [];
  return terminals.filter((terminal) => terminal.threadId === params.threadId && terminal.turnId === params.turnId).map((terminal) => terminal.status);
}

/** A live scenario owns a referenced deadline until its report/cleanup path can run. */
export function scenarioDeadline(parent, milliseconds = 180000) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), milliseconds);
  return { signal: AbortSignal.any([parent, deadline.signal]), dispose: () => clearTimeout(timer) };
}
