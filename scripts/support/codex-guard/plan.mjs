// Fixed data for `npm run test:codex-guarded`: the oracle, each run's exact closure, limits and the control table.
// The launcher and the in-child guard both read this module, so they cannot disagree about a run.
import { fileURLToPath } from 'node:url';

/** @typedef {'account' | 'history' | 'lifecycle'} SuiteName */
/** @typedef {'full' | 'tripwire-only' | 'sabotaged'} Preloads */
/** @typedef {{ perTestMs: number, totalMs: number }} Deadlines */
/** @typedef {import('./verdict.mjs').FailureCode} FailureCode */

/**
 * One fresh child. Frozen.
 * @typedef {object} RunSpec
 * @property {string} name               'account' | 'control:hang' | ... (also the guard's ?run= key)
 * @property {string} entry              absolute path
 * @property {readonly string[]} args    extra argv for the entry (controls only: the mode)
 * @property {readonly string[]} files   exact executable file closure (absolute paths, entry first)
 * @property {readonly string[]} builtins admitted node: URLs
 * @property {readonly string[]} tests   expected top-level test names, in source order
 * @property {Preloads} preloads
 * @property {Deadlines} deadlines
 */

/**
 * @typedef {object} ControlSpec
 * @property {RunSpec} run
 * @property {readonly FailureCode[]} expect   exact failure-code set ([] = must pass)
 * @property {readonly string[]} [refusals]    exact refusal labels, in order, when given
 */

export const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
export const NODE_VERSION = 'v24.22.3';
export const EXPECTED_TOTAL = 38;
export const COMMAND_DEADLINE_MS = 180_000;
export const CAPS = Object.freeze({ stdout: 1 << 20, stderr: 1 << 20, channel: 256 << 10, line: 16 << 10, tail: 4 << 10 });
export const PRELOADS = Object.freeze({
  tripwire: `${REPO}/scripts/support/codex-guard/tripwire.mjs`,
  guard: `${REPO}/scripts/support/codex-guard/guard.mjs`,
  sabotage: `${REPO}/tests/fixtures/codex-guard/sabotage.mjs`,
});

/** @type {Readonly<Record<SuiteName, readonly string[]>>} verbatim, in source order */
export const ORACLE = Object.freeze({
  account: [
    'actual account experiment separates visibility from known-ID read success',
    'actual account experiment retains partial inconclusive evidence on rejected or empty reads and rejects creator fields',
    'actual account experiment leaves the real custom-provider null reply inconclusive',
    'actual H1 profile and routing handler keep auth discovery on a separate synthetic endpoint',
  ],
  history: [
    'actual discovery cold-copies the exact family before A, B, and API-key spawn',
    'actual discovery refuses incomplete, changed, aliased, unsupported, or excessive cold copies before affected spawn',
    'actual inaccessible discovery reports preservation for a healthy source through all five checkpoints',
    'actual inaccessible discovery refuses a byte change at the after-requests checkpoint',
    'actual inaccessible discovery refuses an empty directory added inside a selected tree',
    'actual inaccessible discovery records an unselected root addition without protecting it',
    'actual inaccessible discovery refuses a selected file replaced by the same bytes at a new inode',
    'actual discovery refuses selected root additions in ordinary and H1 modes',
    'actual H1 discovery refuses directory and inode changes before the next requester spawn',
    'actual discovery emits one reserved progress overflow marker, bounds source evidence and withholds preservation and H1 success',
    'actual Legacy creator exports one drained native rollout and refuses unhonored or unterminated Legacy history',
    'actual Legacy reader dispatches the fixed public sequence in a fresh home and retains drain, stderr and checkpoints',
    'Legacy conclusion is only uncertified success, bounded rejection or inconclusive',
    'actual preparation exports exact native turn witnesses and older modes bypass cold copies',
    'bounded observation refuses file, directory, family and missing-tree additions and removals',
    'bounded observation refuses kind, inode, mode, link, size and time changes but keeps hardlink aliases',
    'bounded observation refuses short, growing and substituted reads and compares retained bytes directly',
    'bounded observation refuses special files, entry, depth, byte and deadline limits before reading, opening or descending',
    'bounded observation closes every descriptor and directory on each refusal',
    'selectors keep ordinary and H1 root rules distinct and characterize only permitted symlinks',
  ],
  lifecycle: [
    'helper imports perform no native or daemon operation',
    'client preserves initialization, replies, events, transcript and refusal before dispatch',
    'client rejects malformed, null, array, unexpected-request and oversized output before dispatch',
    'client captures asynchronous spawn, stdin and stdout errors during pending calls',
    'actual client wire faults reach exact terminal assertions after stdout and codec entry',
    'actual client refuses outgoing invalid envelopes without writing and retains the owned failure',
    'client waits for graceful stdio drain and repeated stop is harmless',
    'client retains exact leading stderr bytes with an explicit total and truncation after drain',
    'client rejects final-drain faults after close and keeps failed repeated stop observable',
    'actual discovery retains a final-drain failure and exits nonzero through inert boundaries',
    'client bounds ignored TERM, escalates to KILL, and rejects failed close',
    'owner separates operation acknowledgement from exact inventory and never retries uncertain creation',
    'owner keeps never-observed uncertainty when creation appears after empty inventory',
    'actual qualifier retains frozen source on uncertainty and removes it only after confirmed absence',
  ],
});

const BUILTINS = Object.freeze(['assert/strict', 'buffer', 'crypto', 'events', 'fs', 'module', 'os', 'path',
  'stream', 'test', 'timers/promises', 'url', 'util'].map((name) => `node:${name}`));
const native = (name) => `spikes/codex-native/${name}.mjs`;
const fake = (name) => `tests/spikes/codex-${name}.mjs`;
const WIRE = 'src/adapters/codex/wire.ts';

/** @type {readonly RunSpec[]} closures measured on c917973 plus legacy-tail.mjs */
export const SUITES = Object.freeze([
  suite('account', [fake('account-fs'), native('account-reads'), native('inventory')]),
  suite('history', [fake('wire-source'), fake('history-boundary'), native('discovery'), native('inventory'),
    native('account-reads'), native('client'), native('history-copy'), native('legacy-tail'), WIRE]),
  suite('lifecycle', [fake('wire-source'), fake('lifecycle-transport'), fake('lifecycle-fs'), fake('discovery-boundary'),
    native('client'), native('lifecycle'), native('discovery'), native('inventory'), native('account-reads'),
    native('history-copy'), native('legacy-tail'), native('qualify'), native('protocol-bindings'), WIRE]),
]);

/** Resolution-only probes: a missing guard loads no package code. */
export const BARE = Object.freeze(['@earendil-works/pi-ai', 'pi-ai', 'pi-agent-core', '@mariozechner/pi-ai',
  '@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', 'switchboard-codex-guard-unknown-package']);
const bareLabels = (prefix) => BARE.flatMap((specifier) => [`${prefix} ${specifier}`, `${prefix} ${specifier}`]);
const KILLED = ['signal', 'exit-record-missing', 'missing-test', 'summary-missing'];

/** @type {readonly ControlSpec[]} code sets calibrated from the first run on Node 24.22.3 */
export const CONTROLS = Object.freeze([
  control('pass', { expect: [] }),
  control('substitute', { expect: ['missing-test', 'unexpected-test'] }),
  control('duplicate', { expect: ['duplicate-test', 'summary-mismatch'] }),
  control('fail', { expect: ['test-failed', 'missing-test', 'summary-mismatch', 'exit-nonzero'] }),
  control('skip-todo', { expect: ['test-skipped', 'test-todo', 'missing-test', 'summary-mismatch'] }),
  control('nested', { expect: ['nested-test', 'summary-mismatch'] }),
  control('early-exit', { expect: ['missing-test', 'summary-missing'] }),
  control('exit-code', { expect: ['exit-nonzero'] }),
  control('after-throw', { expect: ['test-failed', 'unexpected-test', 'unstarted-test'] }),
  control('crash', { expect: KILLED }),
  control('hang', { expect: ['deadline', ...KILLED], deadlines: { perTestMs: 1000, totalMs: 4000 } }),
  control('flood', { expect: ['output-overflow', ...KILLED] }),
  control('after-refusal', { expect: ['refusal'], refusals: ['call child_process.spawn'] }),
  control('kill-other', { expect: ['refusal'], refusals: ['call process.kill'] }),
  control('late-refusal', { expect: ['refusal'], refusals: ['call net.connect', 'call child_process.execFileSync'] }),
  control('alias', { expect: ['refusal'], refusals: ['builtin node:child_process', 'builtin node:child_process',
    'builtin node:net', 'builtin node:net'] }),
  control('excluded', { expect: ['refusal'], refusals: ['file tests/fixtures/codex-guard/excluded.mjs',
    'file tests/fixtures/codex-guard/excluded.mjs', 'file tests/fixtures/codex-guard/excluded.mjs',
    'builtin node:child_process', 'hooks load'] }),
  control('bare', { args: BARE, expect: ['refusal'], refusals: bareLabels('bare') }),
  control('bare', { args: BARE, preloads: 'tripwire-only', refusals: bareLabels('tripwire'),
    expect: ['not-armed', 'entry-order', 'closure-unused', 'refusal', 'missing-test', 'summary-missing', 'exit-record-missing'] }),
  control('pass', { preloads: 'sabotaged', expect: ['canary-failed', 'not-armed', 'entry-order', 'closure-unused',
    'exit-nonzero', 'missing-test', 'summary-missing', 'exit-record-missing'] }),
]);

/** @param {string} name @returns {RunSpec} */
export function runSpec(name) {
  const spec = [...SUITES, ...CONTROLS.map((entry) => entry.run)].find((run) => run.name === name);
  if (!spec) throw new Error(`codex guard: unknown run ${JSON.stringify(name)}`);
  return spec;
}

/** @param {SuiteName} name @param {readonly string[]} files @returns {RunSpec} */
function suite(name, files) {
  const entry = `${REPO}/tests/spikes/codex-${name}.test.mjs`;
  return Object.freeze({ name, entry, args: [], files: [entry, ...files.map((file) => `${REPO}/${file}`)],
    // Lifecycle's TERM/KILL test spends about 18 s in real timers, so 30 s keeps CI margin; do not lower it.
    builtins: BUILTINS, tests: ORACLE[name], preloads: 'full', deadlines: { perTestMs: 30_000, totalMs: 90_000 } });
}

/**
 * @param {string} mode
 * @param {{ expect: readonly FailureCode[], refusals?: readonly string[], preloads?: Preloads, deadlines?: Deadlines,
 *   args?: readonly string[] }} options
 * @returns {ControlSpec}
 */
function control(mode, { expect, refusals, preloads = 'full', deadlines = { perTestMs: 5000, totalMs: 10_000 }, args = [] }) {
  const entry = `${REPO}/tests/fixtures/codex-guard/control.mjs`;
  const name = preloads === 'full' ? `control:${mode}` : `control:${mode}/${preloads}`;
  const run = Object.freeze({ name, entry, args: [mode, ...args], files: [entry], builtins: BUILTINS, tests: ['a', 'b'], preloads, deadlines });
  return Object.freeze({ run, expect, refusals });
}
