import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const recordPath = join(root, 'docs/qualification/cursor-live.json');
const ATTEMPTS = 3;
const DEADLINE_MS = 180_000;
const FIRST = 'Create plain file live.txt in the working directory. Its entire contents are the single line cursor-live-file. Do not create any other file.';
const FOLLOW = 'Change live.txt so its entire contents are the single line cursor-live-follow-up.';

if (!process.env.CURSOR_API_KEY || !process.env.CURSOR_QUALIFICATION_MODEL) process.exit(1);
const apiKey = process.env.CURSOR_API_KEY;
const model = process.env.CURSOR_QUALIFICATION_MODEL;
delete process.env.CURSOR_API_KEY;

function fail() {
  process.stderr.write('cursor live qualification failed\n');
  process.exitCode = 1;
}

async function git(args, cwd) {
  const result = await exec('git', args, { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return result.stdout;
}

async function scratch() {
  const home = await mkdtemp(join(tmpdir(), 'cursor-live-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'cursor-live-repo-'));
  const session = await mkdtemp(join(tmpdir(), 'cursor-live-session-'));
  const template = await mkdtemp(join(tmpdir(), 'cursor-live-template-'));
  const remove = async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
    await rm(session, { recursive: true, force: true });
    await rm(template, { recursive: true, force: true });
  };
  try {
    await mkdir(session, { recursive: true, mode: 0o700 });
    await git(['-c', `init.templateDir=${template}`, '-c', 'commit.gpgsign=false', 'init', '-b', 'main'], repo);
    await writeFile(join(repo, 'README.md'), 'cursor-live\n');
    await git(['add', 'README.md'], repo);
    await git(['-c', 'user.name=switchboard', '-c', 'user.email=switchboard@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'cursor-live'], repo);
    return { home, repo, session, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

function fileOk(text, expected) {
  return text === expected || text === `${expected}\n`;
}

function otherPaths(porcelain) {
  return porcelain.split('\n').filter(line => line.length > 0 && line.slice(3) !== 'live.txt');
}

function adapterEvent(event) {
  if (event === null || typeof event !== 'object') return true;
  if (Object.hasOwn(event, 'args') || Object.hasOwn(event, 'result')) return true;
  if (event.kind !== 'tool') return false;
  const keys = Object.keys(event);
  return keys.length !== 4 || keys.some(key => !['kind', 'callId', 'name', 'status'].includes(key));
}

async function namedFile(dir, name) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.some(entry => entry.isFile() && entry.name === name);
}

async function turn(runtime, text, agentId, signal) {
  if (signal?.aborted) return { agentId, outcome: 'interrupted', events: [] };
  const events = [];
  const started = await runtime.start({
    text, ...(agentId === undefined ? {} : { agentId }), onEvent: event => events.push(event),
  });
  const abort = () => { void started.abort().catch(() => {}); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const outcome = await started.finished;
    return { agentId: started.agentId, outcome, events };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function attempt(cursor, localOptions, current, signal, gate) {
  process.env.HOME = current.home;
  process.env.USERPROFILE = current.home;
  const local = localOptions(current.repo, current.session);
  if (local.sandboxOptions.enabled !== true || local.enableAgentRetries !== false
    || local.settingSources.length !== 1 || local.settingSources[0] !== 'project') return { kind: 'hard', local };
  const runtime = cursor.createCursorRuntime({
    cwd: current.repo, sessionDirectory: current.session, apiKey, model,
  });
  gate.runtimes.push(runtime);
  try {
    const report = await runtime.readinessReport();
    if (report.verdict === 'blocked') return { kind: 'hard', local };
    if (report.verdict !== 'unverified' || report.remediation.code !== 'check_unavailable') return { kind: 'hard', local };
    if (signal?.aborted) return { kind: 'deadline', local };
    let first;
    try { first = await turn(runtime, FIRST, undefined, signal); }
    catch (error) { return { kind: error instanceof Error && error.message === 'Cursor operation failed.' ? 'hard' : 'adapter', local }; }
    if (first.events.some(adapterEvent)) return { kind: 'adapter', local };
    if (first.outcome !== 'completed' || !first.events.some(event => event.kind === 'tool' && event.status === 'completed')) {
      return { kind: 'hard', local };
    }
    let text;
    try { text = await readFile(join(current.repo, 'live.txt'), 'utf8'); }
    catch { text = undefined; }
    const status = await git(['status', '--porcelain'], current.repo);
    if (!fileOk(text, 'cursor-live-file') || otherPaths(status).length > 0) return { kind: 'miss', local };
    if (signal?.aborted) return { kind: 'deadline', local };
    await runtime.close();
    const followRuntime = cursor.createCursorRuntime({
      cwd: current.repo, sessionDirectory: current.session, apiKey, model,
    });
    gate.runtimes.push(followRuntime);
    try {
      if (signal?.aborted) return { kind: 'deadline', local };
      let follow;
      try { follow = await turn(followRuntime, FOLLOW, first.agentId, signal); }
      catch (error) { return { kind: error instanceof Error && error.message === 'Cursor operation failed.' ? 'hard' : 'adapter', local }; }
      if (follow.events.some(adapterEvent)) return { kind: 'adapter', local };
      if (follow.agentId !== first.agentId) return { kind: 'adapter', local };
      if (follow.outcome !== 'completed') return { kind: 'hard', local };
      const updated = await readFile(join(current.repo, 'live.txt'), 'utf8');
      if (!fileOk(updated, 'cursor-live-follow-up')) return { kind: 'hard', local };
      if (!await namedFile(current.session, 'agents.ndjson') || await namedFile(current.home, 'agents.ndjson')) {
        return { kind: 'adapter', local };
      }
      return { kind: 'pass', local };
    } finally { await followRuntime.close(); }
  } finally { await runtime.close(); }
}

async function publish(local, attempts) {
  const body = `${JSON.stringify({
    sdk: '1.4.2',
    sandbox: local.sandboxOptions.enabled,
    settingSources: [...local.settingSources],
    modelSupplied: true,
    firstTurn: 'completed',
    followUp: 'completed',
    toolCompleted: true,
    fileCreated: true,
    fileUpdated: true,
    resumedSameAgent: true,
    attempts,
  }, null, 2)}\n`;
  const temporary = join(root, 'docs/qualification', `.cursor-live-${process.pid}.json`);
  await writeFile(temporary, body);
  try { await rename(temporary, recordPath); }
  finally { await rm(temporary, { force: true }); }
}

async function main() {
  const configUrl = pathToFileURL(join(root, 'dist/cursor/config.js')).href;
  const cursorUrl = pathToFileURL(join(root, 'dist/cursor/index.js')).href;
  let createCursorRuntime;
  let localOptions;
  for (let attempts = 1; attempts <= ATTEMPTS; attempts += 1) {
    let current;
    let timer;
    let pending;
    const gate = { runtimes: [] };
    const deadline = new AbortController();
    try {
      current = await scratch();
      process.env.HOME = current.home;
      process.env.USERPROFILE = current.home;
      if (!localOptions) {
        ({ cursorLocalOptions: localOptions } = await import(configUrl));
        ({ createCursorRuntime } = await import(cursorUrl));
      }
      pending = attempt({ createCursorRuntime }, localOptions, current, deadline.signal, gate);
      const result = await Promise.race([
        pending,
        new Promise(resolve => {
          timer = setTimeout(() => {
            deadline.abort();
            resolve({ kind: 'deadline' });
          }, DEADLINE_MS);
        }),
      ]);
      if (result.kind === 'pass') {
        await publish(result.local, attempts);
        return;
      }
      if (result.kind !== 'miss' || attempts === ATTEMPTS) { fail(); return; }
    } catch { fail(); return; }
    finally {
      clearTimeout(timer);
      if (deadline.signal.aborted) {
        await Promise.all(gate.runtimes.map(runtime => runtime.close().catch(() => {})));
      }
      await pending?.catch(() => {});
      if (current) await current.remove();
    }
  }
}

await main();
