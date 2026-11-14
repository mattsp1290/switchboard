import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
assert.equal(process.versions.node, pins.node);
const [archive, architecture = process.arch] = process.argv.slice(2);
assert(archive, 'Usage: node spikes/codex-native/qualify.mjs <official-codex.tgz> [arm64|x64]');
const pin = pins.artifacts[architecture];
assert(pin, 'Only pinned Linux arm64 and x64 artifacts are supported');
assert(statSync(archive).size <= 200 * 1024 * 1024, 'Bounded native archive');
for (const [name, version] of [['typescript', '7.0.2'], ['@types/node', '24.19.2']]) {
  assert.equal(JSON.parse(readFileSync(join(here, '../../node_modules', name, 'package.json'), 'utf8')).version, version);
}
const digest = createHash('sha512');
for await (const chunk of createReadStream(archive)) digest.update(chunk);
assert.equal(digest.digest('base64'), pin.sha512, 'Native archive integrity');
mkdirSync(join(here, '.work'), { recursive: true });
const work = mkdtempSync(join(here, '.work/run-'));
const name = `switchboard-codex-${randomUUID()}`;
const run = (command, args, options = {}) => execFileSync(command, args, { timeout: 45000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', ...options });
try {
  const binary = join(work, 'codex');
  const fd = openSync(binary, 'wx');
  try { run('tar', ['-xOf', resolve(archive), `package/vendor/${pin.target}/bin/codex`], { stdio: ['ignore', fd, 'pipe'] }); }
  finally { closeSync(fd); }
  chmodSync(binary, 0o500);
  const docker = (command, script, extraMounts = []) => {
    const mounts = ['--mount', `type=bind,source=${binary},target=/opt/codex,readonly`];
    if (script) mounts.push('--mount', `type=bind,source=${join(here, script)},target=/opt/fixture.mjs,readonly`);
    try {
      return run('docker', ['run', '--rm', '--name', name, '--platform', pin.platform, '--network', 'none',
        '--read-only', '--pids-limit', '128', '--cpus', '2', '--memory', '768m',
        '--tmpfs', '/tmp:rw,size=128m', '--tmpfs', '/root:rw,size=64m', ...mounts, ...extraMounts,
        pins.image, 'timeout', '40', ...command]);
    } finally {
      try { run('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
  };
  assert.equal(docker(['/opt/codex', '--version']).trim(), `codex-cli ${pins.native}`);
  const generated = JSON.parse(docker(['node', '/opt/fixture.mjs'], 'bindings.mjs'));
  let transformedImports = 0;
  for (const [file, source] of Object.entries(generated)) {
    assert(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(file));
    const target = join(work, 'generated', file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source.replace(/(\bfrom\s+")(\.\.?\/[^"\n]+)(")/g, (_, start, specifier, end) => {
      assert(!/\.[a-z]+$/i.test(specifier), 'Expected generated extensionless module import');
      const module = posix.join(posix.dirname(file), specifier);
      const suffix = Object.hasOwn(generated, `${module}.ts`) ? '.js' : '/index.js';
      assert(Object.hasOwn(generated, suffix === '.js' ? `${module}.ts` : `${module}/index.ts`));
      transformedImports++;
      return `${start}${specifier}${suffix}${end}`;
    }));
  }
  assert(transformedImports > 0);
  copyFileSync(join(here, 'consumer.ts'), join(work, 'consumer.ts'));
  writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'], types: ['node'],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true,
  }, include: ['**/*.ts'] }));
  run(process.execPath, [join(here, '../../node_modules/typescript/bin/tsc'), '-p', join(work, 'tsconfig.json')]);
  const behavior = JSON.parse(docker(['node', '/opt/fixture.mjs'], 'probe.mjs'));
  assert.equal(behavior.node, pins.node);
  assert.equal(behavior.architecture, architecture);
  const prepared = JSON.parse(docker(['node', '/opt/fixture.mjs', 'prepare'], 'discovery.mjs'));
  const recordsFile = join(work, 'records.json');
  writeFileSync(recordsFile, JSON.stringify(prepared.records));
  const unauthorized = prepared.records.find((record) => record.name === 'unauthorized');
  const malformed = prepared.records.find((record) => record.name === 'first');
  assert(unauthorized && malformed);
  const discovery = [];
  const entriesUnder = (directory, prefix = '') => {
    const entries = [];
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
      const file = join(prefix, entry.name);
      entries.push(file);
      if (entry.isDirectory()) entries.push(...entriesUnder(directory, file));
      assert(entries.length <= 128, 'Bounded fixture entry count');
    }
    return entries;
  };
  const preflight = (directory) => {
    const entries = entriesUnder(directory);
    let bytes = 0;
    for (const entry of entries) {
      const metadata = lstatSync(join(directory, entry));
      assert(!metadata.isSymbolicLink(), 'Host rejects symlinks before native discovery');
      assert(metadata.isFile() || metadata.isDirectory(), 'Host rejects special files');
      bytes += metadata.isFile() ? metadata.size : 0;
    }
    assert(bytes < 8 * 1024 * 1024, 'Bounded authorized synthetic history');
  };
  for (const mode of ['indexed', 'unindexed', 'malformed', 'inaccessible', 'symlink']) {
    const source = join(work, mode);
    mkdirSync(join(source, 'sessions'), { recursive: true });
    mkdirSync(join(source, 'archived_sessions'));
    const outside = join(work, `${mode}-unauthorized`);
    mkdirSync(outside);
    const outsidePath = join(outside, posix.basename(unauthorized.path));
    for (const [file, encoded] of Object.entries(prepared.files)) {
      assert(/^(?:(?:sessions|archived_sessions)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.jsonl|[a-z_]+[0-9]+\.sqlite(?:-(?:wal|shm))?)$/.test(file));
      if (file.includes('.sqlite') && mode !== 'indexed') continue;
      const target = file === unauthorized.path ? outsidePath : join(source, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, mode === 'malformed' && file === malformed.path ? '{invalid-json\n' : Buffer.from(encoded, 'base64'));
    }
    preflight(source);
    const extra = ['--mount', `type=bind,source=${recordsFile},target=/opt/records.json,readonly`,
      '--mount', `type=bind,source=${outside},target=/unauthorized,readonly`];
    if (mode === 'symlink') {
      symlinkSync(`/unauthorized/${posix.basename(unauthorized.path)}`, join(source, unauthorized.path));
      symlinkSync('/unauthorized', join(source, 'sessions', '2099'));
      assert.throws(() => preflight(source), /Host rejects symlinks/);
    }
    if (mode === 'inaccessible') {
      rmSync(join(source, 'sessions'), { recursive: true });
      writeFileSync(join(source, 'sessions'), 'synthetic invalid directory');
    }
    const hashes = () => Object.fromEntries(entriesUnder(source)
      .filter((file) => lstatSync(join(source, file)).isFile())
      .map((file) => [file, createHash('sha256').update(readFileSync(join(source, file))).digest('hex')]));
    const before = hashes();
    for (const entry of readdirSync(source)) extra.push('--mount', `type=bind,source=${join(source, entry)},target=/root/.codex/${entry},readonly`);
    discovery.push(JSON.parse(docker(['node', '/opt/fixture.mjs', mode], 'discovery.mjs', extra)));
    assert.deepEqual(hashes(), before, 'Host source fixture preserved across entire native lifecycle');
  }
  console.log(JSON.stringify({ native: pins.native, image: pins.image, platform: pin.platform,
    archiveIntegrity: 'verified', generatedFiles: Object.keys(generated).length, transformedImports,
    strictNodeNextNoDOM: 'passed', behavior, discovery }, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
