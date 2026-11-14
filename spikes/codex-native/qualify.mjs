import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, createReadStream, existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admit, admittedPath, fingerprint, requestBudget } from './inventory.mjs';
import { ownedContainer } from './lifecycle.mjs';

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
let cleanupUncertain = false;
let result;
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
    if (script === 'discovery.mjs') {
      for (const helper of ['inventory.mjs', 'client.mjs', 'account-reads.mjs', 'history-copy.mjs']) mounts.push('--mount', `type=bind,source=${join(here, helper)},target=/opt/${helper},readonly`);
    }
    try {
      return ownedContainer(run, ['run', '--rm', '--name', name, '--platform', pin.platform, '--network', 'none',
        '--read-only', '--pids-limit', '128', '--cpus', '2', '--memory', '768m',
        '--tmpfs', '/tmp:rw,size=128m', '--tmpfs', '/root:rw,size=64m', ...mounts, ...extraMounts,
        pins.image, 'timeout', '40', ...command], name);
    } catch (error) {
      cleanupUncertain ||= error.cleanupUncertain;
      console.error(JSON.stringify({ containerFailure: name, stdout: error.stdout, stderr: error.stderr }));
      throw error;
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
  const boundary = [];
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
    const pathMode = ['indexed', 'unindexed', 'malformed'].includes(mode);
    if (pathMode) {
      writeFileSync(join(source, 'sessions', 'fixture-notes.txt'), 'Harmless synthetic auxiliary file.\n');
      linkSync(join(source, prepared.records.find((record) => record.name === 'second').path), join(source, 'sessions', 'hardlink-alias.opaque'));
    }
    let inventory = admit(source);
    const admittedHashes = fingerprint(source, inventory);
    const inventoryFile = join(work, `${mode}-inventory.json`);
    writeFileSync(inventoryFile, JSON.stringify(inventory));
    const extra = ['--mount', `type=bind,source=${recordsFile},target=/opt/records.json,readonly`,
      '--mount', `type=bind,source=${inventoryFile},target=/opt/inventory.json,readonly`];
    if (mode === 'symlink') {
      symlinkSync(`/unauthorized/${posix.basename(unauthorized.path)}`, join(source, unauthorized.path));
      symlinkSync('/unauthorized', join(source, 'sessions', '2099'));
      assert.throws(() => admit(source), /Host rejects symlinks/);
      extra.push('--mount', `type=bind,source=${outside},target=/unauthorized,readonly`);
    }
    if (mode === 'inaccessible') {
      rmSync(join(source, 'sessions'), { recursive: true });
      writeFileSync(join(source, 'sessions'), 'synthetic invalid directory');
    }
    if (pathMode) {
      let dispatched = 0;
      const dispatch = () => { dispatched++; };
      for (const token of ['../outside', outsidePath, 'sessions/../escape']) {
        assert.throws(() => dispatch(admittedPath(source, token, inventory.entries)), /rejected|relative/);
      }
      const link = join(source, 'sessions', 'rejected-link');
      symlinkSync(outsidePath, link);
      assert.throws(() => dispatch(admittedPath(source, 'sessions/rejected-link', inventory.entries, true)), /Symlink/);
      assert.throws(() => admit(source), /Host rejects symlinks/);
      rmSync(link);
      assert.throws(() => admit(source, { entries: 0 }), /entry budget/);
      const oneRequest = requestBudget(1);
      let admittedRequests = 0;
      oneRequest(() => { admittedRequests++; }, {});
      assert.throws(() => oneRequest(dispatch, {}), /request budget/);
      assert.equal(admittedRequests, 1, 'Host mock consumes the sole request before refusal');
      assert.equal(dispatched, 0, 'Rejected targets never reach native');
      const alias = inventory.entries.find((entry) => entry.token === 'sessions/hardlink-alias.opaque');
      assert.equal(inventory.entries.filter((entry) => entry.inode === alias.inode && entry.device === alias.device).length, 2);
      boundary.push({ mode, rejectedDispatches: dispatched, hardlinkPaths: 2, admittedMockRequests: admittedRequests, admissionBudget: 'refused', requestBudget: 'refused', kind: 'host-only' });
      assert.deepEqual(fingerprint(source, inventory), admittedHashes);
    }
    const hashes = () => Object.fromEntries(entriesUnder(source)
      .filter((file) => lstatSync(join(source, file)).isFile())
      .map((file) => [file, createHash('sha256').update(readFileSync(join(source, file))).digest('hex')]));
    if (pathMode) {
      inventory = admit(source);
      writeFileSync(inventoryFile, JSON.stringify(inventory));
    }
    const before = hashes();
    for (const entry of readdirSync(source)) extra.push('--mount', `type=bind,source=${join(source, entry)},target=/root/.codex/${entry},readonly`);
    try { discovery.push(JSON.parse(docker(['node', '/opt/fixture.mjs', mode], 'discovery.mjs', extra))); }
    finally {
      if (pathMode) {
        assert.deepEqual(admit(source).entries.map((entry) => entry.token), inventory.entries.map((entry) => entry.token));
        assert.deepEqual(fingerprint(source, inventory), admittedHashes, 'Admitted source hashes preserved over container lifecycle');
      }
      assert.deepEqual(hashes(), before, 'Host source fixture preserved across entire native lifecycle');
    }
  }
  const accountPrepared = JSON.parse(docker(['node', '/opt/fixture.mjs', 'prepare-accounts'], 'discovery.mjs'));
  const accountSource = join(work, 'account-reads');
  mkdirSync(accountSource);
  const corrupt = accountPrepared.records.find((record) => record.name === 'corrupt');
  assert(corrupt);
  for (const [file, encoded] of Object.entries(accountPrepared.files)) {
    assert(/^(?:(?:sessions|archived_sessions)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.jsonl|[a-z_]+[0-9]+\.sqlite(?:-(?:wal|shm))?)$/.test(file));
    const target = join(accountSource, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file === corrupt.path ? '{invalid-json\n' : Buffer.from(encoded, 'base64'));
  }
  for (const directory of ['sessions', 'archived_sessions']) mkdirSync(join(accountSource, directory), { recursive: true });
  const accountInventory = admit(accountSource);
  const accountHashes = fingerprint(accountSource, accountInventory);
  const accountRecordsFile = join(work, 'account-records.json');
  const accountInventoryFile = join(work, 'account-inventory.json');
  writeFileSync(accountRecordsFile, JSON.stringify(accountPrepared.records));
  writeFileSync(accountInventoryFile, JSON.stringify({ ...accountInventory, hashes: accountHashes }));
  const accountMounts = ['--mount', `type=bind,source=${accountRecordsFile},target=/opt/records.json,readonly`,
    '--mount', `type=bind,source=${accountInventoryFile},target=/opt/inventory.json,readonly`];
  for (const entry of readdirSync(accountSource)) accountMounts.push('--mount', `type=bind,source=${join(accountSource, entry)},target=/root/.codex/${entry},readonly`);
  let accounts;
  try { accounts = JSON.parse(docker(['node', '/opt/fixture.mjs', 'account-reads'], 'discovery.mjs', accountMounts)); }
  finally {
    assert.deepEqual(admit(accountSource), accountInventory, 'Complete frozen source metadata preserved');
    assert.deepEqual(fingerprint(accountSource, accountInventory), accountHashes, 'All originals preserved over container lifetime');
  }
  result = { native: pins.native, image: pins.image, platform: pin.platform,
    archiveIntegrity: 'verified', generatedFiles: Object.keys(generated).length, transformedImports,
    strictNodeNextNoDOM: 'passed', behavior, boundary, discovery, accounts, accountPreparationRequests: accountPrepared.fixtureRequests };
} finally {
  if (cleanupUncertain) console.error(JSON.stringify({ cleanupUncertain, container: name, retainedWork: work }));
  else { rmSync(work, { recursive: true, force: true }); assert(!existsSync(work), 'Owned work removed'); }
}
console.log(JSON.stringify(result, null, 2));
