// Classifies one `strace -f -q -y` log from an isolated native run, line by line. The verdict is independent of
// the traced program's exit status: a run that exits 0 still fails on any decoy, network or launch record, and
// on any line or process the classifier cannot account for.

/** @typedef {'decoy' | 'network' | 'launch' | 'io_uring' | 'trace'} ViolationKind */
/** @typedef {{ kind: ViolationKind, detail: string }} Violation */
/**
 * @typedef {object} Policy
 * @property {string} decoy                      substring that names every decoy path, and nothing else
 * @property {string} node                       the one Node executable
 * @property {boolean} [trustedBootstrap]       fixed builtin-only entry verifies argv/env and closes tracer descriptors before SDK
 * @property {string} entry                      the run's entry script, the first program in the trace
 * @property {ReadonlySet<string>} scripts       scripts Node may run
 * @property {(path: string) => boolean} executable  other programs that may be executed directly
 */

const NETWORK = new Set(['socket', 'connect', 'bind', 'listen', 'accept', 'accept4']);
const SEND = new Set(['sendto', 'sendmsg', 'sendmmsg']);
const INLINE = new Set(['-e', '--eval', '-p', '--print']);
const NODE_OPTIONS = new Set(['--test-reporter=tap', '--input-type=module']);
const LINE = /^(\d+) +(.*)$/;
const CALL = /^([a-z0-9_]+)\(/;
const RESUMED = /^<\.\.\. ([a-z0-9_]+) resumed>/;
// strace 6.1 emits these when register inspection loses a task to exit_group or SIGKILL.
// Accept the diagnostic only if that task's next record confirms death; never resume it.
// https://github.com/strace/strace/blob/v6.1/src/strace.c (dispatch_event, TE_SYSCALL_STOP)
const TERMINAL_DIAGNOSTIC = /^\?\?\?\((?:\) += \?| <unfinished \.\.\.>)$/;
const TERMINAL = /^\+\+\+ (exited with \d+|killed by SIG[A-Z0-9]+( \(core dumped\))?) \+\+\+$/;
const STRING = /"((?:[^"\\]|\\.)*)"(\.\.\.)?/y;
const MAX_VIOLATIONS = 200;
// The errno is only the syscall result at the end of the line. An argument may contain the same text.
// strace aligns "=" and a resumed call can close a split struct first: ") = -1 EPERM" or "})    = -1 EPERM".
const refusedErrno = (rest) => /\)[^"=]*= -1 [A-Z]/.test(rest) && /=\s*-1 [A-Z][A-Z0-9]* \([^)]*\)\s*$/.test(rest);

/** Reads the filename and argv of an execve body; null when strace truncated or abbreviated either. */
export function execArguments(body) {
  STRING.lastIndex = 'execve('.length;
  const file = STRING.exec(body);
  if (!file || file[2]) return null;
  let at = STRING.lastIndex;
  if (!body.startsWith(', [', at)) return null;
  at += 3;
  const argv = [];
  while (!body.startsWith(']', at)) {
    if (argv.length && !body.startsWith(', ', at)) return null;
    if (argv.length) at += 2;
    STRING.lastIndex = at;
    const arg = STRING.exec(body);
    if (!arg || arg[2]) return null;
    argv.push(arg[1]);
    at = STRING.lastIndex;
  }
  const tail = body.slice(at + 1);
  if (!/^, (?:0x[0-9a-f]+(?: \/\* \d+ vars? \*\/)?|NULL)(?:\)\s+= (?:0|\?|-1 [A-Z][A-Z0-9_]* \([^\r\n]*\))| <unfinished \.\.\.>| <pid changed to \d+ \.\.\.>)$/.test(tail)) return null;
  return { file: file[1], argv };
}

/** @param {Policy} policy @param {string} file @param {readonly string[]} argv @returns {string | null} */
export function launchProblem(policy, file, argv) {
  if (file !== policy.node) return policy.executable(file) ? null : `executes ${file}`;
  for (const arg of argv.slice(1)) {
    if (INLINE.has(arg)) return null;
    if (NODE_OPTIONS.has(arg)) continue;
    if (arg.startsWith('-')) return `node option ${arg}`;
    return policy.scripts.has(arg) || arg === policy.entry ? null : `node runs ${arg}`;
  }
  return 'node without a script';
}

/** @param {Policy} policy */
export function createVerdict(policy) {
  /** @type {Violation[]} */
  const violations = [];
  let lines = 0;
  let launches = 0;
  let refused = 0;
  let terminalDiagnostics = 0;
  const pendingIo = new Set();
  let top = null;
  const seen = new Set();
  /** @type {Map<string, string>} */
  const ended = new Map();
  const dying = new Set();
  /** @type {Map<string, { problem: string | null, sawRefusal: boolean, changedTo?: string, successConfirmed?: boolean, exiting?: boolean }>} unfinished execve per pid */
  const pending = new Map();
  const add = (kind, detail) => { if (violations.length < MAX_VIOLATIONS) violations.push({ kind, detail: detail.slice(0, 300) }); };

  const exec = (pid, body, rest) => {
    const parsed = execArguments(body);
    if (!parsed) {
      // The nondumpable tracer's child inherits that state until its first exec. No SDK code has run:
      // the fixed bootstrap verifies argv/environment and descriptor separation before importing the suite.
      if (lines === 1 && policy.trustedBootstrap && /^execve\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x[0-9a-f]+\) = 0$/.test(body)) { launches++; return; }
      add('trace', `unreadable execve: ${body}`); return;
    }
    if (lines === 1 && (parsed.file !== policy.node || !parsed.argv.includes(policy.entry))) {
      add('trace', `first program is not the entry: ${body}`);
    }
    if (lines === 1 && !rest.includes('/* 3 vars */')) add('trace', `entry environment is not three variables: ${body}`);
    const problem = launchProblem(policy, parsed.file, parsed.argv);
    const previous = pending.get(pid);
    if (previous) {
      add('trace', `duplicate unresolved execve for task ${pid}`);
      if (!previous.sawRefusal) { launches++; if (previous.problem) add('launch', previous.problem); }
      pending.delete(pid);
    }
    if (/\)\s+= \?$/.test(rest)) { pending.set(pid, { problem, sawRefusal: false, exiting: true }); return; }
    if (rest.endsWith('<unfinished ...>') || / <pid changed to \d+ \.\.\.>$/.test(rest)) { pending.set(pid, { problem, sawRefusal: false, ...(/ <pid changed to (\d+) \.\.\.>$/.test(rest) ? { changedTo: / <pid changed to (\d+) \.\.\.>$/.exec(rest)[1] } : {}) }); return; }
    if (settle({ problem, sawRefusal: false }, rest)) pending.delete(pid);
  };
  const settle = (entry, rest) => {
    if (refusedErrno(rest)) {
      if (entry.successConfirmed) { add('trace', `refused result contradicts successful exec supersession: ${rest}`); launches++; if (entry.problem) add('launch', entry.problem); }
      else { refused++; entry.sawRefusal = true; }
      return true;
    }
    if (/\)\s+= \?$/.test(rest)) { entry.exiting = true; return false; }
    if (!/\)\s+= 0$/.test(rest)) { add('trace', `unreadable execve result: ${rest}`); return true; }
    launches++;
    if (entry.problem) add('launch', entry.problem);
    return true;
  };

  /** @param {string} text */
  function line(text) {
    lines++;
    const match = LINE.exec(text);
    if (!match) { add('trace', `unparsed line: ${text}`); return; }
    const [, pid, rest] = match;
    top ??= pid;
    seen.add(pid);
    if (ended.has(pid)) add('trace', `task ${pid} has records after its terminal record: ${rest}`);
    const exiting = pending.get(pid);
    if (exiting?.exiting) {
      exiting.exiting = false;
      if (!/^\+\+\+ killed by SIG[A-Z0-9]+(?: \(core dumped\))? \+\+\+$/.test(rest)) add('trace', `exec exit marker lacks the next same-task kill: ${rest}`);
    }
    if (rest.includes(policy.decoy)) add('decoy', rest);
    if (lines === 1 && !rest.startsWith('execve(')) add('trace', `first record is not the entry execve: ${rest}`);
    if (dying.has(pid)) {
      dying.delete(pid);
      if (!TERMINAL.test(rest)) add('trace', `task ${pid} continued after unreadable registers: ${rest}`);
    }
    if (TERMINAL_DIAGNOSTIC.test(rest)) {
      if (pending.has(pid) && !pending.get(pid).sawRefusal) add('trace', `unreadable registers while execve is unresolved for task ${pid}`);
      terminalDiagnostics++;
      dying.add(pid);
      return;
    }
    if (rest.startsWith('+++ ')) {
      // A thread's execve replaces its leader: the thread's record ends, the leader keeps the pid and the result.
      const superseded = /^\+\+\+ superseded by execve in pid (\d+) \+\+\+$/.exec(rest);
      if (superseded) {
        const thread = superseded[1];
        if (thread === pid) { add('trace', `task ${pid} supersedes itself`); return; }
        if (pendingIo.delete(pid)) add('io_uring', 'io_uring_setup result lost to supersession');
        const leader = pending.get(pid);
        if (leader && !leader.sawRefusal) { launches++; if (leader.problem) add('launch', leader.problem); }
        pending.delete(pid);
        const replacing = pending.get(thread);
        if (!replacing || (replacing.changedTo !== undefined && replacing.changedTo !== pid)) add('trace', `supersession lacks a matching execve for task ${thread}`);
        if (ended.has(thread) || dying.has(thread)) add('trace', `supersession references ended or unreadable task ${thread}`);
        ended.set(thread, rest);
        seen.add(thread);
        if (pending.has(thread)) { pending.set(pid, { ...pending.get(thread), successConfirmed: true }); pending.delete(thread); }
        return;
      }
      if (!TERMINAL.test(rest)) {
        add('trace', `unknown process end: ${rest}`);
      }
      ended.set(pid, rest);
      return;
    }
    if (rest.startsWith('--- ') && rest.endsWith(' ---')) return;
    if (/=\s*\?\s+<unavailable>$/.test(rest)) add('trace', `unavailable syscall registers: ${rest}`);
    const resumed = RESUMED.exec(rest);
    if (resumed) {
      if (NETWORK.has(resumed[1]) || (SEND.has(resumed[1]) && rest.includes('sa_family='))) add('network', rest);
      if (resumed[1] === 'execve') {
        if (!pending.has(pid)) add('trace', `orphan execve resume for task ${pid}`);
        else if (settle(pending.get(pid), rest)) pending.delete(pid);
      }
      if (resumed[1] === 'io_uring_setup') { if (!pendingIo.delete(pid)) add('io_uring', `orphan io_uring_setup resume for task ${pid}`); if (!refusedErrno(rest)) add('io_uring', rest); }
      return;
    }
    const call = CALL.exec(rest);
    if (!call) { add('trace', `unparsed record: ${rest}`); return; }
    const name = call[1];
    if (NETWORK.has(name) || (SEND.has(name) && rest.includes('sa_family='))) add('network', rest);
    else if (name === 'execve') exec(pid, rest, rest);
    else if (name === 'execveat') add('launch', `execveat is not admitted: ${rest}`);
    else if (name === 'io_uring_setup' && rest.endsWith('<unfinished ...>')) {
      if (pendingIo.has(pid)) add('io_uring', `duplicate unresolved io_uring_setup for task ${pid}`);
      pendingIo.add(pid);
    }
    else if (name === 'io_uring_setup' && !refusedErrno(rest)) add('io_uring', rest);
  }

  /** @returns {{ ok: boolean, violations: Violation[], kinds: ViolationKind[], lines: number, launches: number, refused: number, terminalDiagnostics: number }} */
  function finish() {
    if (top === null) add('trace', 'empty trace');
    else if (ended.get(top) !== '+++ exited with 0 +++') add('trace', `entry process ended with: ${ended.get(top) ?? 'no record'}`);
    for (const pid of seen) if (!ended.has(pid)) add('trace', `process ${pid} has no end record`);
    for (const pid of dying) add('trace', `task ${pid} has no terminal record after unreadable registers`);
    if (pendingIo.size > 0) add('io_uring', 'io_uring_setup result not recorded');
    for (const entry of pending.values()) {
      if (entry.exiting) add('trace', 'exec exit marker has no same-task kill');
      if (entry.sawRefusal) continue;
      launches++;
      if (entry.problem) add('launch', `${entry.problem} (result not recorded)`);
    }
    pending.clear();
    const kinds = [...new Set(violations.map((violation) => violation.kind))].sort();
    return { ok: violations.length === 0, violations, kinds, lines, launches, refused, terminalDiagnostics };
  }

  return { line, finish };
}
