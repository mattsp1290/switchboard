import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { CONTROLS, EXPECTED_TOTAL, NODE_VERSION, ORACLE, PRELOADS, SUITES } from '../scripts/support/codex-guard/plan.mjs';
import { judgeControl, parseRecord, reduceCommand, reduceRun } from '../scripts/support/codex-guard/verdict.mjs';

const [account] = SUITES;
const PID = 101;
const armed = (fields = {}) => ({ kind: 'armed', run: account.name, pid: PID, node: NODE_VERSION, ...fields });
const loads = (files = account.files) => files.map((file) => ({ kind: 'load', file }));
const event = (phase, name, fields = {}) => ({ kind: 'test', phase, name, nesting: 0, file: account.entry, skip: false, todo: false, error: '', ...fields });
const passes = (names = account.tests) => names.flatMap((name) => [event('start', name), event('pass', name)]);
const summary = (counts = {}) => ({ kind: 'summary', counts: { tests: 4, passed: 4, failed: 0, cancelled: 0, skipped: 0, todo: 0, ...counts } });
const refusal = (label = 'call child_process.spawn') => ({ kind: 'refusal', source: 'guard', label });
const exit = (code = 0, refusals = 0) => ({ kind: 'exit', code, refusals });
const closed = (fields = {}) => ({ pid: PID, code: 0, signal: null, terminated: true, breach: null, ...fields });
const [first, second, third, fourth] = account.tests;
const body = (...tests) => [armed(), ...loads(), ...tests];
const codes = (events, outcome = closed()) => {
  const verdict = reduceRun(account, events, outcome);
  return verdict.ok ? [] : [...new Set(verdict.failures.map((failure) => failure.code))].sort();
};

test('a complete run with every named test, one summary and a clean exit is accepted', () => {
  assert.deepEqual(reduceRun(account, body(...passes(), summary(), exit()), closed()), { ok: true, pid: PID, passed: account.tests });
});

const ROWS = [
  ['early process.exit(0) leaves a named test missing', body(...passes([first, second]), exit()), closed(), ['missing-test', 'summary-missing']],
  ['a throwing after() hook is a root failure even though the summary is clean',
    body(...passes(), event('fail', account.entry, { error: 'after' }), summary(), exit()), closed(), ['test-failed', 'unexpected-test', 'unstarted-test']],
  ['a malformed record', [...body(...passes(), summary(), exit()), { kind: 'malformed', reason: 'wrong nonce' }], closed(), ['malformed-record']],
  ['no armed record', [...loads(), ...passes(), summary(), exit()], closed(), ['not-armed']],
  ['armed by another pid', [armed({ pid: 7 }), ...loads(), ...passes(), summary(), exit()], closed(), ['armed-mismatch']],
  ['armed on another runtime', [armed({ node: 'v24.0.0' }), ...loads(), ...passes(), summary(), exit()], closed(), ['armed-mismatch']],
  ['armed for another run', [armed({ run: 'history' }), ...loads(), ...passes(), summary(), exit()], closed(), ['armed-mismatch']],
  ['two armed records', [armed(), armed(), ...loads(), ...passes(), summary(), exit()], closed(), ['armed-mismatch']],
  ['armed after the entry loaded', [...loads(), armed(), ...passes(), summary(), exit()], closed(), ['armed-mismatch']],
  ['a product module loaded before the entry', [armed(), ...loads([...account.files].reverse()), ...passes(), summary(), exit()], closed(), ['entry-order']],
  ['a closure file never loaded', [armed(), ...loads(account.files.slice(0, -1)), ...passes(), summary(), exit()], closed(), ['closure-unused']],
  ['a caught refusal', body(...passes([first]), refusal(), ...passes([second, third, fourth]), summary(), exit(0, 1)), closed(), ['refusal']],
  ['a refusal in an exit listener after the exit record', body(...passes(), summary(), exit(), refusal()), closed(), ['refusal']],
  ['a refusal record that never arrived', body(...passes(), summary(), exit(0, 1)), closed(), ['exit-refusal-count']],
  ['a test event after the exit record', body(...passes(), exit(), summary()), closed(), ['exit-record-not-last']],
  ['no exit record', body(...passes(), summary()), closed(), ['exit-record-missing']],
  ['exit record with a nonzero code', body(...passes(), summary(), exit(1)), closed(), ['exit-nonzero']],
  ['two summaries', body(...passes(), summary(), summary(), exit()), closed(), ['summary-duplicate']],
  ['a contradictory summary', body(...passes(), summary({ failed: 1 }), exit()), closed(), ['summary-mismatch']],
  ['a test reported from another file', body(...passes([first, second, third]), event('start', fourth), event('pass', fourth, { file: '/elsewhere.mjs' }),
    summary(), exit()), closed(), ['foreign-file']],
  ['a nested subtest', body(...passes(), event('start', 'inner', { nesting: 1 }), event('pass', 'inner', { nesting: 1 }), summary(), exit()), closed(), ['nested-test']],
  ['a completion without a start', body(...passes([first, second, third]), event('pass', fourth), summary(), exit()), closed(), ['unstarted-test']],
  ['a second completion', body(...passes(), event('pass', first), summary(), exit()), closed(), ['duplicate-test']],
  ['a failed test', body(...passes([first, second, third]), event('start', fourth), event('fail', fourth), summary(), exit()), closed(),
    ['missing-test', 'test-failed']],
  ['a skipped test', body(...passes([first, second, third]), event('start', fourth), event('pass', fourth, { skip: true }), summary(), exit()), closed(),
    ['missing-test', 'test-skipped']],
  ['a todo test', body(...passes([first, second, third]), event('start', fourth), event('pass', fourth, { todo: true }), summary(), exit()), closed(),
    ['missing-test', 'test-todo']],
  ['an extra test cannot stand in for a missing one', body(...passes([first, second, third, 'substitute']), summary(), exit()), closed(),
    ['missing-test', 'unexpected-test']],
  ['killed by a signal', body(...passes([first])), closed({ code: null, signal: 'SIGKILL' }), ['exit-record-missing', 'missing-test', 'signal', 'summary-missing']],
  ['a nonzero process exit despite clean records', body(...passes(), summary(), exit()), closed({ code: 1 }), ['exit-nonzero']],
  ['a child not confirmed gone', body(...passes(), summary(), exit()), closed({ terminated: false }), ['not-terminated']],
  ['an owner deadline', body(...passes(), summary(), exit()), closed({ breach: 'deadline' }), ['deadline']],
  ['a channel overflow', body(...passes(), summary(), exit()), closed({ breach: 'channel-overflow' }), ['channel-overflow']],
  ['a command abort', body(...passes(), summary(), exit()), closed({ breach: 'aborted' }), ['aborted']],
  ['a canary failure before arming', [{ kind: 'canary-failed', labels: ['child_process.spawn'] }], closed({ code: 1 }),
    ['canary-failed', 'closure-unused', 'entry-order', 'exit-nonzero', 'exit-record-missing', 'missing-test', 'not-armed', 'summary-missing']],
];
for (const [name, events, outcome, expected] of ROWS) {
  test(`reduceRun rejects ${name}`, () => assert.deepEqual(codes(events, outcome), expected));
}

test('parseRecord accepts only nonce-tagged records of a known kind and shape', () => {
  const nonce = 'n-1';
  const line = (record) => JSON.stringify({ n: nonce, ...record });
  assert.deepEqual(parseRecord(line({ k: 'armed', run: 'account', pid: 5, node: NODE_VERSION }), nonce),
    { kind: 'armed', run: 'account', pid: 5, node: NODE_VERSION });
  assert.deepEqual(parseRecord(line({ k: 'tripwire', label: 'tripwire pi-ai' }), nonce), { kind: 'refusal', source: 'tripwire', label: 'tripwire pi-ai' });
  for (const [input, reason] of [['{', /^not JSON/], ['[]', /not an object/], [line({ k: 'load', file: '/x' }).replace(nonce, 'n-2'), /wrong nonce/],
    [line({ k: 'toString' }), /unknown kind/], [line({ k: 'exit', code: '0', refusals: 0 }), /bad exit fields/],
    [line({ k: 'summary', counts: { tests: 1 } }), /bad summary fields/]]) {
    const parsed = parseRecord(input, nonce);
    assert.equal(parsed.kind, 'malformed');
    assert.match(parsed.reason, reason);
  }
});

test('reduceCommand needs every suite, fresh pids and exactly the flattened oracle', () => {
  const ok = (spec, pid) => ({ ok: true, pid, passed: spec.tests });
  assert.deepEqual(reduceCommand(SUITES, SUITES.map((spec, index) => ok(spec, 10 + index))), { ok: true, total: EXPECTED_TOTAL });
  const reasons = (verdicts) => reduceCommand(SUITES, verdicts).failures.map(({ run, failure }) => `${run}:${failure.code}`);
  assert.deepEqual(reasons([ok(SUITES[0], 1), ok(SUITES[1], 2)]), ['lifecycle:suite-missing', 'command:oracle-mismatch']);
  assert.deepEqual(reasons(SUITES.map((spec) => ok(spec, 1))), ['command:pid-reused']);
  const failed = { ok: false, pid: 3, failures: [{ code: 'refusal', detail: 'call net.connect' }], refusals: ['call net.connect'] };
  assert.deepEqual(reasons([ok(SUITES[0], 1), ok(SUITES[1], 2), failed]), ['lifecycle:refusal', 'command:oracle-mismatch']);
});

test('judgeControl compares the exact failure-code set and refusal labels', () => {
  const control = { run: account, expect: ['refusal'], refusals: ['call net.connect'] };
  const verdict = (codeList, refusals = []) => ({ ok: false, pid: 1, failures: codeList.map((code) => ({ code, detail: '' })), refusals });
  assert.equal(judgeControl(control, verdict(['refusal'], ['call net.connect'])), null);
  assert.match(judgeControl(control, verdict(['refusal', 'signal'], ['call net.connect'])), /expected \[refusal\]/);
  assert.match(judgeControl(control, verdict(['refusal'], ['call net.connect', 'call net.connect'])), /refusals/);
  assert.match(judgeControl({ run: account, expect: ['refusal'] }, { ok: true, pid: 1, passed: [] }), /codes \[\]/);
});

test('the plan is internally consistent and every closure file exists', () => {
  assert.equal(Object.values(ORACLE).flat().length, EXPECTED_TOTAL);
  assert.deepEqual(SUITES.map((spec) => spec.name), Object.keys(ORACLE));
  const runs = [...SUITES, ...CONTROLS.map((control) => control.run)];
  assert.equal(new Set(runs.map((run) => run.name)).size, runs.length);
  for (const file of [...Object.values(PRELOADS), ...runs.flatMap((run) => run.files)]) assert.ok(existsSync(file), file);
});
