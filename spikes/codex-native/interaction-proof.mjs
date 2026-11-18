import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedContainer } from './lifecycle.mjs';

// 118i native proof: the compiled private Codex interaction bridge over the execution module against the pinned app-server
// and a synthetic loopback Responses service that emits a real command approval (N1-N9, N6 folded into N1). Separate from execution-proof.mjs
// so its pin, sources and guarded closure stay unchanged.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const pins = JSON.parse(readFileSync(join(here, 'pins.json'), 'utf8'));
const [archive, architecture = process.arch] = process.argv.slice(2);
assert(archive, 'Usage: node spikes/codex-native/interaction-proof.mjs <official-codex.tgz> [arm64|x64]');
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
  'src/core/contracts.ts', 'src/adapters/codex/interaction.ts', 'src/core/interaction.ts'];
const SCENARIOS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N7', 'N8', 'N9'];
mkdirSync(join(here, '.work'), { recursive: true });
const work = mkdtempSync(join(here, '.work/interaction-'));
const name = `switchboard-codex-interaction-${randomUUID()}`;
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
  const compiled = { executionSha256: sha256(join(dist, 'adapters/codex/execution.js')),
    interactionSha256: sha256(join(dist, 'adapters/codex/interaction.js')), sources: before };
  const docker = (command) => {
    const mounts = ['--mount', `type=bind,source=${binary},target=/opt/codex,readonly`,
      '--mount', `type=bind,source=${dist},target=/dist,readonly`];
    for (const helper of ['interaction-reader.mjs', 'account-reads.mjs', 'inventory.mjs']) {
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
  for (const scenario of SCENARIOS) reports[scenario] = JSON.parse(docker(['node', '/opt/interaction-reader.mjs', scenario]));
  result = { native: pins.native, image: pins.image, platform: pin.platform, archiveIntegrity: 'verified', compiled, reports };
} finally {
  if (cleanupUncertain) console.error(JSON.stringify({ cleanupUncertain, container: name, retainedWork: work }));
  else { rmSync(work, { recursive: true, force: true }); assert(!existsSync(work), 'Owned work removed'); }
}
console.log(JSON.stringify(result, null, 2));
// The only conclusion site, after the full report is printed and cleanup is proved. Checks cover only what the bridge
// claims: one decision frame per host reply and none otherwise, single use, declined-only no-effect, lost/expired/
// withdrawn without a decision, interrupt requested, transport survival and writer release only on exit. Native reactions
// (terminal after interrupt or expiry, accept or cancel item status, replay after resume, advertised tools) are pinned,
// never asserted; native notification order is recorded raw only. Every native error reply is in each report's raw.nativeErrors.
const { N1, N2, N3, N4, N5, N7, N8, N9 } = result.reports;
const statuses = ['completed', 'interrupted', 'failed'];
const decisionNames = (request) => (request?.availableDecisions ?? [])
  .map((d, index) => (typeof d === 'string' ? d : `${Object.keys(d)[0]}:${index}`));
const approvalMethod = 'item/commandExecution/requestApproval';
const checks = {
  harness: Object.values(result.reports).every((report) => report.failures.length === 0 && report.heldAtEnd === 0),
  // Choices are the request's own availableDecisions; a not-offered choice is refused locally with nothing written.
  N1: N1.pendingMethod === approvalMethod && JSON.stringify(N1.choices) === JSON.stringify(decisionNames(N1.serverRequests[0]))
    && N1.notOffered === 'error:choice-mismatch' && N1.framesAfterNotOffered === 0 && N1.reply === 'ok'
    && N1.duplicate === 'error:duplicate-interaction' && JSON.stringify(N1.decisionFrames) === '["cancel"]'
    && N1.settlements.join() === 'replied' && N1.marker === false && statuses.includes(N1.terminal)
    && N1.item.includes('declined') === N1.bridge.includes('observed:item/completed:known:qualified'),
  N2: N2.reply === 'ok' && N2.duplicate === 'error:duplicate-interaction' && JSON.stringify(N2.decisionFrames) === '["accept"]'
    && statuses.includes(N2.terminal),
  N3: N3.b === 'completed' && N3.aPendingAfterB && N3.read === 'result' && N3.reply === 'ok' && statuses.includes(N3.a)
    && N3.closeReasons.every((reason) => reason === 'caller-close'),
  N4: N4.interrupt === 'replied' && N4.decisionFrames === 0 && N4.marker === false && N4.independent === 'completed',
  N5: N5.heldBeforeKill === 1 && N5.heldAfterExit === 0 && N5.settlements.join() === 'lost' && N5.replyFramesBeforeResume === 0
    && N5.lateReply === 'error:stale-interaction' && N5.marker === false && N5.resume === 'resumed' && N5.inferenceAfterResume === 0,
  N7: N7.reply === 'ok' && N7.interrupt === 'replied' && statuses.includes(N7.terminal),
  N8: N8.errorOnlyRefusals === true,
  N9: N9.settlements.join() === 'expired' && N9.decisionFrames === 0 && N9.errorFrames.includes(-32000) && N9.marker === false
    && N9.independent === 'completed',
};
// Architecture-independent pin: outcomes, statuses, counts and booleans only; never IDs, paths or timestamps. Printed before
// any assertion so a failing run still shows the object to compare. Arrival order stays raw (report.order, withdrawnBy):
// serverRequest/resolved, item/completed and turn/completed come from separate native sources, and 0.169 already showed
// unstable cross-source order (execution X1 thread/started), so order is evidence, not a pinned claim.
const requests = (report) => report.serverRequests.map(({ method, idType, approvalId, availableDecisions }) =>
  ({ method, idType, approvalId, offered: availableDecisions?.map((d) => (typeof d === 'string' ? d : Object.keys(d)[0])) ?? null }));
const pinned = {
  N1: { choices: N1.choices, item: N1.item, terminal: N1.terminal, requests: requests(N1), markerInference: N1.markerInference },
  N2: { terminal: N2.terminal, item: N2.item, marker: N2.marker, markerInference: N2.markerInference },
  N3: { concurrentA: N3.concurrentA, a: N3.a },
  N4: { terminalWithin5s: N4.terminalWithin5s, terminal: N4.terminal, settlements: N4.settlements, item: N4.item,
    markerInference: N4.markerInference },
  N5: { completion: N5.completion, resumedLastTurn: N5.resumedLastTurn, resumedItems: N5.resumedItems,
    requestsAfterResume: N5.requestsAfterResume, reappeared: N5.reappeared ?? null },
  N7: { commandStarted: N7.commandStarted, terminal: N7.terminal, item: N7.item, marker: N7.marker },
  N8: { candidates: N8.candidates, notAdvertised: N8.notAdvertised ?? false, reactions: N8.reactions, refusedMethods: N8.refusedMethods },
  N9: { terminalWithin5s: N9.terminalWithin5s, terminal: N9.terminal, item: N9.item },
};
console.log(JSON.stringify({ pinned }));
console.log(JSON.stringify({ checks }));
// A large report can still be queued on a pipe; an assertion exit would drop it and the lines above.
await new Promise((resolve) => process.stdout.write('', resolve));
for (const [check, passed] of Object.entries(checks)) assert(passed, `Native interaction proof ${check}`);
const recorded = JSON.parse(readFileSync(join(here, 'interaction-proof-result.json'), 'utf8'));
// A recorded outcome enforces the pin; a pending record (outcome null) only reports, as the execution proof first did.
if (recorded.outcome !== null) assert.deepEqual(pinned, recorded.pinned, 'Recorded native interaction proof');
