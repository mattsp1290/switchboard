// Opt-in live proof: one real turn per selected engine, AG-UI events checked in process, spans checked in the
// operator's lotel. Not part of `npm test` or CI. With no gate set it prints one line and imports nothing.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkAguiRun, checkBaselineDiagnostics, checkEngineEvidence, checkLotelSpans, lastTerminal } from './live-baseline-check.mjs';
import {
  codexHostArgs, dryRunRequested, formatReason, hostVariables, nativeRecordMissing, resolveModel, selectEngines, takeCredentials,
} from './live-baseline-engines.mjs';

const OPENCODE_DENIED_TOOLS = ['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'external_directory', 'todowrite', 'question',
  'webfetch', 'websearch', 'lsp', 'skill'];
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const PROMPT = 'Reply with the single word pong.';
const SERVICE = 'switchboard-live-baseline';
const TURN_MS = 180_000;
const POLL_MS = 30_000;
const bounds = { maxEntities: 1024, maxPayloadBytes: 1_048_576, maxJsonDepth: 32, maxJsonNodes: 65_536 };
const reportPath = process.env.SWITCHBOARD_LIVE_BASELINE_REPORT || join(root, '.audit/live-baseline.json');

class LiveFailure extends Error {
  constructor(code, reason, detail) {
    super(code);
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const ignore = () => {};
/** Waits for `promise` (its rejection ignored) for at most `ms`, so a hung cleanup never hangs the run. */
const bounded = (promise, ms = 15_000) => Promise.race([Promise.resolve(promise).catch(ignore), delay(ms)]);
const scrub = (text) => String(text).split(homedir()).join('~');

// Gates read the environment first. Then every credential is captured and removed so no child process or adapter
// inherits it.
const selected = selectEngines(process.env);
const dryRun = dryRunRequested(process.env);
const models = new Map(selected.map((engine) => [engine.name, resolveModel(engine, process.env)]));
const credentials = takeCredentials(process.env);
const secrets = () => Object.values(credentials);
const reasonOf = (text) => formatReason(text, secrets(), homedir());
/** Text runtimes that share one `start` / `finished` / `abort` / `close` shape, keyed by engine name. */
const textRuntimes = {
  async claude({ cwd, sessionDirectory, model }) {
    const { createClaudeRuntime } = await import('@mattsp1290/switchboard/claude');
    return createClaudeRuntime({ cwd, sessionDirectory, apiKey: credentials.SWITCHBOARD_ANTHROPIC_API_KEY, model });
  },
  async codex({ cwd, model }) {
    const { createCodexRuntime } = await import('@mattsp1290/switchboard/codex');
    return createCodexRuntime({ cwd, model });
  },
  async cursor({ cwd, sessionDirectory, model }) {
    const { createCursorRuntime } = await import('@mattsp1290/switchboard/cursor');
    return createCursorRuntime({ cwd, sessionDirectory, apiKey: credentials.SWITCHBOARD_CURSOR_API_KEY, model });
  },
};

/** Host engines' adapter open, keyed by engine name. `hostTurn` owns launch, run, result classification, and cleanup. */
const hostOpeners = {
  async 'host/opencode'({ model, cwd, scratch, executableFile, launchWith, signal }) {
    const { opencodeHostAdapter } = await import('@mattsp1290/switchboard/host/opencode');
    // The child environment is exactly `variables`. OpenCode reads its provider credential from OPENCODE_AUTH_CONTENT.
    // A private XDG_CONFIG_HOME keeps the operator's OpenCode config (plugins, MCP servers, providers) out of the run,
    // so nothing it would start inherits the key. Data and cache stay shared: a fresh data or cache directory makes
    // OpenCode reject the session.
    const configHome = join(scratch, 'opencode-config');
    // The private config denies every tool permission key the installed OpenCode (1.18.29) config schema declares, except
    // doom_loop (a loop guard, not a tool), so a model tool call cannot read, write, search, or reach out from the host.
    await mkdir(join(configHome, 'opencode'), { recursive: true });
    await writeFile(join(configHome, 'opencode', 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
      permission: Object.fromEntries(OPENCODE_DENIED_TOOLS.map((tool) => [tool, 'deny'])) }));
    const variables = hostVariables('host/opencode', { path: process.env.PATH ?? '', home: homedir(), opencodeConfigHome: configHome,
      opencodeKey: credentials.SWITCHBOARD_OPENCODE_API_KEY });
    return opencodeHostAdapter.open({ model, launch: launchWith([]), environment: { variables,
      nativeConfig: { cwd, executable: executableFile, account: 'live' } } }, signal);
  },
  async 'host/codex'({ model, cwd, scratch, executableFile, launchWith, signal }) {
    const { codexHostAdapter } = await import('@mattsp1290/switchboard/host/codex');
    const codexPrivate = { sqliteHome: join(scratch, 'codex-sqlite'), logDir: join(scratch, 'codex-logs') };
    for (const directory of Object.values(codexPrivate)) await mkdir(directory, { recursive: true });
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    const variables = hostVariables('host/codex', { path: process.env.PATH ?? '', home: homedir(), codexHome });
    return codexHostAdapter.open({ launch: launchWith(codexHostArgs(model, codexPrivate)), environment: { variables,
      nativeConfig: { home: codexHome, cwd, sandbox: 'read-only',
        executable: executableFile } } }, signal);
  },
  async 'host/pi'({ model, scratch, signal }) {
    const { piHostAdapter } = await import('@mattsp1290/switchboard/host/pi');
    const stream = await piHostStream(model);
    const temp = join(scratch, 'tmp');
    await mkdir(temp, { recursive: true });
    return piHostAdapter.open({ launch: { kind: 'in-process' }, subagents: 'off', stream,
      environment: { variables: hostVariables('host/pi', { path: process.env.PATH ?? '', tmpdir: temp }), nativeConfig: {} } }, signal);
  },
};

// Function declarations are hoisted, so these dispatch tables can sit before the functions they name.
const turns = { text: textTurn, pi: piTurn, host: hostTurn };
const registries = { text: textRuntimes, host: hostOpeners };

/** The engine's runtime when this script can run it. */
function dispatchOf(engine) {
  const registry = registries[engine.runtime];
  if (turns[engine.runtime] === undefined || (registry !== undefined && typeof registry[engine.name] !== 'function')) {
    throw new LiveFailure('runtime-missing');
  }
  return engine.runtime;
}

/** The checks a run makes before lotel, build, or any adapter import. Throws LiveFailure; returns the host executable (null for none). */
function preflight(engine) {
  if (engine.credential !== undefined && !credentials[engine.credential]) throw new LiveFailure('credential-required');
  const executableFile = hostExecutable(engine);
  if (executableFile === undefined) throw new LiveFailure('executable-required');
  dispatchOf(engine);
  return executableFile;
}

/** The only executable resolver: an absolute, executable host binary from its variable or PATH, or undefined. Engines without `executable` need none (null). */
function hostExecutable({ executable: spec }) {
  if (spec === undefined) return null;
  const value = process.env[spec.variable];
  if (value !== undefined || spec.command === undefined) {
    return typeof value === 'string' && isAbsolute(value) && executable(value) ? value : undefined;
  }
  return onPath(spec.command);
}

/** Prints the resolved plan per engine. No lotel, build, adapter import, model call, or report. */
function dryRunPlan() {
  let failed = false;
  const fail = (engine, code) => {
    failed = true;
    process.stdout.write(`FAIL ${engine.name} ${code}\n`);
  };
  for (const engine of selected) {
    try {
      preflight(engine);
    } catch (error) {
      fail(engine, error instanceof LiveFailure ? error.code : 'engine-error');
      continue;
    }
    const credential = engine.credential === undefined ? 'not-needed' : 'present';
    process.stdout.write(`DRY ${engine.name} model=${models.get(engine.name)} runtime=${engine.runtime} credential=${credential}`
      + ` confirmation=${engine.confirmation}\n`);
  }
  process.stdout.write('', () => process.exit(failed ? 1 : 0));
}

async function main() {
  const results = [];
  let lotel;
  let build;
  for (const engine of selected) {
    const model = models.get(engine.name);
    const result = { engine: engine.name, model, confirmation: engine.confirmation, pass: false, outcome: null, spans: null, lotel: null };
    results.push(result);
    try {
      const executableFile = preflight(engine);
      lotel ??= await resolveLotel();
      result.lotel = lotel.identity;
      if (lotel.failure) throw new LiveFailure(lotel.failure);
      build ??= runBuild();
      if (build !== 'ok') throw new LiveFailure('build-failed');
      const { nativeSession, ...evidence } = await runEngine(engine, model, lotel.binary, executableFile);
      Object.assign(result, evidence);
      if (nativeRecordMissing(engine, nativeSession)) throw new LiveFailure('native-record-missing');
      if (engine.confirmation === 'native-record') result.nativeSession = scrub(nativeSession);
      result.pass = true;
    } catch (error) {
      result.code = error instanceof LiveFailure ? error.code : 'engine-error';
      if (error instanceof LiveFailure && error.detail !== undefined) Object.assign(result, error.detail);
      const reason = error instanceof LiveFailure ? error.reason
        : error instanceof Error ? `${error.name}: ${error.message}` : undefined;
      if (reason !== undefined) result.reason = reasonOf(reason);
    }
    process.stdout.write(result.pass ? `PASS ${engine.name}\n`
      : `FAIL ${engine.name} ${result.code}${result.reason ? ` — ${result.reason}` : ''}\n`);
  }
  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ engines: results }, null, 2)}\n`);
  } catch {
    process.stdout.write('live-baseline: report not written\n');
  }
  const failed = results.some((result) => !result.pass);
  process.stdout.write('', () => process.exit(failed ? 1 : 0));
}

function runBuild() {
  const built = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore', env: process.env });
  return built.status === 0 ? 'ok' : 'failed';
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable `command` on PATH, or undefined. */
function onPath(command) {
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command)).find(executable);
}

async function capture(file, args, options = {}) {
  try {
    const { stdout } = await exec(file, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, ...options });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function resolveLotel() {
  const source = process.env.LOTEL_SOURCE || join(homedir(), 'git/lotel');
  const fromPath = onPath('lotel');
  const built = [join(source, 'lotel'), join(source, 'bin/lotel')].find(executable);
  const binary = fromPath ?? built;
  if (binary === undefined) return { failure: 'lotel-unavailable', identity: { binary: 'unavailable' } };
  const identity = {};
  const info = await capture('go', ['version', '-m', binary]);
  if (info !== undefined) {
    identity.buildInfo = {
      go: scrub(info.split('\n')[0].split(': ').at(-1)),
      revision: /vcs\.revision=(\S+)/u.exec(info)?.[1] ?? null,
      modified: /vcs\.modified=(\S+)/u.exec(info)?.[1] ?? null,
    };
  } else {
    // Different facts: the binary's own version and the checkout's commit are not claimed to be one build.
    identity.version = scrub((await capture(binary, ['--version'])) ?? 'unknown').split('\n')[0];
    identity.checkoutCommit = (await capture('git', ['-C', source, 'rev-parse', 'HEAD'])) ?? null;
  }
  const healthy = (await capture(binary, ['health'], { timeout: 30_000 })) !== undefined;
  return { binary, identity, ...(healthy ? {} : { failure: 'lotel-unhealthy' }) };
}

async function lotelJson(binary, args) {
  const out = await capture(binary, args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (out === undefined) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

async function pollSpans(binary, runId, observations) {
  const deadline = Date.now() + POLL_MS;
  let last = { ok: false, code: 'lotel-spans-missing' };
  for (;;) {
    await capture(binary, ['ingest'], { timeout: 30_000 });
    const base = ['query', 'traces', '--service', SERVICE, '--limit', '1000'];
    let spans = await lotelJson(binary, [...base, '--attr', `switchboard.run_id=${runId}`]);
    const filtered = (list) => (Array.isArray(list) ? list.filter((span) => span?.attributes?.['switchboard.run_id'] === runId) : []);
    if (spans === undefined) spans = await lotelJson(binary, base);
    const own = filtered(spans);
    if (own.length > 0) {
      last = checkLotelSpans({ spans: own, runId, observations });
      if (last.ok) return last;
    }
    if (Date.now() >= deadline) return last;
    await delay(1000);
  }
}

async function runEngine(engine, model, lotelBinary, executableFile) {
  const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
  const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { ROOT_CONTEXT } = await import('@opentelemetry/api');
  const { instrumentationScope } = await import('@mattsp1290/switchboard/observability');
  const { createRunBaseline } = await import('@mattsp1290/switchboard/baseline');
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://127.0.0.1:4318/v1/traces', timeoutMillis: 5000 }))],
  });
  const runId = `live-${randomBytes(8).toString('hex')}`;
  const created = createRunBaseline({
    projection: { threadId: `thread-${runId}`, runId, sourceKey: engine.provider, bounds },
    tracer: provider.getTracer(instrumentationScope.name, instrumentationScope.version),
    parentContext: ROOT_CONTEXT, contentPolicy: { kind: 'none' }, allowedToolNames: [], admitObservedToolNames: true,
    provider: engine.provider,
  });
  if (created.kind !== 'ok') {
    await provider.shutdown();
    throw new LiveFailure('baseline-create');
  }
  const baseline = created.value;
  const batches = [];
  const observations = [];
  const diagnosticCodes = [];
  const onObservation = (observation) => {
    observations.push(observation);
    const accepted = baseline.accept(observation);
    batches.push(accepted.projection);
    for (const diagnostic of accepted.diagnostics ?? []) diagnosticCodes.push(diagnostic.code);
    if (accepted.observer?.code !== undefined) diagnosticCodes.push(accepted.observer.code);
  };
  const scratch = await mkdtemp(join(tmpdir(), 'live-baseline-'));
  let report;
  let flushed = true;
  let nativeSession;
  try {
    ({ nativeSession } = await turn(engine, model, scratch, onObservation, executableFile));
  } finally {
    // A throwing turn still closes the baseline (ending its agent span) and stops the batch processor.
    report = baseline.close();
    try {
      await provider.forceFlush();
      await provider.shutdown();
    } catch {
      flushed = false;
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  if (!flushed) throw new LiveFailure('flush-failed', 'the tracer provider did not flush or shut down');
  const aguiCheck = checkAguiRun({ batches, observations, report });
  const outcome = lastTerminal(observations)?.outcome ?? null;
  const detail = { outcome };
  if (!aguiCheck.ok) throw new LiveFailure(aguiCheck.code, undefined, detail);
  const diagnostics = checkBaselineDiagnostics(diagnosticCodes);
  if (!diagnostics.ok) throw new LiveFailure('baseline-diagnostic', diagnostics.code, { ...detail, diagnostics: [...new Set(diagnosticCodes)] });
  // A failed or unknown terminal still produces a consistent AG-UI run and agent span; only a success proves a live turn.
  if (outcome !== 'success') throw new LiveFailure('outcome-not-success', undefined, detail);
  const spans = await pollSpans(lotelBinary, runId, observations);
  const spanDetail = { ...detail, spans: spans.counts ?? null };
  if (!spans.ok) throw new LiveFailure(spans.code, undefined, spanDetail);
  const evidence = checkEngineEvidence(engine, spans.counts);
  if (!evidence.ok) throw new LiveFailure(evidence.code, undefined, spanDetail);
  return { outcome, spans: spans.counts, ...(nativeSession === undefined ? {} : { nativeSession }) };
}

async function within(promise, abort, until = Date.now() + TURN_MS) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new LiveFailure('turn-timeout')); }, Math.max(0, until - Date.now()));
  });
  try {
    return await Promise.race([promise, limit]);
  } catch (error) {
    await abort?.().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function turn(engine, model, scratch, onObservation, executableFile) {
  const cwd = join(scratch, 'work');
  const sessionDirectory = join(scratch, 'session');
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  return turns[engine.runtime]({ engine, model, scratch, cwd, sessionDirectory, onObservation, executableFile });
}

async function textTurn({ engine, model, cwd, sessionDirectory, onObservation }) {
  const runtime = await textRuntimes[engine.name]({ cwd, sessionDirectory, model });
  const until = Date.now() + TURN_MS;
  try {
    const started = await within(runtime.start({ text: PROMPT, onEvent: ignore, onObservation }), undefined, until);
    await within(started.finished, () => started.abort(), until);
    return { nativeSession: started.threadId }; // main keeps it only for confirmation === 'native-record'
  } finally {
    await bounded(runtime.close());
  }
}

async function piTurn({ model, cwd, sessionDirectory, onObservation }) {
  const { createPiRuntime } = await import('@mattsp1290/switchboard/pi');
  const runtime = await createPiRuntime({ cwd, sessionDirectory, apiKey: credentials.SWITCHBOARD_OPENCODE_API_KEY, provider: 'opencode-go', model });
  try {
    const session = await runtime.open();
    try {
      const until = Date.now() + TURN_MS;
      const prompt = await within(session.prompt(PROMPT, ignore, onObservation), () => session.abort(), until);
      await within(prompt.finished, () => session.abort(), until);
    } finally {
      await bounded(session.close());
    }
  } finally {
    await bounded(runtime.close());
  }
  return {};
}

/** Wraps one host-owned child as the channel both host adapters accept. The host kills it when the turn ends. */
function spawnChannel(request, extraArgs = []) {
  const child = spawn(request.executable, [...request.args.slice(1), ...extraArgs], {
    cwd: request.cwd, env: { ...request.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const processExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 || code === null ? resolve(code) : reject(new Error('exit'))));
  });
  processExit.catch(() => {});
  child.stdin.on('error', () => {});
  const channel = {
    listen(sink) {
      const callable = typeof sink === 'function';
      const onData = (chunk) => (callable ? sink(chunk) : sink.data(chunk));
      const onDiagnostic = (chunk) => { if (!callable) sink.diagnostic(chunk); };
      const onEnd = () => (callable ? sink.ended() : sink.ended('eof'));
      child.stdout.on('data', onData);
      child.stderr.on('data', onDiagnostic);
      child.stdout.once('end', onEnd);
      return () => {
        child.stdout.off('data', onData);
        child.stderr.off('data', onDiagnostic);
        child.stdout.off('end', onEnd);
      };
    },
    write: (frame) => new Promise((resolve, reject) => {
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    }),
    endInput: () => { child.stdin.end(); },
  };
  return { channel, processExit, stop: () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    // A child that ignores SIGTERM is killed after 2 s; the timer never keeps the script alive.
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref();
  } };
}

async function hostTurn({ engine, model, cwd, scratch, onObservation, executableFile }) {
  const signal = AbortSignal.timeout(TURN_MS);
  const stops = [];
  const launchWith = (extraArgs) => ({ kind: 'spawn', spawn: (request) => {
    const spawned = spawnChannel(request, extraArgs);
    stops.push(spawned.stop);
    return spawned;
  } });
  let adapter;
  try {
    const opened = await hostOpeners[engine.name]({ model, cwd, scratch, executableFile, launchWith, signal });
    if (opened.kind !== 'ok') throw new LiveFailure('host-open-failed', `${opened.error.code}: ${opened.error.message}`);
    adapter = opened.value;
    const result = await within(adapter.run({ prompt: PROMPT, hostOperationId: `live-${randomBytes(4).toString('hex')}`,
      recordIntent() {}, signal, onObservation }), undefined);
    if (result.kind === 'failed' && signal.aborted) throw new LiveFailure('turn-timeout');
    if (result.kind === 'failed') throw new LiveFailure('segment-failed', `${result.error.code}: ${result.error.message}`);
    // The prompt asks for text only, so a pending tool call means the turn did not finish.
    if (result.kind === 'pending') throw new LiveFailure('segment-pending', 'the segment ended with pending host tool calls');
    return { nativeSession: result.session?.opaque }; // main keeps it only for confirmation === 'native-record'
  } finally {
    await bounded(adapter?.close());
    for (const stop of stops) stop();
  }
}

/** The host stream for `./host/pi`: the captured key reaches the provider here and nowhere else. */
async function piHostStream(model) {
  const { InMemoryCredentialStore, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const store = new InMemoryCredentialStore();
  await store.modify('opencode-go', async () => ({ type: 'api_key', key: credentials.SWITCHBOARD_OPENCODE_API_KEY }));
  const models = await ModelRuntime.create({
    credentials: store, modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const native = models.getModel('opencode-go', model);
  if (native === undefined) throw new LiveFailure('model-unknown');
  // OpenCode Go rejects a request without x-opencode-session; pi-ai sends that header only for options.sessionId.
  const sessionId = `live-baseline-${randomBytes(6).toString('hex')}`;
  return async function* stream(request) {
    if (request.turns.some((item) => item.role !== 'user')) throw new Error('live stream supports a single user turn only');
    const messages = request.turns.filter((item) => item.role === 'user')
      .map((item) => ({ role: 'user', content: item.text, timestamp: Date.now() }));
    const message = await models.completeSimple(native, { systemPrompt: request.instructions, messages }, { signal: request.signal, sessionId });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error('model failed');
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    if (text !== '') yield { kind: 'text', text };
    const { input, output } = message.usage ?? {};
    if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) yield { kind: 'usage', input, output };
  };
}

// Entry point last, so every top-level binding above is initialized before main or the dry run reads it.
if (selected.length === 0) {
  process.stdout.write('live-baseline: no engine selected\n');
} else if (dryRun) {
  dryRunPlan();
} else {
  await main();
}
