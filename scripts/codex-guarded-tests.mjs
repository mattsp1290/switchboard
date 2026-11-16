// `npm run test:codex-guarded`: the trusted owner and the only child launcher. It runs the inert controls, then
// each Codex suite in its own fresh guarded Node process, and passes only on a complete verdict.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPS, COMMAND_DEADLINE_MS, CONTROLS, NODE_VERSION, ORACLE, PRELOADS, SUITES } from './support/codex-guard/plan.mjs';
import { failureCodes, judgeControl, parseRecord, reduceCommand, reduceRun } from './support/codex-guard/verdict.mjs';

/** @typedef {import('./support/codex-guard/plan.mjs').RunSpec} RunSpec */
/** @typedef {import('./support/codex-guard/verdict.mjs').ChannelEvent} ChannelEvent */
/** @typedef {import('./support/codex-guard/verdict.mjs').ProcessOutcome} ProcessOutcome */
/** @typedef {{ spec: RunSpec, events: ChannelEvent[], outcome: ProcessOutcome, tails: { stdout: string, stderr: string }, ms: number }} RunRecord */

class UsageError extends Error {}

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** Pre-entry checks. Any problem is a UsageError, reported before a child starts. */
function preflight() {
  const problems = [];
  if (process.argv.length > 2) problems.push(`takes no arguments, got: ${process.argv.slice(2).join(' ')}`);
  if (process.version !== NODE_VERSION) problems.push(`requires Node ${NODE_VERSION}, running ${process.version}`);
  if (process.execArgv.length) problems.push(`refuses launcher flags: ${process.execArgv.join(' ')}`);
  if (process.env.NODE_OPTIONS) problems.push('refuses a non-empty NODE_OPTIONS');
  if (process.env.NODE_TEST_CONTEXT !== undefined) problems.push('refuses to run inside another node:test runner');
  const planned = [...Object.values(PRELOADS), ...[...SUITES, ...CONTROLS.map((control) => control.run)].flatMap((run) => run.files)];
  for (const file of new Set(planned)) if (!isFile(file)) problems.push(`missing planned file ${file}`);
  for (const spec of SUITES) {
    if (!isFile(spec.entry)) continue;
    const source = readFileSync(spec.entry, 'utf8');
    for (const name of ORACLE[spec.name]) {
      if (!['\'', '"', '`'].some((quote) => source.includes(`test(${quote}${name}${quote}`))) problems.push(`${spec.name} has no test('${name}'`);
    }
  }
  if (problems.length) throw new UsageError(problems.join('\n  '));
}

/** @param {RunSpec} spec @param {string} nonce */
function preloadArgs(spec, nonce) {
  const url = (path, query) => `${pathToFileURL(path).href}?${new URLSearchParams(query)}`;
  const tripwire = ['--import', url(PRELOADS.tripwire, { nonce })];
  if (spec.preloads === 'tripwire-only') return tripwire;
  const guard = url(PRELOADS.guard, { run: spec.name, nonce });
  const sabotage = spec.preloads === 'sabotaged' ? ['--import', pathToFileURL(PRELOADS.sabotage).href] : [];
  return [...tripwire, ...sabotage, '--import', guard, '--test-reporter', guard];
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

/**
 * The only spawn in the delivery. Resolves after 'close' and a termination check; never rejects.
 * @param {RunSpec} spec @param {string} root @param {number} index @param {AbortSignal} signal
 * @returns {Promise<RunRecord>}
 */
async function runChild(spec, root, index, signal) {
  const dir = join(root, `${String(index).padStart(2, '0')}-${spec.name.replace(/[^\w.-]/g, '_')}`);
  mkdirSync(dir);
  const nonce = randomUUID();
  const started = Date.now();
  const child = spawn(process.execPath, [...preloadArgs(spec, nonce), spec.entry, ...spec.args],
    { cwd: dir, env: { TMPDIR: dir }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  /** @type {ChannelEvent[]} */
  const events = [];
  const tails = { stdout: '', stderr: '' };
  /** @type {ProcessOutcome['breach']} */
  let breach = null;
  /** @type {PromiseWithResolvers<{ code: number | null, signal: string | null, closed: boolean }>} */
  const { promise: ended, resolve: end } = Promise.withResolvers();
  child.once('close', (code, signalName) => end({ code, signal: signalName, closed: true }));
  child.on('error', () => { if (child.pid === undefined) end({ code: null, signal: null, closed: false }); });
  const stop = (kind) => {
    breach ??= kind;
    child.kill('SIGKILL');
    setTimeout(() => end({ code: child.exitCode, signal: child.signalCode, closed: false }), 5000).unref();
  };
  // Per-test inactivity starts at 'armed'; startup is bounded by the run total.
  let perTest;
  const total = setTimeout(() => stop('deadline'), spec.deadlines.totalMs);
  const onAbort = () => stop('aborted');
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  let pending = '';
  let channelBytes = 0;
  const accept = (line) => {
    const event = parseRecord(line, nonce);
    events.push(event);
    if (event.kind === 'armed' || (event.kind === 'test' && event.phase !== 'start')) {
      if (perTest) perTest.refresh();
      else perTest = setTimeout(() => stop('deadline'), spec.deadlines.perTestMs);
    }
  };
  child.stdio[3].setEncoding('utf8').on('data', (chunk) => {
    channelBytes += Buffer.byteLength(chunk);
    pending += chunk;
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.length > CAPS.line) stop('channel-overflow');
      else accept(line);
    }
    if (channelBytes > CAPS.channel || pending.length > CAPS.line) stop('channel-overflow');
  });
  for (const name of /** @type {const} */ (['stdout', 'stderr'])) {
    let bytes = 0;
    child[name].setEncoding('utf8').on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      tails[name] = (tails[name] + chunk).slice(-CAPS.tail);
      if (bytes > CAPS[name]) stop('output-overflow');
    });
  }

  const result = await ended;
  clearTimeout(perTest);
  clearTimeout(total);
  signal.removeEventListener('abort', onAbort);
  if (pending) events.push({ kind: 'malformed', reason: 'unterminated channel record' });
  const pid = child.pid ?? -1;
  const terminated = result.closed && pid > 0 && !alive(pid);
  return { spec, events, tails, ms: Date.now() - started,
    outcome: { pid, code: result.code, signal: result.signal, terminated, breach } };
}

const indent = (text) => text.trimEnd().split('\n').map((line) => `    ${line}`).join('\n');

/** @param {RunRecord} record @param {readonly { code: string, detail: string }[]} failures */
function describe(record, failures) {
  const lines = failures.slice(0, 40).map((failure) => `  ${failure.code}: ${failure.detail}`);
  if (failures.length > 40) lines.push(`  ... ${failures.length - 40} more`);
  lines.push(`  evidence: pid ${record.outcome.pid}, ${record.events.length} channel records, stdout tail ${record.tails.stdout.length} B, stderr tail ${record.tails.stderr.length} B`);
  if (record.tails.stdout) lines.push('  stdout tail:', indent(record.tails.stdout));
  if (record.tails.stderr) lines.push('  stderr tail:', indent(record.tails.stderr));
  return lines.join('\n');
}

async function main() {
  try {
    preflight();
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`codex-guarded: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'switchboard-codex-guard-')));
  console.log(`codex-guarded: node ${process.version}, owned root ${root}`);
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), COMMAND_DEADLINE_MS);
  const onSignal = () => abort.abort();
  process.on('SIGINT', onSignal).on('SIGTERM', onSignal);
  /** @type {RunRecord[]} */
  const records = [];
  const failures = [];
  let command = null;
  try {
    for (const control of CONTROLS) {
      if (abort.signal.aborted) { failures.push(`${control.run.name}: not run, command aborted`); continue; }
      const record = await runChild(control.run, root, records.length, abort.signal);
      records.push(record);
      const verdict = reduceRun(control.run, record.events, record.outcome);
      const reason = judgeControl(control, verdict);
      console.log(`codex-guarded: ${reason ? 'UNEXPECTED' : 'ok'} ${control.run.name} [${failureCodes(verdict).join(', ')}] ${record.ms} ms`);
      if (reason) failures.push(`${control.run.name}: ${reason}\n${describe(record, verdict.ok ? [] : verdict.failures)}`);
    }
    if (failures.length === 0) {
      console.log(`codex-guarded: ${CONTROLS.length} inert controls behaved as expected`);
      const suites = [];
      for (const spec of SUITES) {
        if (abort.signal.aborted) { failures.push(`${spec.name}: not run, command aborted`); continue; }
        const record = await runChild(spec, root, records.length, abort.signal);
        records.push(record);
        suites.push(record);
      }
      console.log(`codex-guarded: ran ${suites.map((r) => `${r.spec.name} (pid ${r.outcome.pid}, ${r.ms} ms)`).join(', ')}`);
      const verdicts = suites.map((r) => reduceRun(r.spec, r.events, r.outcome));
      command = reduceCommand(SUITES, verdicts);
      verdicts.forEach((verdict, index) => {
        if (!verdict.ok) failures.push(`${suites[index].spec.name}\n${describe(suites[index], verdict.failures)}`);
      });
      if (!command.ok) for (const failure of command.failures) failures.push(`command: ${failure.code}: ${failure.detail}`);
    }
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
    const unconfirmed = records.filter((record) => !record.outcome.terminated).map((record) => record.outcome.pid);
    if (unconfirmed.length) failures.push(`retained ${root}: pid ${unconfirmed.join(', ')} not confirmed terminated`);
    else {
      try { rmSync(root, { recursive: true }); } catch (error) { failures.push(`cleanup failed, retained ${root}: ${error.code ?? error.message}`); }
    }
  }
  if (command?.ok && failures.length === 0) {
    const counts = SUITES.map((spec) => `${spec.name} ${spec.tests.length}`).join(', ');
    console.log(`PASS codex-guarded: ${command.total}/${command.total} named tests (${counts}), 0 refusals, ${SUITES.length} clean exits`);
    return;
  }
  console.error(`FAIL codex-guarded:\n${failures.join('\n')}`);
  process.exitCode = 1;
}

await main();
