// Classifies one `strace -f -q -y` log from an isolated native run, line by line. The verdict is independent of
// the traced program's exit status: a run that exits 0 still fails on any decoy, network or launch record, and
// on any line or process the classifier cannot account for.

/** @typedef {'decoy' | 'network' | 'launch' | 'io_uring' | 'trace'} ViolationKind */
/** @typedef {{ kind: ViolationKind, detail: string }} Violation */
/**
 * @typedef {object} Policy
 * @property {string} decoy                      substring that names every decoy path, and nothing else
 * @property {string} node                       the one Node executable
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
  let pendingIo = 0;
  let top = null;
  const seen = new Set();
  /** @type {Map<string, string>} */
  const ended = new Map();
  /** @type {Map<string, { problem: string | null, sawRefusal: boolean }>} unfinished execve per pid */
  const pending = new Map();
  const add = (kind, detail) => { if (violations.length < MAX_VIOLATIONS) violations.push({ kind, detail: detail.slice(0, 300) }); };

  const exec = (pid, body, rest) => {
    const parsed = execArguments(body);
    if (!parsed) { add('trace', `unreadable execve: ${body}`); return; }
    if (lines === 1 && (parsed.file !== policy.node || !parsed.argv.includes(policy.entry))) {
      add('trace', `first program is not the entry: ${body}`);
    }
    if (lines === 1 && !rest.includes('/* 3 vars */')) add('trace', `entry environment is not three variables: ${body}`);
    const problem = launchProblem(policy, parsed.file, parsed.argv);
    if (rest.endsWith('<unfinished ...>')) { pending.set(pid, { problem, sawRefusal: false }); return; }
    if (settle({ problem, sawRefusal: false }, rest)) pending.delete(pid);
  };
  const settle = (entry, rest) => {
    if (refusedErrno(rest)) { refused++; entry.sawRefusal = true; return false; }
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
    if (rest.includes(policy.decoy)) add('decoy', rest);
    if (lines === 1 && !rest.startsWith('execve(')) add('trace', `first record is not the entry execve: ${rest}`);
    if (rest.startsWith('+++ ')) {
      // A thread's execve replaces its leader: the thread's record ends, the leader keeps the pid and the result.
      const superseded = /^\+\+\+ superseded by execve in pid (\d+) \+\+\+$/.exec(rest);
      if (superseded) {
        const thread = superseded[1];
        ended.set(thread, rest);
        seen.add(thread);
        if (pending.has(thread)) { pending.set(pid, pending.get(thread)); pending.delete(thread); }
        return;
      }
      if (!/^\+\+\+ (exited with \d+|killed by SIG[A-Z0-9]+( \(core dumped\))?) \+\+\+$/.test(rest)) {
        add('trace', `unknown process end: ${rest}`);
      }
      ended.set(pid, rest);
      return;
    }
    if (rest.startsWith('--- ') && rest.endsWith(' ---')) return;
    const resumed = RESUMED.exec(rest);
    if (resumed) {
      if (resumed[1] === 'execve' && pending.has(pid) && settle(pending.get(pid), rest)) pending.delete(pid);
      if (resumed[1] === 'io_uring_setup') { if (pendingIo > 0) pendingIo--; if (!refusedErrno(rest)) add('io_uring', rest); }
      return;
    }
    const call = CALL.exec(rest);
    if (!call) { add('trace', `unparsed record: ${rest}`); return; }
    const name = call[1];
    if (NETWORK.has(name) || (SEND.has(name) && rest.includes('sa_family='))) add('network', rest);
    else if (name === 'execve') exec(pid, rest, rest);
    else if (name === 'execveat') add('launch', `execveat is not admitted: ${rest}`);
    else if (name === 'io_uring_setup' && rest.endsWith('<unfinished ...>')) pendingIo++;
    else if (name === 'io_uring_setup' && !refusedErrno(rest)) add('io_uring', rest);
  }

  /** @returns {{ ok: boolean, violations: Violation[], kinds: ViolationKind[], lines: number, launches: number, refused: number }} */
  function finish() {
    if (top === null) add('trace', 'empty trace');
    else if (ended.get(top) !== '+++ exited with 0 +++') add('trace', `entry process ended with: ${ended.get(top) ?? 'no record'}`);
    for (const pid of seen) if (!ended.has(pid)) add('trace', `process ${pid} has no end record`);
    if (pendingIo > 0) add('io_uring', 'io_uring_setup result not recorded');
    for (const entry of pending.values()) {
      if (entry.sawRefusal) continue;
      launches++;
      if (entry.problem) add('launch', `${entry.problem} (result not recorded)`);
    }
    pending.clear();
    const kinds = [...new Set(violations.map((violation) => violation.kind))].sort();
    return { ok: violations.length === 0, violations, kinds, lines, launches, refused };
  }

  return { line, finish };
}
