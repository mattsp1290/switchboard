// `npm run test:native-isolated`: the only runner for tests that import a native SDK. Each run is a fresh Linux
// container with no network, a read-only root and only the packed package, its SDK closure, the fixtures and
// decoy credentials mounted, traced by strace. Three exit-0 controls must each fail the gate before the suites
// run, and a suite passes only on a clean trace as well as a clean exit.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNpm } from './support/exec.mjs';
import { containerPlatformPackages } from './support/isolated-native/platform.mjs';
import { createVerdict } from './support/isolated-native/verdict.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const IMAGE = 'node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const NODE = '/usr/local/bin/node';
const STAGE = '/stage';
const DECOY = 'switchboard-decoy';
const HOME = `/home/${DECOY}`;
const STRACE = '/opt/strace/usr/bin/strace';
// Debian bookworm strace 6.1-0.1: package and extracted executable SHA-256 per Docker architecture.
const STRACE_PACKAGES = {
  aarch64: { arch: 'arm64', deb: '751817724af91cb95df566a21a154f9a7dcdd938e700e5cb9a5a47eb19752ea2', bin: '0e69fa123b3d9732645ce1ac8c89819d100f83cdc9e52a80565d9ad8e7d8cf28' },
  // bookworm-slim has libc and liblzma, and the amd64 strace also needs libunwind.
  x86_64: { arch: 'amd64', deb: '1942d086a6244a1a9643489d3b0aa604ac44b88991d6c69217a63a193671bd4f', bin: 'aebaf212ce84a12208c5fa25f08c892029e6f6949b778da55e071ac145404a1e',
    unwind: { file: 'libunwind8_1.6.2-3_amd64.deb', deb: '7b297868682836e4c87be349f17e4a56bc287586e3576503e84a5cb5485ce925', libs: {
      'usr/lib/x86_64-linux-gnu/libunwind-ptrace.so.0': 'cb8ab3f0e63b0fa826c1002a91ba3d7f055940b0be3f4092e24834b3cadba020',
      'usr/lib/x86_64-linux-gnu/libunwind-x86_64.so.8': '04bd8928ff2105c4c86f01755b9cfbe5414f16115d6f1f3b3c98ec3d9aa8ccb2',
      'usr/lib/x86_64-linux-gnu/libunwind.so.8': 'c66c0e877d919d0cea417cb58372884c00e529f13a9ddf78b9760a16a887dba0',
    } } },
};
const DECOY_FILES = ['.claude.json', '.claude/.credentials.json', '.codex/auth.json', '.pi/agent/auth.json',
  '.cursor/sdk/auth.json', '.aws/credentials', '.config/gcloud/application_default_credentials.json', '.netrc'];
const SDK_ROOTS = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@cursor/sdk'];
const FIXTURES = ['tests/adapters/readiness-oracle.mjs', 'tests/adapters/claude/fixture.mjs', 'tests/adapters/codex/sdk-cli.mjs'];
const SCRIPTS = new Set([...FIXTURES.slice(1), 'node_modules/@openai/codex/bin/codex.js'].map((path) => `${STAGE}/${path}`));
const CODEX_VENDOR = /^\/stage\/node_modules\/@openai\/codex-linux-(x64|arm64)\/vendor\/[a-z0-9_-]+\/bin\/codex$/;
const SUITES = ['claude-runtime', 'codex-sdk-chat', 'pi-runtime', 'pi-host', 'cursor-runtime'].map((name) => `tests/native-isolated/${name}.native.mjs`);
const CONTROLS = [['decoy-read', 'decoy'], ['network', 'network'], ['launch', 'launch']]
  .map(([name, expect]) => ({ entry: `tests/native-isolated/controls/${name}.mjs`, expect }));
const RUN_DEADLINE_MS = 300_000;
const OUTPUT_CAP = 8 << 20;

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: OUTPUT_CAP, ...options });
  assert.equal(result.status, 0, `docker ${args.slice(0, 2).join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

/** Every installed package the SDK roots need at runtime, plus the optional names a foreign host may have omitted. */
function sdkClosure() {
  const found = new Set();
  const optional = new Set();
  const visit = (name, from, required) => {
    let dir = from;
    for (;;) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) { dir = candidate; break; }
      if (dir === root || dir === dirname(dir)) {
        assert(!required, `${name} is required by ${relative(root, from) || 'the gate'} but not installed`);
        return;
      }
      dir = dirname(dir);
    }
    if (found.has(dir)) return;
    found.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, true);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) { optional.add(dep); visit(dep, dir, false); }
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) visit(dep, dir, false);
  };
  for (const name of SDK_ROOTS) visit(name, root, true);
  return { dirs: [...found].map((dir) => relative(root, dir)), optional: [...optional].sort() };
}

/** Downloads lockfile tarballs the host install omitted and extracts them into the staged node_modules. */
async function stageLockedPackages(tree, names, lockPackages) {
  let added = 0;
  for (const name of names) {
    const dest = join(tree, 'node_modules', ...name.split('/'));
    if (existsSync(join(dest, 'package.json'))) continue;
    const entry = lockPackages[`node_modules/${name}`];
    const response = await fetch(entry.resolved, { signal: AbortSignal.timeout(120_000) });
    assert(response.ok, `${name} download failed: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const digest = entry.integrity.split(' ').find((part) => part.startsWith('sha512-'))?.slice('sha512-'.length);
    assert(digest, `${name} has no sha512 integrity`);
    assert.equal(createHash('sha512').update(body).digest('base64'), digest, `${name} integrity`);
    const tmp = mkdtempSync(join(tmpdir(), 'switchboard-platform-'));
    try {
      writeFileSync(join(tmp, 'pkg.tgz'), body);
      const unpacked = spawnSync('tar', ['-xzf', join(tmp, 'pkg.tgz'), '-C', tmp], { encoding: 'utf8' });
      assert.equal(unpacked.status, 0, `tar failed: ${unpacked.stderr}`);
      const manifestPath = join(tmp, 'package', 'package.json');
      const packed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.deepEqual(packed.dependencies ?? {}, {}, `${name} has dependencies the stage does not walk`);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(tmp, 'package'), dest);
      added += 1;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return added;
}

async function stageStrace(stage, machine) {
  const pin = STRACE_PACKAGES[machine];
  assert(pin, `no pinned strace for Docker architecture ${machine}`);
  const deb = join(stage, 'strace.deb');
  const response = await fetch(`https://deb.debian.org/debian/pool/main/s/strace/strace_6.1-0.1_${pin.arch}.deb`, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `strace download failed: HTTP ${response.status}`);
  writeFileSync(deb, Buffer.from(await response.arrayBuffer()));
  assert.equal(sha256(deb), pin.deb, 'strace package hash');
  const extract = (file) => docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,src=${stage},dst=/work`, '--entrypoint', 'dpkg-deb', IMAGE, '-x', `/work/${file}`, '/work/strace']);
  extract('strace.deb');
  assert.equal(sha256(join(stage, 'strace/usr/bin/strace')), pin.bin, 'strace executable hash');
  if (pin.unwind) {
    const unwindDeb = join(stage, pin.unwind.file);
    const unwind = await fetch(`https://deb.debian.org/debian/pool/main/libu/libunwind/${pin.unwind.file}`, { signal: AbortSignal.timeout(120_000) });
    assert(unwind.ok, `libunwind download failed: HTTP ${unwind.status}`);
    writeFileSync(unwindDeb, Buffer.from(await unwind.arrayBuffer()));
    assert.equal(sha256(unwindDeb), pin.unwind.deb, 'libunwind package hash');
    extract(pin.unwind.file);
    for (const [file, hash] of Object.entries(pin.unwind.libs)) assert.equal(sha256(join(stage, 'strace', file)), hash, `${file} hash`);
  }
  assert.equal(spawnSync('chmod', ['-R', 'a+rX', join(stage, 'strace')]).status, 0, 'chmod strace failed');
}

/** nobody's home is the decoy directory. The image account list is otherwise unchanged. */
function stagePasswd(stage) {
  const text = docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--entrypoint', 'cat', IMAGE, '/etc/passwd']);
  const rewritten = text.split('\n').map((line) => {
    const fields = line.split(':');
    if (fields[0] !== 'nobody' || fields.length < 7) return line;
    fields[5] = HOME;
    return fields.join(':');
  }).join('\n');
  const file = join(stage, 'passwd');
  writeFileSync(file, `${rewritten}\n`);
  chmodSync(file, 0o644);
}

/** Builds the mounted tree: the packed package and SDK closure under node_modules, the fixtures, the decoys. */
async function stageTree(stage, machine) {
  const tree = join(stage, 'tree');
  const modules = join(tree, 'node_modules', ...manifest.name.split('/'));
  mkdirSync(dirname(modules), { recursive: true });
  const [packed] = JSON.parse(runNpm(['pack', '--json', '--pack-destination', stage]));
  const unpacked = spawnSync('tar', ['-xzf', join(stage, packed.filename), '-C', stage], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, `tar failed: ${unpacked.stderr}`);
  renameSync(join(stage, 'package'), modules);
  const closure = sdkClosure();
  for (const dir of closure.dirs) {
    cpSync(join(root, dir), join(tree, dir), { recursive: true, filter: (source) => !relative(join(root, dir), source).startsWith('node_modules') });
  }
  const lockPackages = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const fetched = await stageLockedPackages(tree, containerPlatformPackages(lockPackages, closure.optional, machine), lockPackages);
  for (const file of [...SUITES, ...CONTROLS.map((control) => control.entry), ...FIXTURES, 'scripts/support/qualification-image.mjs']) {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    copyFileSync(join(root, file), join(tree, file));
  }
  const home = join(stage, 'home');
  for (const file of DECOY_FILES) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), 'switchboard isolated-import decoy; not a credential\n');
  }
  chmodSync(stage, 0o755);
  // The container user is nobody: everything mounted must be readable and nothing needs to be writable.
  assert.equal(spawnSync('chmod', ['-R', 'a+rX', tree, home]).status, 0, 'chmod failed');
  return { tree, home, packed: packed.filename, packages: closure.dirs.length, fetched };
}

/** One confined, traced container run. Resolves after the container is gone; never rejects. */
function confinedRun(stage, entry, machine) {
  const name = `switchboard-isolated-${randomUUID()}`;
  const pin = STRACE_PACKAGES[machine];
  const environment = ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', `HOME=${HOME}`, 'TMPDIR=/tmp'];
  // strace loads libunwind through this path. -E removes it before the traced command starts.
  const strace = [STRACE, '-f', '-q', '-y', '-s', '4096', '-e', 'trace=%file,%network,%process,io_uring_setup', '-o', '/proc/self/fd/3'];
  if (pin.unwind) {
    environment.push('LD_LIBRARY_PATH=/opt/strace/usr/lib/x86_64-linux-gnu');
    strace.push('-E', 'LD_LIBRARY_PATH');
  }
  const args = ['run', '--rm', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '512', '--memory', '2g',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m',
    '--tmpfs', '/dev/shm:ro,noexec,nosuid,nodev,size=65536k',
    '--mount', `type=bind,src=${stage.tree},dst=${STAGE},readonly`,
    '--mount', `type=bind,src=${stage.home},dst=${HOME},readonly`,
    '--mount', `type=bind,src=${join(stage.dir, 'strace')},dst=/opt/strace,readonly`,
    '--mount', `type=bind,src=${join(stage.dir, 'passwd')},dst=/etc/passwd,readonly`,
    '--workdir', STAGE, '--entrypoint', '/usr/bin/env', IMAGE,
    ...environment,
    // The trace leaves on fd 3 (container stderr); the program's stdout and stderr both go to container stdout.
    '/bin/sh', '-c', 'unset PWD; exec "$@" 3>&2 2>&1', 'sh',
    ...strace,
    NODE, '--test-reporter=tap', `${STAGE}/${entry}`];
  const verdict = createVerdict({ decoy: DECOY, node: NODE, entry: `${STAGE}/${entry}`, scripts: SCRIPTS,
    executable: (path) => path === `${STAGE}/tests/adapters/codex/sdk-cli.mjs` || CODEX_VENDOR.test(path) });
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let pending = '';
    let breach = null;
    const timer = setTimeout(() => { breach = 'deadline'; spawnSync('docker', ['kill', name]); }, RUN_DEADLINE_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > OUTPUT_CAP) { breach ??= 'output-overflow'; stdout = stdout.slice(-OUTPUT_CAP); }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      pending += chunk;
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        verdict.line(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (pending) verdict.line(pending);
      const result = verdict.finish();
      // strace reports its own failures on its stderr, which is the container stdout here.
      for (const text of stdout.split('\n').filter((row) => row.startsWith('strace: '))) result.violations.push({ kind: 'trace', detail: text });
      if (breach) result.violations.push({ kind: 'trace', detail: `run stopped: ${breach}` });
      const count = (label) => Number(stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'gm'))?.at(-1)?.split(' ')[2] ?? NaN);
      resolve({ entry, code, signal, ms: Date.now() - started, stdout, ...result,
        ok: result.violations.length === 0, kinds: [...new Set(result.violations.map((v) => v.kind))].sort(),
        tests: { pass: count('pass'), fail: count('fail') } });
    });
  });
}

const describe = (run) => [`  exit ${run.code}${run.signal ? ` signal ${run.signal}` : ''}, ${run.lines} trace lines, ${run.launches} launches, ${run.refused} refused execs, ${run.terminalDiagnostics} terminal diagnostics, ${run.ms} ms`,
  ...run.violations.slice(0, 20).map((v) => `  ${v.kind}: ${v.detail}`), ...(run.violations.length > 20 ? [`  ... ${run.violations.length - 20} more`] : [])].join('\n');

async function main() {
  const machine = docker(['info', '--format', '{{.Architecture}}']);
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) docker(['pull', '--quiet', IMAGE], { timeout: 600_000 });
  process.stdout.write(runNpm(['run', 'build']));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'switchboard-isolated-')));
  const failures = [];
  try {
    await stageStrace(dir, machine);
    stagePasswd(dir);
    const stage = { dir, ...await stageTree(dir, machine) };
    console.log(`isolated-native: ${machine}, ${stage.packed}, ${stage.packages} SDK closure packages, ${stage.fetched} container platform packages, ${DECOY_FILES.length} decoys, stage ${dir}`);
    for (const control of CONTROLS) {
      const run = await confinedRun(stage, control.entry, machine);
      const rejected = run.code === 0 && run.kinds.length === 1 && run.kinds[0] === control.expect;
      console.log(`isolated-native: ${rejected ? 'ok' : 'UNEXPECTED'} control ${control.entry} exited ${run.code} and was rejected for [${run.kinds.join(', ')}]`
        + (run.violations[0] ? `: ${run.violations[0].detail.slice(0, 160)}` : ''));
      if (!rejected) failures.push(`control ${control.entry} must exit 0 and fail only for ${control.expect}\n${describe(run)}`);
    }
    if (failures.length === 0) {
      for (const entry of SUITES) {
        const run = await confinedRun(stage, entry, machine);
        const passed = run.ok && run.code === 0 && run.tests.fail === 0 && run.tests.pass > 0;
        console.log(`isolated-native: ${passed ? 'ok' : 'FAIL'} ${entry}: ${run.tests.pass} passed, ${run.tests.fail} failed; ${run.lines} trace lines, ${run.launches} launches, ${run.terminalDiagnostics} terminal diagnostics, ${run.violations.length} violations, ${run.ms} ms`);
        if (!passed) failures.push(`${entry}\n${describe(run)}\n  output tail:\n${run.stdout.slice(-4000)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`FAIL isolated-native:\n${failures.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS isolated-native: ${CONTROLS.length}/${CONTROLS.length} exit-0 controls rejected, ${SUITES.length} suites passed with clean traces`);
}

await main();
