import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELECTORS, observeSource, verifySource } from './inventory.mjs';
import { ownedContainer } from './lifecycle.mjs';

// pg51 native proof: the compiled private Codex sessions module against native-created synthetic homes (R1-R6).
// Separate from qualify.mjs so its modes, the guarded runner closures and the pinned source hashes stay unchanged.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
const [archive, architecture = process.arch] = process.argv.slice(2);
assert(archive, 'Usage: node spikes/codex-native/sessions-proof.mjs <official-codex.tgz> [arm64|x64]');
const pin = pins.artifacts[architecture];
assert(pin, 'Only pinned Linux arm64 and x64 artifacts are supported');
assert.equal(process.versions.node, pins.node);
assert(statSync(archive).size <= 200 * 1024 * 1024, 'Bounded native archive');
for (const [name, version] of [['typescript', '7.0.2'], ['@types/node', '24.19.2']]) {
  assert.equal(JSON.parse(readFileSync(join(repo, 'node_modules', name, 'package.json'), 'utf8')).version, version);
}
const digest = createHash('sha512');
for await (const chunk of createReadStream(archive)) digest.update(chunk);
assert.equal(digest.digest('base64'), pin.sha512, 'Native archive integrity');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const SOURCES = ['src/adapters/codex/sessions.ts', 'src/adapters/codex/transport.ts', 'src/adapters/codex/wire.ts',
  'src/core/sessions.ts', 'src/core/discovery.ts', 'src/core/events.ts', 'src/core/contracts.ts'];
mkdirSync(join(here, '.work'), { recursive: true });
const work = mkdtempSync(join(here, '.work/sessions-'));
const name = `switchboard-codex-sessions-${randomUUID()}`;
const run = (command, args, options = {}) => execFileSync(command, args, { timeout: 45000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', ...options });
let cleanupUncertain = false;
let result;
try {
  const binary = join(work, 'codex');
  const fd = openSync(binary, 'wx');
  try { run('tar', ['-xOf', resolve(archive), `package/vendor/${pin.target}/bin/codex`], { stdio: ['ignore', fd, 'pipe'] }); }
  finally { closeSync(fd); }
  chmodSync(binary, 0o500);
  const dist = join(work, 'dist');
  const before = Object.fromEntries(SOURCES.map((file) => [file, sha256(join(repo, file))]));
  run(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(repo, 'tsconfig.json'), '--outDir', dist]);
  assert.deepEqual(Object.fromEntries(SOURCES.map((file) => [file, sha256(join(repo, file))])), before, 'Sources unchanged during compilation');
  writeFileSync(join(dist, 'package.json'), JSON.stringify({ type: 'module' }));
  const compiled = { sessionsSha256: sha256(join(dist, 'adapters/codex/sessions.js')), sources: before };
  const docker = (command, script, helpers, extra = []) => {
    const mounts = ['--mount', `type=bind,source=${binary},target=/opt/codex,readonly`,
      '--mount', `type=bind,source=${dist},target=/dist,readonly`,
      '--mount', `type=bind,source=${join(here, script)},target=/opt/${script === 'discovery.mjs' ? 'fixture.mjs' : script},readonly`];
    for (const helper of helpers) mounts.push('--mount', `type=bind,source=${join(here, helper)},target=/opt/${helper},readonly`);
    try {
      return ownedContainer(run, ['run', '--rm', '--name', name, '--platform', pin.platform, '--network', 'none',
        '--read-only', '--pids-limit', '128', '--cpus', '2', '--memory', '768m',
        '--tmpfs', '/tmp:rw,size=128m', '--tmpfs', '/root:rw,size=64m', ...mounts, ...extra,
        pins.image, 'timeout', '40', ...command], name);
    } catch (error) {
      cleanupUncertain ||= error.cleanupUncertain;
      console.error(JSON.stringify({ containerFailure: name, stdout: error.stdout, stderr: error.stderr }));
      throw error;
    }
  };
  assert.equal(docker(['/opt/codex', '--version'], 'sessions-reader.mjs', []).trim(), `codex-cli ${pins.native}`);
  // Creators reuse the qualified discovery modes unchanged.
  const creatorHelpers = ['inventory.mjs', 'client.mjs', 'account-reads.mjs', 'history-copy.mjs', 'legacy-tail.mjs'];
  const prepared = JSON.parse(docker(['node', '/opt/fixture.mjs', 'prepare'], 'discovery.mjs', creatorHelpers));
  const legacyPrepared = JSON.parse(docker(['node', '/opt/fixture.mjs', 'prepare-legacy'], 'discovery.mjs', creatorHelpers));
  const record = (wanted) => prepared.records.find((entry) => entry.name === wanted);
  const first = record('first');
  // The reader runs on `fixture`; `otherProvider` was created on `other`, which native would resume there, so the
  // provider check (ai7m) keeps it out of discovery.
  const expected = ['first', 'second', 'otherCwd', 'accountA', 'accountB'].map((entry) => record(entry).id).sort();
  const manifest = { first: first.id, firstPath: first.path, second: record('second').id, absent: randomUUID(), legacy: legacyPrepared.record.id };
  assert(!prepared.records.some((entry) => entry.id === manifest.absent));
  // Unindexed reader homes: no SQLite, the unauthorized rollout omitted, plus an auxiliary file and a hardlink alias.
  const materialize = (scenario) => {
    const source = join(work, scenario);
    for (const directory of ['sessions', 'archived_sessions']) mkdirSync(join(source, directory), { recursive: true });
    if (scenario === 'legacy') {
      const target = join(source, legacyPrepared.record.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(legacyPrepared.rollout, 'base64'), { flag: 'wx' });
      return source;
    }
    for (const [file, encoded] of Object.entries(prepared.files)) {
      if (file.includes('.sqlite') || file === record('unauthorized').path) continue;
      const target = join(source, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, scenario === 'malformed' && file === first.path ? '{invalid-json\n' : Buffer.from(encoded, 'base64'), { flag: 'wx' });
    }
    writeFileSync(join(source, 'sessions', 'fixture-notes.txt'), 'Harmless synthetic auxiliary file.\n');
    linkSync(join(source, record('second').path), join(source, 'sessions', 'hardlink-alias.opaque'));
    if (scenario === 'inaccessible') {
      rmSync(join(source, 'sessions'), { recursive: true });
      writeFileSync(join(source, 'sessions'), 'synthetic invalid directory');
    }
    return source;
  };
  const reader = (scenario, mounts) => JSON.parse(docker(['node', '/opt/sessions-reader.mjs', scenario, JSON.stringify(manifest)],
    'sessions-reader.mjs', ['account-reads.mjs', 'inventory.mjs'], mounts));
  const reports = {};
  for (const scenario of ['read', 'malformed', 'inaccessible', 'unprivate', 'legacy', 'resume']) {
    // Frozen read-only home: host-held source, read-only mounts, verified over the container lifetime. R6 copies its
    // source into the container's own tmpfs, so the host never receives native writes.
    const source = materialize(scenario);
    const held = observeSource(source, SELECTORS.host);
    const mounts = scenario === 'resume' ? ['--mount', `type=bind,source=${source},target=/opt/resume-home,readonly`]
      : readdirSync(source).flatMap((entry) => ['--mount', `type=bind,source=${join(source, entry)},target=/root/.codex/${entry},readonly`]);
    try { reports[scenario] = reader(scenario, mounts); } finally { verifySource(held, `host ${scenario} container lifetime`); }
  }
  result = { native: pins.native, image: pins.image, platform: pin.platform, archiveIntegrity: 'verified', compiled, expected, manifest, reports };
} finally {
  if (cleanupUncertain) console.error(JSON.stringify({ cleanupUncertain, container: name, retainedWork: work }));
  else { rmSync(work, { recursive: true, force: true }); assert(!existsSync(work), 'Owned work removed'); }
}
console.log(JSON.stringify(result, null, 2));
// The only conclusion site, after the full report is printed and cleanup is proved.
const { reports, expected, manifest } = result;
const { read, malformed, inaccessible, unprivate, legacy, resume } = reports;
const aliasDiagnostics = read.aliasPathEqualsRequest ? 1 : 2;
const checks = {
  harness: Object.values(reports).every((report) => report.failures.length === 0 && report.inference === 0),
  R1: JSON.stringify(read.ids) === JSON.stringify(expected) && read.discover.kind === 'complete' && read.discover.diagnostics === aliasDiagnostics
    && JSON.stringify(read.discover.skipped) === '{"corrupt":0,"inaccessible":0}' && read.inspectFirst === 'available'
    && read.inspectAbsent === 'absent' && read.prepareFirst === 'ready' && read.prepareOtherAccount === 'error:binding-mismatch'
    && read.discoverLegacy.kind === 'complete' && read.discoverLegacy.sessions === 0
    && JSON.stringify(read.binding) === JSON.stringify({ engine: 'codex', nativeVersion: '0.169.0', account: 'apiKey', authorizedScope: '/root/.codex', nativeFormat: 'codex-thread/paginated' }),
  R2: malformed.discover.kind === 'complete' && !malformed.ids.includes(manifest.first) && malformed.ids.length === expected.length - 1
    && malformed.discover.diagnostics === aliasDiagnostics + 1 && malformed.inspectFirst === 'error:native-failure',
  R3: inaccessible.discover.error === 'inaccessible',
  R4: unprivate.bind === 'error:invalid-input' && unprivate.discover.error === 'invalid-input',
  R5: JSON.stringify(legacy.ids) === JSON.stringify([manifest.legacy]) && legacy.discoverPaginated.sessions === 0
    && JSON.stringify(legacy.prepareLegacy) === '{"kind":"incompatible","reason":"native-format"}',
  R6: resume.prepareFirst === 'ready' && resume.resume.sameId && resume.inspectAfter === 'busy' && resume.prepareAfter === 'busy'
    && resume.prepareChangedLogin === 'error:binding-mismatch' && resume.resume.prefixPreserved,
};
console.log(JSON.stringify({ checks }));
for (const [check, passed] of Object.entries(checks)) assert(passed, `Native sessions proof ${check}`);
// Architecture-independent pin: outcomes and counts only, never IDs, paths, timestamps or hashes.
const pinned = { aliasPathEqualsRequest: read.aliasPathEqualsRequest, readDiagnostics: read.discover.diagnostics,
  thread: read.thread, unprivateConfig: unprivate.config, unprivateMethods: unprivate.methods, resumeTurns: resume.resume.turns,
  methods: [...new Set(Object.values(reports).flatMap((report) => report.methods))].sort() };
console.log(JSON.stringify({ pinned }));
const recorded = JSON.parse(readFileSync(join(here, 'sessions-proof-result.json'), 'utf8'));
// A recorded outcome enforces the pin; a pending record (outcome null) would only report, as the first Legacy tail record did.
if (recorded.outcome !== null) assert.deepEqual(pinned, recorded.pinned, 'Recorded native sessions proof');
