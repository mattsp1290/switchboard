import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedContainer } from './lifecycle.mjs';

// x9av native proof: the compiled private Codex execution module against the pinned app-server and a synthetic loopback
// Responses service (X1-X9). Separate from qualify.mjs and sessions-proof.mjs so their pins and guarded closures stay unchanged.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
const [archive, architecture = process.arch] = process.argv.slice(2);
assert(archive, 'Usage: node spikes/codex-native/execution-proof.mjs <official-codex.tgz> [arm64|x64]');
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
const SOURCES = ['src/adapters/codex/execution.ts', 'src/adapters/codex/sessions.ts', 'src/adapters/codex/transport.ts',
  'src/adapters/codex/wire.ts', 'src/core/dispatch.ts', 'src/core/sessions.ts', 'src/core/discovery.ts', 'src/core/events.ts',
  'src/core/contracts.ts'];
const SCENARIOS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9'];
mkdirSync(join(here, '.work'), { recursive: true });
const work = mkdtempSync(join(here, '.work/execution-'));
const name = `switchboard-codex-execution-${randomUUID()}`;
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
  const compiled = { executionSha256: sha256(join(dist, 'adapters/codex/execution.js')), sources: before };
  const docker = (command) => {
    const mounts = ['--mount', `type=bind,source=${binary},target=/opt/codex,readonly`,
      '--mount', `type=bind,source=${dist},target=/dist,readonly`];
    for (const helper of ['execution-reader.mjs', 'account-reads.mjs', 'inventory.mjs']) {
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
  for (const scenario of SCENARIOS) reports[scenario] = JSON.parse(docker(['node', '/opt/execution-reader.mjs', scenario]));
  result = { native: pins.native, image: pins.image, platform: pin.platform, archiveIntegrity: 'verified', compiled, reports };
} finally {
  if (cleanupUncertain) console.error(JSON.stringify({ cleanupUncertain, container: name, retainedWork: work }));
  else { rmSync(work, { recursive: true, force: true }); assert(!existsSync(work), 'Owned work removed'); }
}
console.log(JSON.stringify(result, null, 2));
// The only conclusion site, after the full report is printed and cleanup is proved. Checks cover what the module claims
// from qualified native evidence; unqualified signals (usage, turn/started, the error-reply mapping, error willRetry, the
// native resume while another app-server holds the thread) are recorded raw, never asserted here. Every native error
// reply is in each report's raw.nativeErrors.
const { X1, X2, X3, X4, X5, X6, X7, X8, X9 } = result.reports;
const checks = {
  harness: Object.values(result.reports).every((report) => report.failures.length === 0 && report.heldAtEnd === 0),
  X1: X1.completion === 'completed' && ['accepted', 'conclusive'].includes(X1.snapshot) && X1.inference.answer === 1,
  X2: X2.resume === 'resumed' && X2.sameId && X2.resumeInference === 0 && X2.completion === 'completed' && X2.prefixPreserved,
  X3: X3.b === 'completed' && X3.aPendingAfterB && X3.a === 'completed',
  X4: X4.accepted === 'accepted' && X4.terminal === 'interrupted' && X4.busyDuringHold === 'busy' && X4.requestsDuringHold === 0
    && X4.independent === 'completed' && X4.close?.released === false && X4.close?.interrupt === 'replied'
    && X4.busyAfterClose === 'busy' && X4.requestsAfterClose === 0 && X4.heldAfterExit === X4.heldDuringHold - 1
    && X4.admittedAfter === 'resumed' && X4.after === 'completed' && X4.holdInference === 1,
  X5: X5.close?.released === false && X5.reopen === 'busy' && X5.reopenRequests === 0,
  X6: X6.snapshot === 'outcome-unknown' && X6.turnStartWrites === 1 && X6.retainedBeforeExit === 1 && X6.releasedAfterExit
    && X6.resume === 'resumed' && X6.inferenceAfterResume === X6.inferenceBeforeExit && X6.inferenceBeforeExit <= 1,
  X7: X7.turnStartWrites === 1 && (X7.snapshot !== 'conclusive' || X7.completion === 'rejected'),
  X8: X8.terminal === 'failed' && X8.deltaSeen && X8.disconnectInference === 1,
  X9: X9.aborted === 'error:closed' && X9.detached === 1 && X9.heldAfterAbort === 0 && X9.freshCreate === 'ok',
};
console.log(JSON.stringify({ checks }));
for (const [check, passed] of Object.entries(checks)) assert(passed, `Native execution proof ${check}`);
// Architecture-independent pin: outcomes, counts, booleans and native-reported usage only; never IDs, paths, timestamps or hashes.
const pinned = { X1: { snapshot: X1.snapshot, eventKinds: X1.eventKinds, nativeMethods: X1.nativeMethods, turnStartedSeen: X1.turnStartedSeen,
  usageSeen: X1.usageSeen, usage: X1.usage }, X2: { resumeTurns: X2.resumeTurns }, X5: { unsubscribe: X5.close?.unsubscribe ?? null,
  reopen: X5.reopen, afterReopen: X5.afterReopen ?? null }, X6: { completion: X6.completion, inferenceBeforeExit: X6.inferenceBeforeExit },
  X7: { snapshot: X7.snapshot, completion: X7.completion, error: X7.raw.error, turnEventsWithin500ms: X7.turnEventsWithin500ms },
  X8: { errorNotification: X8.errorNotification } };
console.log(JSON.stringify({ pinned }));
const recorded = JSON.parse(readFileSync(join(here, 'execution-proof-result.json'), 'utf8'));
// A recorded outcome enforces the pin; a pending record (outcome null) only reports, as the sessions proof first did.
if (recorded.outcome !== null) assert.deepEqual(pinned, recorded.pinned, 'Recorded native execution proof');
