import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedContainer } from './lifecycle.mjs';

// The shared host of the execution (x9av) and interaction (118i) native proofs: it verifies the pinned archive, compiles the
// product into owned work with the sources unchanged, runs one fresh isolated container per scenario through
// `<kind>-reader.mjs`, proves cleanup and prints the full report. `concludeNativeProof` is each proof's only conclusion site.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const SOURCES = ['src/adapters/codex/execution.ts', 'src/adapters/codex/sessions.ts', 'src/adapters/codex/transport.ts',
  'src/adapters/codex/wire.ts', 'src/core/dispatch.ts', 'src/core/sessions.ts', 'src/core/discovery.ts', 'src/core/events.ts',
  'src/core/contracts.ts'];

/** @param {{ kind: string, scenarios: string[], sources?: string[], compiled: string[] }} proof compiled: dist paths hashed. */
export async function runNativeProof({ kind, scenarios, sources = [], compiled: compiledFiles }) {
  const [archive, architecture = process.arch] = process.argv.slice(2);
  assert(archive, `Usage: node spikes/codex-native/${kind}-proof.mjs <official-codex.tgz> [arm64|x64]`);
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
  const watched = [...SOURCES, ...sources];
  mkdirSync(join(here, '.work'), { recursive: true });
  const work = mkdtempSync(join(here, `.work/${kind}-`));
  const name = `switchboard-codex-${kind}-${randomUUID()}`;
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
    const before = Object.fromEntries(watched.map((file) => [file, sha256(join(repo, file))]));
    run(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(repo, 'tsconfig.json'), '--outDir', dist]);
    assert.deepEqual(Object.fromEntries(watched.map((file) => [file, sha256(join(repo, file))])), before, 'Sources unchanged during compilation');
    writeFileSync(join(dist, 'package.json'), JSON.stringify({ type: 'module' }));
    const compiled = { ...Object.fromEntries(compiledFiles.map((file) => [`${file}Sha256`, sha256(join(dist, `adapters/codex/${file}.js`))])),
      sources: before };
    const docker = (command) => {
      const mounts = ['--mount', `type=bind,source=${binary},target=/opt/codex,readonly`,
        '--mount', `type=bind,source=${dist},target=/dist,readonly`];
      for (const helper of [`${kind}-reader.mjs`, 'account-reads.mjs', 'inventory.mjs']) {
        mounts.push('--mount', `type=bind,source=${join(here, helper)},target=/opt/${helper},readonly`);
      }
      try {
        return ownedContainer(run, ['run', '--rm', '--name', name, '--platform', pin.platform, '--network', 'none',
          '--read-only', '--pids-limit', '128', '--cpus', '2', '--memory', '768m',
          '--tmpfs', '/tmp:rw,size=128m', '--tmpfs', '/root:rw,size=64m', ...mounts,
          pins.image, 'timeout', '40', ...command], name);
      } catch (error) {
        cleanupUncertain ||= error.cleanupUncertain;
        console.error(JSON.stringify({ containerFailure: name, stdout: error.stdout, stderr: error.stderr }));
        throw error;
      }
    };
    assert.equal(docker(['/opt/codex', '--version']).trim(), `codex-cli ${pins.native}`);
    // One fresh container (fresh home, fresh registry) per scenario; a scenario seeds any durable thread it needs.
    const reports = {};
    for (const scenario of scenarios) reports[scenario] = JSON.parse(docker(['node', `/opt/${kind}-reader.mjs`, scenario]));
    result = { native: pins.native, image: pins.image, platform: pin.platform, archiveIntegrity: 'verified', compiled, reports };
  } finally {
    if (cleanupUncertain) console.error(JSON.stringify({ cleanupUncertain, container: name, retainedWork: work }));
    else { rmSync(work, { recursive: true, force: true }); assert(!existsSync(work), 'Owned work removed'); }
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Prints the pinned object and the checks before any assertion (and waits for stdout to drain, since a large report can
 * still be queued on a pipe), then asserts every check and, once `<kind>-proof-result.json` has a non-null outcome, the pin.
 */
export async function concludeNativeProof(kind, pinned, checks) {
  console.log(JSON.stringify({ pinned }));
  console.log(JSON.stringify({ checks }));
  await new Promise((resolve) => process.stdout.write('', resolve));
  for (const [check, passed] of Object.entries(checks)) assert(passed, `Native ${kind} proof ${check}`);
  const recorded = JSON.parse(readFileSync(join(here, `${kind}-proof-result.json`), 'utf8'));
  // A pending record (outcome null) only reports, as the sessions proof first did.
  if (recorded.outcome !== null) assert.deepEqual(pinned, recorded.pinned, `Recorded native ${kind} proof`);
}
