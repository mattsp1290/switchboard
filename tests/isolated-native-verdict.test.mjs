import assert from 'node:assert/strict';
import test from 'node:test';
import { containerPlatformPackages } from '../scripts/support/isolated-native/platform.mjs';
import { createVerdict, execArguments } from '../scripts/support/isolated-native/verdict.mjs';

const policy = { decoy: 'switchboard-decoy', node: '/usr/local/bin/node', entry: '/stage/suite.mjs',
  scripts: new Set(['/stage/fixture.mjs', '/stage/cli.mjs']), executable: (path) => path === '/stage/cli.mjs' };
const start = '1 execve("/usr/local/bin/node", ["/usr/local/bin/node", "--test-reporter=tap", "/stage/suite.mjs"], 0x1 /* 3 vars */) = 0';
const end = '1 +++ exited with 0 +++';

function judge(...middle) {
  const verdict = createVerdict(policy);
  for (const line of [start, ...middle, end]) verdict.line(line);
  return verdict.finish();
}

test('a clean trace with admitted launches, refused execs and local pipes passes', () => {
  const result = judge(
    '1 openat(AT_FDCWD</stage>, "/stage/node_modules/x.js", O_RDONLY|O_CLOEXEC) = 17</stage/node_modules/x.js>',
    '1 socketpair(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0, [18<socket:[1]>, 19<socket:[2]>]) = 0',
    '1 io_uring_setup(256, {flags=0x10000, sq_thread_cpu=0, sq_thread_idle=0}) = -1 EPERM (Operation not permitted)',
    '1 clone(child_stack=NULL, flags=CLONE_VM|CLONE_VFORK|SIGCHLD <unfinished ...>',
    '2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs", "--x"], 0x2 /* 3 vars */ <unfinished ...>',
    '1 <... clone resumed>) = 2',
    '2 <... execve resumed>) = 0',
    '2 +++ exited with 0 +++',
    '3 execve("/stage/cli.mjs", ["/stage/cli.mjs", "--version"], 0x3 /* 4 vars */) = 0',
    '3 execve("/usr/local/bin/node", ["node", "/stage/cli.mjs"], 0x3 /* 4 vars */) = 0',
    '3 +++ killed by SIGKILL +++',
    '4 execve("/tmp/missing-cli", ["/tmp/missing-cli"], 0x4 /* 3 vars */) = -1 ENOENT (No such file or directory)',
    '4 execve("/usr/local/bin/node", ["/usr/local/bin/node", "-e", "echo = -1 ENOENT"], 0x4 /* 3 vars */) = 0',
    '4 +++ exited with 0 +++',
    '1 --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=4} ---');
  assert.deepEqual(result.violations, []);
  assert.equal(result.launches, 5);
  assert.equal(result.refused, 1);
});

test('decoy, network, launch and io_uring records each fail a run that exits 0', () => {
  const cases = [
    ['decoy', '1 openat(AT_FDCWD</stage>, "/home/switchboard-decoy/.codex/auth.json", O_RDONLY|O_CLOEXEC) = 17</home/switchboard-decoy/.codex/auth.json>'],
    ['decoy', '1 newfstatat(AT_FDCWD</home/switchboard-decoy>, ".netrc", 0xffff, 0) = 0'],
    ['network', '1 socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK, IPPROTO_IP) = 18<socket:[3]>'],
    ['network', '1 connect(18<socket:[3]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.1")}, 16) = -1 ENETUNREACH (Network is unreachable)'],
    ['network', '1 sendto(18<socket:[3]>, "x", 1, 0, {sa_family=AF_INET, sin_port=htons(53)}, 16) = -1 EPERM (Operation not permitted)'],
    ['launch', '1 execve("/bin/true", ["/bin/true"], 0x5 /* 3 vars */) = 0'],
    ['launch', '1 execve("/bin/sh", ["/bin/sh", "-c", "echo = -1 ENOENT"], 0x5 /* 3 vars */) = 0'],
    ['launch', '1 execve("/usr/local/bin/node", ["node", "/stage/other.mjs"], 0x5 /* 3 vars */) = 0'],
    ['launch', '1 execve("/usr/local/bin/node", ["node", "--import", "/stage/fixture.mjs", "/stage/fixture.mjs"], 0x5 /* 3 vars */) = 0'],
    ['launch', '1 execveat(3</bin>, "true", ["true"], NULL, 0) = 0'],
    ['io_uring', '1 io_uring_setup(256, {flags=0, sq_thread_cpu=0, sq_thread_idle=0}) = 20<anon_inode:[io_uring]>'],
    ['io_uring', '1 io_uring_setup(256, {flags=0, sq_thread_cpu=0, sq_thread_idle=0})    = 20<anon_inode:[io_uring]>'],
  ];
  for (const [kind, line] of cases) assert.deepEqual(judge(line).kinds, [kind], line);
});

test('a resumed io_uring_setup finished with a column-aligned EPERM denial is not a violation', () => {
  // x86_64 GitHub Actions run 44434269431. The verdict detail omitted the pid.
  const resumed = '<... io_uring_setup resumed>})    = -1 EPERM (Operation not permitted)';
  const result = judge(
    '1 io_uring_setup(256, {flags=0x10000, sq_thread_cpu=0, sq_thread_idle=0 <unfinished ...>',
    `1 ${resumed}`);
  assert.equal(result.violations.some((violation) => violation.kind === 'io_uring'), false);
  assert.deepEqual(result.violations, []);
});

test('a resumed successful io_uring_setup is a violation', () => {
  const result = judge(
    '1 io_uring_setup(256, {flags=0 <unfinished ...>',
    '1 <... io_uring_setup resumed>})    = 20<anon_inode:[io_uring]>');
  assert.deepEqual(result.kinds, ['io_uring']);
});

test('a refused execve is final and an extra resume fails closed', () => {
  const refused = judge(
    '5 execve("/bin/sh", ["/bin/sh"], 0x6 /* 3 vars */ <unfinished ...>',
    '5 <... execve resumed>) = -1 ENOENT (No such file or directory)',
    '5 +++ exited with 0 +++');
  assert.deepEqual(refused.violations, []);
  assert.equal(refused.refused, 1);
  assert.equal(refused.launches, 1);
  const accepted = judge(
    '5 execve("/bin/sh", ["/bin/sh"], 0x6 /* 3 vars */ <unfinished ...>',
    '5 <... execve resumed>) = -1 ENOENT (No such file or directory)',
    '5 <... execve resumed>) = 0',
    '5 +++ exited with 0 +++');
  assert.deepEqual(accepted.kinds, ['trace']);
  assert.equal(accepted.refused, 1);
  assert.equal(accepted.launches, 1);
});

test('an unfinished execve whose result is never recorded counts as a launch', () => {
  const result = judge('5 execve("/bin/sh", ["/bin/sh"], 0x6 /* 3 vars */ <unfinished ...>', '5 +++ exited with 0 +++');
  assert.deepEqual(result.kinds, ['launch']);
});

test('a thread execve hands its pending result to the leader that survives it', () => {
  const result = judge('7 execve("/bin/true", ["/bin/true"], 0x7 /* 3 vars */ <unfinished ...>',
    '6 +++ superseded by execve in pid 7 +++', '6 <... execve resumed>) = 0', '6 +++ exited with 0 +++');
  assert.deepEqual(result.violations.map((v) => v.kind), ['launch']);
});

test('unreadable, truncated or incomplete traces fail closed', () => {
  assert.deepEqual(judge('not a trace line').kinds, ['trace']);
  assert.deepEqual(judge('1 ??? weird').kinds, ['trace']);
  assert.deepEqual(judge('1 execve("/usr/local/bin/node", ["node", "/stage/fix"...], 0x1 /* 3 vars */) = 0').kinds, ['trace']);
  assert.deepEqual(judge('9 openat(AT_FDCWD</stage>, "/stage/a", O_RDONLY) = 3</stage/a>').kinds, ['trace']);
  assert.deepEqual(judge('1 +++ exited strangely +++').kinds, ['trace']);
  assert.deepEqual(judge('1 io_uring_setup(32, {flags=0} <unfinished ...>').kinds, ['io_uring']);
  const empty = createVerdict(policy).finish();
  assert.deepEqual(empty.kinds, ['trace']);
  const failed = createVerdict(policy);
  failed.line(start);
  failed.line('1 +++ exited with 1 +++');
  assert.deepEqual(failed.finish().kinds, ['trace']);
  const wrongEntry = createVerdict(policy);
  wrongEntry.line('1 execve("/usr/local/bin/node", ["/usr/local/bin/node", "/stage/fixture.mjs"], 0x1 /* 3 vars */) = 0');
  wrongEntry.line(end);
  assert.deepEqual(wrongEntry.finish().kinds, ['trace']);
});

test('the container receives the glibc platform package and leaves host and musl packages out', () => {
  const lock = {
    'node_modules/@openai/codex-linux-arm64': { resolved: 'https://example/codex', integrity: 'sha512-aa', os: ['linux'], cpu: ['arm64'] },
    'node_modules/@openai/codex-linux-x64': { resolved: 'https://example/codex', integrity: 'sha512-bb', os: ['linux'], cpu: ['x64'] },
    'node_modules/@openai/codex-darwin-arm64': { resolved: 'https://example/codex', integrity: 'sha512-cc', os: ['darwin'], cpu: ['arm64'] },
    'node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64': { resolved: 'https://example/claude', integrity: 'sha512-dd', os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
    'node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl': { resolved: 'https://example/claude', integrity: 'sha512-ee', os: ['linux'], cpu: ['arm64'], libc: ['musl'] },
  };
  const names = ['@openai/codex-linux-arm64', '@openai/codex-linux-x64', '@openai/codex-darwin-arm64',
    '@anthropic-ai/claude-agent-sdk-linux-arm64', '@anthropic-ai/claude-agent-sdk-linux-arm64-musl', 'left-unpinned'];
  assert.deepEqual(containerPlatformPackages(lock, names, 'aarch64'),
    ['@openai/codex-linux-arm64', '@anthropic-ai/claude-agent-sdk-linux-arm64']);
  assert.deepEqual(containerPlatformPackages(lock, names, 'x86_64'), ['@openai/codex-linux-x64']);
  assert.throws(() => containerPlatformPackages(lock, names, 'riscv64'), /no container platform/);
});

test('execve arguments keep escaped quotes and reject abbreviated arrays', () => {
  assert.deepEqual(execArguments('execve("/a", ["/a", "x=\\"y\\""], 0x1 /* 1 var */) = 0'), { file: '/a', argv: ['/a', 'x=\\"y\\"'] });
  assert.equal(execArguments('execve("/a", ["/a", ...], 0x1) = 0'), null);
  assert.equal(execArguments('execve("/a", 0x1234, 0x1) = 0'), null);
});

for (const diagnostic of ['???()                             = ?', '???( <unfinished ...>']) {
  test(`strace register-read failure requires the same task's immediate terminal record: ${diagnostic}`, () => {
    const result = judge('2 openat(AT_FDCWD</stage>, "/stage/a", O_RDONLY) = 3</stage/a>',
      `2 ${diagnostic}`, '3 +++ exited with 0 +++', '2 +++ killed by SIGKILL +++');
    assert.deepEqual(result.violations, []);
    assert.equal(result.terminalDiagnostics, 1);
  });
  test(`an unreadable task that continues or lacks its terminal record fails: ${diagnostic}`, () => {
    assert.deepEqual(judge(`2 ${diagnostic}`).kinds, ['trace']);
    assert.deepEqual(judge(`2 ${diagnostic}`, '2 getpid() = 2', '2 +++ exited with 0 +++').kinds, ['trace']);
    assert.deepEqual(judge(`2 ${diagnostic}`, '2 --- SIGTERM {si_signo=SIGTERM} ---', '2 +++ killed by SIGTERM +++').kinds, ['trace']);
    assert.deepEqual(judge(`2 ${diagnostic}`, '2 +++ superseded by execve in pid 3 +++', '2 +++ exited with 0 +++').kinds, ['trace']);
    for (const extra of ['getpid() = 2', '<... getpid resumed>) = 2', '+++ exited with 0 +++']) {
      assert.deepEqual(judge(`2 ${diagnostic}`, '2 +++ killed by SIGKILL +++', `2 ${extra}`).kinds, ['trace']);
    }
    assert.deepEqual(judge(`2 ${diagnostic}`, '3 +++ superseded by execve in pid 2 +++',
      '3 +++ exited with 0 +++', '2 +++ killed by SIGKILL +++').kinds, ['trace']);
  });
}

test('terminal diagnostics cannot hide forbidden activity or arbitrary unreadable syscalls', () => {
  for (const body of ['???(123) = ?', '???() = 0', '???() = ? trailing', '???( <unavailable>) = ?', '???()\t= ?', '???()\u00a0= ?']) {
    assert.deepEqual(judge(`2 ${body}`, '2 +++ killed by SIGKILL +++').kinds, ['trace'], body);
  }
  for (const [kind, call] of [
    ['network', '2 connect(3, {sa_family=AF_INET}, 16) = -1 EPERM (Operation not permitted)'],
    ['decoy', '2 openat(AT_FDCWD, "/home/switchboard-decoy/.netrc", O_RDONLY) = 3'],
    ['launch', '2 execve("/bin/true", ["/bin/true"], 0x1 /* 3 vars */) = 0'],
  ]) {
    const result = judge(call, '2 ???() = ?', '2 +++ killed by SIGKILL +++');
    assert(result.kinds.includes(kind));
  }
  assert.deepEqual(judge('1 ???() = ?', '1 getpid() = 1').kinds, ['trace']);
  assert(judge('2 execve("/bin/true", ["/bin/true"], 0x1 /* 3 vars */ <unfinished ...>',
    '2 ???() = ?', '2 +++ killed by SIGKILL +++').kinds.includes('launch'));
  assert(judge('2 io_uring_setup(32, {flags=0} <unfinished ...>',
    '2 ???() = ?', '2 +++ killed by SIGKILL +++').kinds.includes('io_uring'));
  assert.deepEqual(judge('2 ???() = ?', '2 +++ exited with 9 +++').violations, []);
  assert.deepEqual(judge('2 +++ exited with 0 +++', '2 ???() = ?').kinds, ['trace']);
});

test('supersession cannot revive an ended thread', () => {
 assert.equal(judge('2 +++ killed by SIGKILL +++', '3 +++ superseded by execve in pid 2 +++', '3 +++ exited with 0 +++').ok, false);
});
test('an io_uring resume cannot discharge another task pending call', () => {
 assert.equal(judge('2 io_uring_setup(32, {flags=0} <unfinished ...>', '2 +++ killed by SIGKILL +++', '3 <... io_uring_setup resumed>) = -1 EPERM (Operation not permitted)', '3 +++ exited with 0 +++').ok, false);
});
test('register loss cannot resolve an unfinished exec', () => {
 assert.equal(judge('2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x2 /* 3 vars */ <unfinished ...>', '2 ???() = ?', '2 +++ killed by SIGKILL +++').ok, false);
});

test('named and resumed unavailable-register diagnostics fail closed',()=>{
 for(const lines of [
  ['2 openat(AT_FDCWD, "/stage/file", O_RDONLY) = ? <unavailable>','2 +++ killed by SIGKILL +++'],
  ['2 openat(AT_FDCWD, "/stage/file", O_RDONLY <unfinished ...>','2 <... openat resumed>) = ? <unavailable>','2 +++ killed by SIGKILL +++'],
 ])assert.equal(judge(...lines).ok,false);
});

test('supersession preserves the old leader exec and io_uring evidence',()=>{
 const thread='3 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x3 /* 3 vars */ <unfinished ...>';
 const replacement=['2 +++ superseded by execve in pid 3 +++','2 <... execve resumed>) = 0'];
 const forbidden=judge('2 execve("/bin/sh", ["/bin/sh"], 0x2 /* 3 vars */ <unfinished ...>',thread,...replacement,'2 +++ exited with 0 +++');assert(forbidden.violations.some(v=>v.kind==='launch'));
 const counted=judge('2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x2 /* 3 vars */ <unfinished ...>',thread,...replacement,'2 +++ exited with 0 +++');assert.equal(counted.launches,3);
 const io=judge('2 io_uring_setup(32, {flags=0} <unfinished ...>',thread,...replacement,'2 io_uring_setup(32, {flags=0} <unfinished ...>','2 <... io_uring_setup resumed>) = -1 EPERM (Operation not permitted)','2 +++ exited with 0 +++');assert(io.violations.some(v=>v.kind==='io_uring'));
});
test('the trusted bootstrap exception admits only the first exact raw-pointer exec',()=>{
 const raw='1 execve(0x1000, 0x2000, 0x3000) = 0';const run=lines=>{const verdict=createVerdict({...policy,trustedBootstrap:true});for(const line of lines)verdict.line(line);return verdict.finish();};assert.equal(run([raw,end]).violations.length,0);assert(run([raw,'2 execve(0x4000, 0x5000, 0x6000) = 0','2 +++ exited with 0 +++',end]).violations.some(v=>v.kind==='trace'));assert(run([raw.replace('= 0','= -1 EIO (Input/output error)'),end]).violations.some(v=>v.kind==='trace'));
});

test('unknown exec resumes and split network destinations fail closed',()=>{
 const orphan=judge('2 <... execve resumed>) = 0','2 +++ exited with 0 +++');assert(orphan.violations.some(v=>v.kind==='trace'));
 const split=judge('2 sendmmsg(4<socket:[1]>, <unfinished ...>','2 <... sendmmsg resumed>[{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(443)}}}], 1, 0) = 1','2 +++ exited with 0 +++');assert(split.violations.some(v=>v.kind==='network'));
 const changed=judge('3 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x3 /* 3 vars */ <pid changed to 2 ...>','2 +++ superseded by execve in pid 3 +++','2 <... execve resumed>) = 0','2 +++ exited with 0 +++');assert.deepEqual(changed.violations,[]);assert.equal(changed.launches,2);
});
test('raw bootstrap exec needs the explicit trusted gate and a completed exact result',()=>{
 for(const trustedBootstrap of [undefined,false]){const verdict=createVerdict({...policy,trustedBootstrap});verdict.line('1 execve(0x1000, 0x2000, 0x3000) = 0');verdict.line(end);assert.deepEqual(verdict.finish().kinds,['trace']);}
 const verdict=createVerdict({...policy,trustedBootstrap:true});verdict.line('1 execve(0x1000, 0x2000, 0x3000 <unfinished ...>');verdict.line(end);assert.deepEqual(verdict.finish().kinds,['trace']);
});


test('complete exec identity requires environment and result syntax', () => {
  for (const suffix of ['', ', 0x1', ', 0x1 /* 3 vars */', ', 0x1 /* 3 vars */) = ?', ', 0x1 /* 3 vars */) = 0 trailing']) {
    const result = judge('2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"]' + suffix, '2 +++ exited with 0 +++');
    assert(result.kinds.includes('trace'));
  }
});
test('supersession requires the replacing exec and its actual destination', () => {
  assert(judge('2 +++ superseded by execve in pid 3 +++', '2 +++ exited with 0 +++').kinds.includes('trace'));
  assert(judge('3 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x3 /* 3 vars */ <pid changed to 4 ...>', '2 +++ superseded by execve in pid 3 +++', '2 <... execve resumed>) = 0', '2 +++ exited with 0 +++').kinds.includes('trace'));
});


test('known exec exit-stop markers require the next same-task kill', () => {
  for (const records of [
    ['2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x2 /* 3 vars */) = ?'],
    ['2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x2 /* 3 vars */ <unfinished ...>', '2 <... execve resumed>) = ?'],
  ]) {
    const killed = judge(...records, '2 +++ killed by SIGKILL +++'); assert.equal(killed.ok, true); assert.equal(killed.launches, 2);
    assert.equal(judge(...records, '2 getpid() = 2', '2 +++ killed by SIGKILL +++').ok, false);
    assert.equal(judge(...records, '2 +++ exited with 0 +++').ok, false);
  }
});
test('duplicate unresolved exec cannot erase an earlier forbidden launch', () => {
  const first = '2 execve("/bin/sh", ["/bin/sh"], 0x2 /* 3 vars */ <unfinished ...>';
  for (const second of ['2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x2 /* 3 vars */) = 0', '2 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x2 /* 3 vars */ <unfinished ...>']) {
    const result = judge(first, second, '2 +++ exited with 0 +++'); assert.equal(result.ok, false); assert(result.kinds.includes('launch'));
  }
});
test('successful supersession cannot later become a refused exec', () => {
  const result = judge('3 execve("/usr/local/bin/node", ["node", "/stage/fixture.mjs"], 0x3 /* 3 vars */ <pid changed to 2 ...>', '2 +++ superseded by execve in pid 3 +++', '2 <... execve resumed>) = -1 ENOENT (No such file or directory)', '2 +++ exited with 0 +++');
  assert.equal(result.ok, false); assert(result.kinds.includes('trace'));
});
