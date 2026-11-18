import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seccompProfile } from './pi-seccomp.mjs';

// Host side of the host-tool probes (P0 of the Switchboard adapter migration). Each probe runs in its own fresh Linux
// container with no network but loopback, a read-only root, an empty home on tmpfs and no provider variable. The
// pinned packages come from a named volume that `npm ci --ignore-scripts` filled from this repository's lockfile.
// Usage: node spikes/host-tools/run.mjs <node_modules volume> [--label <label>] [probe ...]
// A label names a volume filled some other way (for example an older SDK) and is added to each result file name.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const work = join(here, '.work');
const pins = JSON.parse(readFileSync(join(repo, 'spikes/codex-native/pins.json'), 'utf8'));
const PROBES = {
  'codex-hold-121': { file: 'codex-probe.mjs', args: ['hold-121'], seconds: 420 },
  'codex-hold-151': { file: 'codex-probe.mjs', args: ['hold-151'], seconds: 420 },
  'codex-hold-171': { file: 'codex-probe.mjs', args: ['hold-171'], seconds: 420 },
  'codex-hold-control': { file: 'codex-probe.mjs', args: ['hold-control'], seconds: 180 },
  'codex-resume': { file: 'codex-probe.mjs', args: ['resume'], seconds: 420 },
  'claude-solo': { file: 'claude-probe.mjs', args: ['solo'], seconds: 300 },
  'claude-solo-no-await': { file: 'claude-probe.mjs', args: ['solo-no-await'], seconds: 300 },
  'claude-batch': { file: 'claude-probe.mjs', args: ['batch'], seconds: 300 },
  'claude-batch-reversed': { file: 'claude-probe.mjs', args: ['batch-reversed'], seconds: 300 },
  'claude-batch-preallowed': { file: 'claude-probe.mjs', args: ['batch-preallowed'], seconds: 300 },
  'claude-batch-deny-sibling': { file: 'claude-probe.mjs', args: ['batch-deny-sibling'], seconds: 300 },
  'claude-batch-both-gated': { file: 'claude-probe.mjs', args: ['batch-both-gated'], seconds: 300 },
  'claude-batch-both-gated-preallowed': { file: 'claude-probe.mjs', args: ['batch-both-gated-preallowed'], seconds: 300 },
  // The Pi worker runs as PID 1 with no `timeout` parent: the profile refuses to start a process, and its "only this
  // process" rules name PID 1.
  'pi-launcher': { file: 'pi-probe.mjs', args: ['launcher'], seconds: 120, seccomp: 'launcher', direct: true },
  'pi-launcher-locks': { file: 'pi-probe.mjs', args: ['launcher-locks'], seconds: 120, seccomp: 'launcher-locks', direct: true },
  'pi-unconfined': { file: 'pi-probe.mjs', args: ['unconfined'], seconds: 120, direct: true },
  facts: { file: 'facts-probe.mjs', args: [], seconds: 120 },
};
const [volume, ...rest] = process.argv.slice(2);
if (!volume) throw new Error('Usage: node spikes/host-tools/run.mjs <node_modules volume> [--label <label>] [probe ...]');
const label = rest[0] === '--label' ? rest[1] : null;
const selected = label ? rest.slice(2) : rest;
const names = selected.length ? selected : Object.keys(PROBES);
for (const name of names) if (!PROBES[name]) throw new Error(`Unknown probe ${name}`);

const run = (args, seconds, container) => new Promise((resolveRun) => {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    if (container) spawn('docker', ['rm', '-f', container], { stdio: 'ignore' });
  }, (seconds + 60) * 1000);
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    resolveRun({ code, signal, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
  });
});
const shown = (args) => args.map((arg) => arg.replaceAll(repo, '<repo>'));

const dockerVersion = (await run(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'], 30)).stdout.trim();

// Switchboard's own Codex transport, compiled from this checkout's sources inside a container.
mkdirSync(work, { recursive: true });
const dist = mkdtempSync(join(work, 'dist-'));
if (names.some((name) => PROBES[name].file === 'codex-probe.mjs')) {
  const build = ['run', '--rm', '--name', `sb-host-tools-build-${randomUUID()}`, '--network', 'none',
    '--mount', `type=bind,source=${repo},target=/work,readonly`, '--mount', `type=volume,source=${volume},target=/work/node_modules,readonly`,
    '--mount', `type=bind,source=${dist},target=/out`, pins.image, 'sh', '-c',
    'node /work/node_modules/typescript/bin/tsc -p /work/tsconfig.json --outDir /out && printf \'{"type":"module"}\' > /out/package.json'];
  const built = await run(build, 120);
  if (built.code !== 0) throw new Error(`Build failed: ${built.stderr}${built.stdout}`);
}

mkdirSync(join(here, 'results'), { recursive: true });
await Promise.all(names.map(async (name) => {
  const probe = PROBES[name];
  const container = `sb-host-tools-${name}-${randomUUID().slice(0, 8)}`;
  const profile = probe.seccomp ? seccompProfile(probe.seccomp, process.arch) : null;
  const profilePath = join(work, `seccomp-${name}.json`);
  if (profile) writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const args = ['run', '--rm', '--name', container, '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,size=256m', '--tmpfs', '/home/probe:rw,size=512m', '--pids-limit', '512', '--memory', '3g',
    '--security-opt', 'no-new-privileges', ...(profile ? ['--security-opt', `seccomp=${profilePath}`] : []),
    '-e', 'HOME=/home/probe', '-w', '/home/probe',
    '--mount', `type=bind,source=${here},target=/probe,readonly`,
    '--mount', `type=volume,source=${volume},target=/node_modules,readonly`,
    '--mount', `type=bind,source=${dist},target=/dist,readonly`,
    // The image's entrypoint script starts a subshell, so a direct probe replaces it with node itself.
    ...(probe.direct ? ['--entrypoint', 'node', pins.image] : [pins.image, 'timeout', String(probe.seconds), 'node']), `/probe/${probe.file}`, ...probe.args];
  const startedAt = new Date().toISOString();
  const result = await run(args, probe.seconds, container);
  let report = null;
  try { report = JSON.parse(result.stdout); } catch {}
  const saved = { probe: name, ...(label && { label, volume }), image: pins.image, command: ['docker', ...shown(args)], startedAt, finishedAt: new Date().toISOString(),
    docker: dockerVersion, ...(profile && { seccompProfile: profile }),
    exit: { code: result.code, signal: result.signal }, stderrTail: result.stderr.slice(-4096),
    ...(report ? { report } : { stdoutTail: result.stdout.slice(-8192) }) };
  writeFileSync(join(here, 'results', `${name}${label ? `--${label}` : ''}.json`), `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`${name}: exit ${result.code}${report ? '' : ' (no report)'}`);
}));
rmSync(dist, { recursive: true, force: true });
