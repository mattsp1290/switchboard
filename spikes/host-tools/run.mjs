import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seccompProfile } from './pi-seccomp.mjs';

// Host side of the host-tool probes (P0 of the Switchboard adapter migration). Each probe runs in its own fresh Linux
// container with no network but loopback, a read-only root, an empty home on tmpfs and no provider variable. The
// pinned packages come from a named volume.
// Usage:
//   node spikes/host-tools/run.mjs --install <volume> [package@version ...]
//     creates the volume and fills it in the pinned image: with no packages, `npm ci --ignore-scripts` from this
//     repository's lockfile; with packages, `npm install --ignore-scripts` of exactly those (used for an older SDK).
//   node spikes/host-tools/run.mjs <volume> [--label <label>] [probe ...]
//     runs the probes; a label is added to each result file name, for a volume filled with other packages.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const work = join(here, '.work');
const pins = JSON.parse(readFileSync(join(repo, 'spikes/codex-native/pins.json'), 'utf8'));
const PROBES = {
  'codex-hold-121': { file: 'codex-probe.mjs', args: ['hold-121'], seconds: 420 },
  'codex-hold-151': { file: 'codex-probe.mjs', args: ['hold-151'], seconds: 420 },
  'codex-hold-171': { file: 'codex-probe.mjs', args: ['hold-171'], seconds: 420 },
  'codex-hold-171-resumed-namespace': { file: 'codex-probe.mjs', args: ['hold-171-resumed-namespace'], seconds: 420 },
  'codex-hold-control': { file: 'codex-probe.mjs', args: ['hold-control'], seconds: 180 },
  'codex-resume': { file: 'codex-probe.mjs', args: ['resume'], seconds: 420 },
  'codex-resume-namespace': { file: 'codex-probe.mjs', args: ['resume-namespace'], seconds: 420 },
  'codex-resume-fresh-index': { file: 'codex-probe.mjs', args: ['resume-fresh-index'], seconds: 420 },
  'claude-solo': { file: 'claude-probe.mjs', args: ['solo'], seconds: 300 },
  'claude-solo-no-await': { file: 'claude-probe.mjs', args: ['solo-no-await'], seconds: 300 },
  'claude-batch': { file: 'claude-probe.mjs', args: ['batch'], seconds: 300 },
  'claude-batch-reversed': { file: 'claude-probe.mjs', args: ['batch-reversed'], seconds: 300 },
  'claude-batch-preallowed': { file: 'claude-probe.mjs', args: ['batch-preallowed'], seconds: 300 },
  'claude-batch-deny-sibling': { file: 'claude-probe.mjs', args: ['batch-deny-sibling'], seconds: 300 },
  'claude-batch-both-gated': { file: 'claude-probe.mjs', args: ['batch-both-gated'], seconds: 300 },
  'claude-batch-both-gated-reversed': { file: 'claude-probe.mjs', args: ['batch-both-gated-reversed'], seconds: 300 },
  'claude-batch-both-gated-preallowed': { file: 'claude-probe.mjs', args: ['batch-both-gated-preallowed'], seconds: 300 },
  // The Pi worker runs as PID 1 with no `timeout` parent: the profile refuses to start a process, and its "only this
  // process" rules name PID 1.
  'pi-launcher': { file: 'pi-probe.mjs', args: ['launcher'], seconds: 120, seccomp: 'launcher', direct: true },
  'pi-launcher-locks': { file: 'pi-probe.mjs', args: ['launcher-locks'], seconds: 120, seccomp: 'launcher-locks', direct: true },
  'pi-unconfined': { file: 'pi-probe.mjs', args: ['unconfined'], seconds: 120, direct: true },
  facts: { file: 'facts-probe.mjs', args: [], seconds: 120 },
};

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
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
mkdirSync(join(here, 'results'), { recursive: true });

const argv = process.argv.slice(2);
if (argv[0] === '--install') {
  const [, volume, ...packages] = argv;
  if (!volume) throw new Error('Usage: node spikes/host-tools/run.mjs --install <volume> [package@version ...]');
  const command = packages.length
    ? `mkdir -p /tmp/home /i && cd /i && npm init -y >/dev/null && npm install --ignore-scripts --no-audit --no-fund ${packages.join(' ')}`
    : 'mkdir -p /tmp/home && cd /work && npm ci --ignore-scripts --no-audit --no-fund';
  const args = ['run', '--rm', '--name', `sb-host-tools-install-${randomUUID().slice(0, 8)}`, '-e', 'HOME=/tmp/home',
    ...(packages.length ? ['--mount', `type=volume,source=${volume},target=/i/node_modules`]
      : ['--mount', `type=bind,source=${repo},target=/work,readonly`, '--mount', `type=volume,source=${volume},target=/work/node_modules`]),
    pins.image, 'sh', '-c', `${command} && npm --version`];
  execFileSync('docker', ['volume', 'create', volume]);
  const result = await run(args, 600);
  const saved = { volume, packages, image: pins.image, command: ['docker', ...shown(args)], at: new Date().toISOString(),
    exit: { code: result.code, signal: result.signal }, outputTail: (result.stdout + result.stderr).slice(-2048) };
  writeFileSync(join(here, 'results', `install-${packages.length ? 'packages' : 'lockfile'}.json`), `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`install ${volume}: exit ${result.code}`);
  process.exit(result.code ?? 1);
}

const volume = argv[0];
if (!volume) throw new Error('Usage: node spikes/host-tools/run.mjs <volume> [--label <label>] [probe ...]');
const at = argv.indexOf('--label');
const label = at > 0 ? argv[at + 1] : null;
const selected = argv.slice(1).filter((_, index) => at < 0 || (index + 1 !== at && index + 1 !== at + 1));
const names = selected.length ? selected : Object.keys(PROBES);
for (const name of names) if (!PROBES[name]) throw new Error(`Unknown probe ${name}`);

// What ran: the checkout and the exact probe and transport sources (by digest, since results are committed after the
// run), the packages in the volume as npm recorded them, and the Docker server.
const [serverVersion, serverArch] = (await run(['version', '--format', '{{.Server.Version}} {{.Server.Arch}}'], 30)).stdout.trim().split(' ');
const arch = { amd64: 'x64', arm64: 'arm64' }[serverArch] ?? serverArch;
const packageNames = ['@openai/codex', '@openai/codex-linux-arm64', '@openai/codex-linux-x64', '@openai/codex-sdk',
  '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-linux-arm64', '@anthropic-ai/claude-agent-sdk-linux-x64',
  '@modelcontextprotocol/sdk', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', 'typescript'];
const inventory = await run(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${volume},target=/node_modules,readonly`,
  pins.image, 'node', '-e', `const l=JSON.parse(require("fs").readFileSync("/node_modules/.package-lock.json","utf8")).packages;
    console.log(JSON.stringify({npm:require("child_process").execSync("npm --version").toString().trim(),
    packages:Object.fromEntries(${JSON.stringify(packageNames)}.filter((n)=>l["node_modules/"+n]).map((n)=>[n,
    {version:l["node_modules/"+n].version,integrity:l["node_modules/"+n].integrity}]))}))`], 60);
const provenance = {
  gitHead: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  probeSources: Object.fromEntries(readdirSync(here).filter((file) => file.endsWith('.mjs')).sort()
    .map((file) => [`spikes/host-tools/${file}`, sha256(join(here, file))])),
  transportSources: Object.fromEntries(['src/adapters/codex/transport.ts', 'src/adapters/codex/wire.ts', 'src/core/events.ts']
    .map((file) => [file, sha256(join(repo, file))])),
  docker: { server: serverVersion, arch: serverArch, os: (await run(['info', '--format', '{{.OperatingSystem}}'], 30)).stdout.trim() },
  runnerPlatform: `${process.platform}/${process.arch}`,
  volume: { name: volume, ...JSON.parse(inventory.stdout || '{}') },
};

mkdirSync(work, { recursive: true });
const dist = mkdtempSync(join(work, 'dist-'));
try {
  // Switchboard's own Codex transport, compiled from this checkout's sources inside a container.
  if (names.some((name) => PROBES[name].file === 'codex-probe.mjs')) {
    const build = ['run', '--rm', '--name', `sb-host-tools-build-${randomUUID()}`, '--network', 'none',
      '--mount', `type=bind,source=${repo},target=/work,readonly`, '--mount', `type=volume,source=${volume},target=/work/node_modules,readonly`,
      '--mount', `type=bind,source=${dist},target=/out`, pins.image, 'sh', '-c',
      'node /work/node_modules/typescript/bin/tsc -p /work/tsconfig.json --outDir /out && printf \'{"type":"module"}\' > /out/package.json'];
    const built = await run(build, 120);
    if (built.code !== 0) throw new Error(`Build failed: ${built.stderr}${built.stdout}`);
  }
  await Promise.all(names.map(async (name) => {
    const probe = PROBES[name];
    const container = `sb-host-tools-${name}-${randomUUID().slice(0, 8)}`;
    const profile = probe.seccomp ? seccompProfile(probe.seccomp, arch) : null;
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
      ...(probe.direct ? ['--entrypoint', 'node', pins.image] : [pins.image, 'timeout', String(probe.seconds), 'node']),
      `/probe/${probe.file}`, ...probe.args];
    const startedAt = new Date().toISOString();
    const result = await run(args, probe.seconds, container);
    let report = null;
    try { report = JSON.parse(result.stdout); } catch {}
    const saved = { probe: name, ...(label && { label }), image: pins.image, command: ['docker', ...shown(args)], startedAt,
      finishedAt: new Date().toISOString(), provenance, ...(profile && { seccompProfile: profile }),
      exit: { code: result.code, signal: result.signal }, stderrTail: result.stderr.slice(-4096),
      ...(report ? { report } : { stdoutTail: result.stdout.slice(-8192) }) };
    writeFileSync(join(here, 'results', `${name}${label ? `--${label}` : ''}.json`), `${JSON.stringify(saved, null, 2)}\n`);
    console.log(`${name}: exit ${result.code}${report ? '' : ' (no report)'}`);
  }));
} finally {
  rmSync(dist, { recursive: true, force: true });
}
