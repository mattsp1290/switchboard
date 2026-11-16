// Pure domain model and reducers for the guarded Codex command. No I/O: every acceptance rule lives here.
import { EXPECTED_TOTAL, NODE_VERSION, ORACLE } from './plan.mjs';

/**
 * Domain events after parsing; wire field names never leave parseRecord.
 * @typedef {{ kind: 'armed', run: string, pid: number, node: string }
 *   | { kind: 'canary-failed', labels: string[] }
 *   | { kind: 'load', file: string }
 *   | { kind: 'refusal', source: 'guard' | 'tripwire', label: string }
 *   | { kind: 'test', phase: 'start' | 'pass' | 'fail', name: string, nesting: number, file: string,
 *       skip: boolean, todo: boolean, error: string }
 *   | { kind: 'summary', counts: Record<string, number> }
 *   | { kind: 'exit', code: number, refusals: number }
 *   | { kind: 'malformed', reason: string }} ChannelEvent
 */

/**
 * What the owner observed about the process itself. `terminated` means 'close' fired and kill(pid, 0) gave ESRCH.
 * @typedef {{ pid: number, code: number | null, signal: string | null, terminated: boolean,
 *   breach: null | 'deadline' | 'output-overflow' | 'channel-overflow' | 'aborted' }} ProcessOutcome
 */

/** @typedef {'malformed-record' | 'channel-overflow' | 'output-overflow' | 'aborted'
 *   | 'canary-failed' | 'not-armed' | 'armed-mismatch' | 'entry-order' | 'closure-unused'
 *   | 'refusal' | 'missing-test' | 'unexpected-test' | 'duplicate-test' | 'unstarted-test' | 'nested-test'
 *   | 'test-failed' | 'test-skipped' | 'test-todo' | 'foreign-file'
 *   | 'summary-missing' | 'summary-duplicate' | 'summary-mismatch'
 *   | 'exit-record-missing' | 'exit-record-not-last' | 'exit-refusal-count'
 *   | 'exit-nonzero' | 'signal' | 'deadline' | 'not-terminated'
 *   | 'suite-missing' | 'pid-reused' | 'oracle-mismatch'} FailureCode */

/** @typedef {{ code: FailureCode, detail: string }} Failure */
/** @typedef {{ ok: true, pid: number, passed: readonly string[] }
 *   | { ok: false, pid: number, failures: readonly Failure[], refusals: readonly string[] }} RunVerdict */
/** @typedef {{ ok: true, total: number } | { ok: false, failures: readonly { run: string, failure: Failure }[] }} CommandVerdict */

const isString = (value) => typeof value === 'string';
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];

/** @type {Record<string, (record: any) => ChannelEvent | null>} */
const SHAPES = {
  armed: (r) => isString(r.run) && isCount(r.pid) && isString(r.node) ? { kind: 'armed', run: r.run, pid: r.pid, node: r.node } : null,
  'canary-failed': (r) => Array.isArray(r.labels) && r.labels.every(isString) ? { kind: 'canary-failed', labels: r.labels } : null,
  load: (r) => isString(r.file) ? { kind: 'load', file: r.file } : null,
  refusal: (r) => isString(r.label) ? { kind: 'refusal', source: 'guard', label: r.label } : null,
  tripwire: (r) => isString(r.label) ? { kind: 'refusal', source: 'tripwire', label: r.label } : null,
  test: (r) => ['start', 'pass', 'fail'].includes(r.phase) && isString(r.name) && isCount(r.nesting) && isString(r.file)
    ? { kind: 'test', phase: r.phase, name: r.name, nesting: r.nesting, file: r.file, skip: r.skip === true,
      todo: r.todo === true, error: isString(r.error) ? r.error : '' }
    : null,
  summary: (r) => r.counts && COUNT_KEYS.every((key) => isCount(r.counts[key])) ? { kind: 'summary', counts: r.counts } : null,
  exit: (r) => Number.isSafeInteger(r.code) && isCount(r.refusals) ? { kind: 'exit', code: r.code, refusals: r.refusals } : null,
};

/**
 * Boundary parse: JSON, exact nonce, known kind, field types. Anything else becomes { kind: 'malformed' }.
 * @param {string} line @param {string} nonce @returns {ChannelEvent}
 */
export function parseRecord(line, nonce) {
  const malformed = (reason) => ({ kind: 'malformed', reason });
  let record;
  try { record = JSON.parse(line); } catch { return malformed(`not JSON: ${line.slice(0, 80)}`); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return malformed('not an object');
  if (record.n !== nonce) return malformed('wrong nonce');
  const shape = Object.hasOwn(SHAPES, record.k) ? SHAPES[record.k] : undefined;
  if (!shape) return malformed(`unknown kind ${String(record.k).slice(0, 40)}`);
  return shape(record) ?? malformed(`bad ${record.k} fields`);
}

/**
 * Pure. Collects every failure; never stops at the first.
 * @param {import('./plan.mjs').RunSpec} spec @param {readonly ChannelEvent[]} events @param {ProcessOutcome} outcome
 * @returns {RunVerdict}
 */
export function reduceRun(spec, events, outcome) {
  /** @type {Failure[]} */
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });

  if (outcome.breach) fail(outcome.breach, `owner stopped pid ${outcome.pid}`);
  if (!outcome.terminated) fail('not-terminated', `pid ${outcome.pid} not confirmed gone`);
  if (outcome.signal) fail('signal', `process ended by ${outcome.signal}`);
  else if (outcome.code !== 0) fail('exit-nonzero', `process exit code ${outcome.code}`);

  for (const event of events) if (event.kind === 'malformed') fail('malformed-record', event.reason);
  const valid = events.filter((event) => event.kind !== 'malformed');
  for (const event of valid) if (event.kind === 'canary-failed') fail('canary-failed', event.labels.join(', '));

  const armed = valid.filter((event) => event.kind === 'armed');
  if (armed.length === 0) fail('not-armed', 'no armed record');
  else if (armed.length > 1 || valid[0] !== armed[0] || armed[0].run !== spec.name || armed[0].pid !== outcome.pid
    || armed[0].node !== NODE_VERSION) fail('armed-mismatch', JSON.stringify(armed[0]));

  const loads = valid.filter((event) => event.kind === 'load').map((event) => event.file);
  if (loads[0] !== spec.entry) fail('entry-order', `first load ${loads[0] ?? 'none'}, expected ${spec.entry}`);
  for (const file of spec.files) if (!loads.includes(file)) fail('closure-unused', file);

  const refusals = valid.filter((event) => event.kind === 'refusal').map((event) => event.label);
  for (const label of refusals) fail('refusal', label);

  reduceTests(spec, valid, fail);

  const summaries = valid.filter((event) => event.kind === 'summary');
  if (summaries.length === 0) fail('summary-missing', 'no test summary');
  if (summaries.length > 1) fail('summary-duplicate', `${summaries.length} summaries`);
  const n = spec.tests.length;
  const want = { tests: n, passed: n, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const { counts } of summaries) {
    if (COUNT_KEYS.some((key) => counts[key] !== want[key])) fail('summary-mismatch', JSON.stringify(counts));
  }

  const exitAt = valid.findIndex((event) => event.kind === 'exit');
  const exit = valid[exitAt];
  if (!exit) fail('exit-record-missing', 'no exit record');
  else {
    if (valid.slice(exitAt + 1).some((event) => event.kind !== 'refusal')) fail('exit-record-not-last', 'events after exit');
    const before = valid.slice(0, exitAt).filter((event) => event.kind === 'refusal').length;
    if (exit.refusals !== before) fail('exit-refusal-count', `guard counted ${exit.refusals}, channel had ${before}`);
    if (exit.code !== 0) fail('exit-nonzero', `exit record code ${exit.code}`);
  }

  return failures.length ? { ok: false, pid: outcome.pid, failures, refusals } : { ok: true, pid: outcome.pid, passed: [...spec.tests] };
}

/** @param {import('./plan.mjs').RunSpec} spec @param {readonly ChannelEvent[]} events @param {(code: FailureCode, detail: string) => void} fail */
function reduceTests(spec, events, fail) {
  const started = new Set();
  const completed = new Set();
  const passed = new Set();
  const once = new Set();
  const failOnce = (code, name) => { if (!once.has(`${code}\0${name}`)) { once.add(`${code}\0${name}`); fail(code, name); } };
  for (const event of events) {
    if (event.kind !== 'test') continue;
    const { name } = event;
    if (event.file !== spec.entry) failOnce('foreign-file', `${name} in ${event.file}`);
    if (event.nesting > 0) { failOnce('nested-test', name); continue; }
    if (!spec.tests.includes(name)) failOnce('unexpected-test', name);
    if (event.phase === 'start') { started.add(name); continue; }
    if (!started.has(name)) failOnce('unstarted-test', name);
    if (completed.has(name)) fail('duplicate-test', name);
    completed.add(name);
    if (event.phase === 'fail') fail('test-failed', `${name}: ${event.error}`);
    else if (event.skip) fail('test-skipped', name);
    else if (event.todo) fail('test-todo', name);
    else passed.add(name);
  }
  for (const name of spec.tests) if (!passed.has(name)) fail('missing-test', name);
}

/**
 * Pure. All suites present and ok, distinct pids (fresh processes), concatenated passed names equal the
 * flattened ORACLE, and that length equals EXPECTED_TOTAL.
 * @param {readonly import('./plan.mjs').RunSpec[]} suites @param {readonly RunVerdict[]} verdicts
 * @returns {CommandVerdict}
 */
export function reduceCommand(suites, verdicts) {
  /** @type {{ run: string, failure: Failure }[]} */
  const failures = [];
  suites.forEach((spec, index) => {
    const verdict = verdicts[index];
    if (!verdict) failures.push({ run: spec.name, failure: { code: 'suite-missing', detail: 'no verdict' } });
    else if (!verdict.ok) for (const failure of verdict.failures) failures.push({ run: spec.name, failure });
  });
  const pids = verdicts.map((verdict) => verdict.pid);
  if (new Set(pids).size !== pids.length) failures.push({ run: 'command', failure: { code: 'pid-reused', detail: pids.join(',') } });
  const passed = verdicts.flatMap((verdict) => verdict.ok ? verdict.passed : []);
  const oracle = Object.values(ORACLE).flat();
  if (oracle.length !== EXPECTED_TOTAL || passed.length !== EXPECTED_TOTAL || passed.some((name, index) => name !== oracle[index])) {
    failures.push({ run: 'command', failure: { code: 'oracle-mismatch', detail: `${passed.length}/${EXPECTED_TOTAL} named tests passed` } });
  }
  return failures.length ? { ok: false, failures } : { ok: true, total: passed.length };
}

/**
 * Pure. null if the control's failure-code SET equals expect exactly (and refusal labels match when given), else a reason.
 * @param {import('./plan.mjs').ControlSpec} control @param {RunVerdict} verdict @returns {string | null}
 */
export function judgeControl(control, verdict) {
  const codes = verdict.ok ? [] : [...new Set(verdict.failures.map((failure) => failure.code))].sort();
  const expect = [...new Set(control.expect)].sort();
  if (codes.join() !== expect.join()) return `codes [${codes.join(', ')}], expected [${expect.join(', ')}]`;
  const refusals = verdict.ok ? [] : verdict.refusals;
  if (control.refusals && refusals.join('\n') !== control.refusals.join('\n')) {
    return `refusals [${refusals.join(', ')}], expected [${control.refusals.join(', ')}]`;
  }
  return null;
}
