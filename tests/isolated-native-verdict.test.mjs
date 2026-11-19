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
  ];
  for (const [kind, line] of cases) assert.deepEqual(judge(line).kinds, [kind], line);
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
