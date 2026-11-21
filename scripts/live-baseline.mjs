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
import { checkAguiRun, checkEngineEvidence, checkLotelSpans } from './live-baseline-check.mjs';
import {
  codexHostArgs, dryRunRequested, formatReason, opencodeAuthContent, resolveModel, selectEngines, takeCredentials,
} from './live-baseline-engines.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const PROMPT = 'Reply with the single word pong.';
const SERVICE = 'switchboard-live-baseline';
const TURN_MS = 180_000;
const POLL_MS = 30_000;
const bounds = { maxEntities: 1024, maxPayloadBytes: 1_048_576, maxJsonDepth: 32, maxJsonNodes: 65_536 };
const reportPath = process.env.SWITCHBOARD_LIVE_BASELINE_REPORT || join(root, '.audit/live-baseline.json');

class LiveFailure extends Error {
  constructor(code, reason) {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
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

/** Which dispatch an engine uses; reading `textRuntimes` here lets the dry run prove the table is initialized. */
function dispatchOf(engine) {
  if (engine.runtime === 'text' && typeof textRuntimes[engine.name] !== 'function') throw new LiveFailure('runtime-missing');
  return engine.runtime;
}

if (selected.length === 0) {
  process.stdout.write('live-baseline: no engine selected\n');
} else if (dryRun) {
  dryRunPlan();
} else {
  await main();
}

/** The only executable resolver: an absolute, executable host binary from its variable or PATH, or undefined. Text engines need none (null). */
function hostExecutable(engine) {
  const usable = (path) => (typeof path === 'string' && isAbsolute(path) && executable(path) ? path : undefined);
  if (engine.name === 'host/codex') return usable(process.env.CODEX_BIN);
  if (engine.name !== 'host/opencode') return null;
  if (process.env.OPENCODE_BIN !== undefined) return usable(process.env.OPENCODE_BIN);
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'opencode')).find(executable);
}

/** Prints the resolved plan per engine. No lotel, build, adapter import, model call, or report. */
function dryRunPlan() {
  let failed = false;
  const fail = (engine, code) => {
    failed = true;
    process.stdout.write(`FAIL ${engine.name} ${code}\n`);
  };
  for (const engine of selected) {
    const credential = engine.credential === undefined ? 'not-needed' : credentials[engine.credential] ? 'present' : 'missing';
    if (credential === 'missing') {
      fail(engine, 'credential-required');
      continue;
    }
    if (hostExecutable(engine) === undefined) {
      fail(engine, 'executable-required');
      continue;
    }
    let runtime;
    try {
      runtime = dispatchOf(engine);
    } catch (error) {
      fail(engine, error instanceof LiveFailure ? error.code : 'engine-error');
      continue;
    }
    process.stdout.write(`DRY ${engine.name} model=${models.get(engine.name)} runtime=${runtime} credential=${credential}`
      + ` confirmation=${engine.confirmation}\n`);
  }
  process.stdout.write('', () => process.exit(failed ? 1 : 0));
}

async function main() {
  const results = [];
  const lotel = { value: undefined };
  const build = { value: undefined };
  for (const engine of selected) {
    const model = models.get(engine.name);
    const result = { engine: engine.name, model, confirmation: engine.confirmation, pass: false, outcome: null, spans: null, lotel: null };
    results.push(result);
    try {
      if (engine.credential !== undefined && !credentials[engine.credential]) throw new LiveFailure('credential-required');
      const executableFile = hostExecutable(engine);
      if (executableFile === undefined) throw new LiveFailure('executable-required');
      dispatchOf(engine);
      lotel.value ??= await resolveLotel();
      result.lotel = lotel.value.identity;
      if (lotel.value.failure) throw new LiveFailure(lotel.value.failure);
      build.value ??= runBuild();
      if (build.value !== 'ok') throw new LiveFailure('build-failed');
      const { nativeSession, ...evidence } = await runEngine(engine, model, lotel.value.binary, executableFile);
      Object.assign(result, evidence);
      if (engine.confirmation === 'native-record' && nativeSession !== undefined) result.nativeSession = scrub(nativeSession);
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
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'lotel')).find(executable);
  const built = [join(source, 'lotel'), join(source, 'bin/lotel')].find(executable);
  const binary = onPath ?? built;
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
    if (filtered(spans).length === 0) spans = await lotelJson(binary, base);
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
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: 'http://127.0.0.1:4318/v1/traces', timeoutMillis: 5000 }))],
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
  const onObservation = (observation) => {
    observations.push(observation);
    batches.push(baseline.accept(observation).projection);
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
  const outcome = observations.findLast((item) => item.kind === 'terminal')?.outcome ?? null;
  const detail = { outcome };
  if (!aguiCheck.ok) throw Object.assign(new LiveFailure(aguiCheck.code), { detail });
  // A failed or unknown terminal still produces a consistent AG-UI run and agent span; only a success proves a live turn.
  if (outcome !== 'success') throw Object.assign(new LiveFailure('outcome-not-success'), { detail });
  const spans = await pollSpans(lotelBinary, runId, observations);
  if (!spans.ok) throw Object.assign(new LiveFailure(spans.code), { detail: { ...detail, spans: spans.counts ?? null } });
  const evidence = checkEngineEvidence(engine, spans.counts);
  if (!evidence.ok) throw Object.assign(new LiveFailure(evidence.code), { detail: { outcome, spans: spans.counts } });
  return { outcome, spans: spans.counts, ...(nativeSession === undefined ? {} : { nativeSession }) };
}

async function within(promise, abort) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new LiveFailure('turn-timeout')); }, TURN_MS);
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
  const ignore = () => {};
  const text = textRuntimes[engine.name];
  if (text) {
    const runtime = await text({ cwd, sessionDirectory, model });
    try {
      const started = await within(runtime.start({ text: PROMPT, onEvent: ignore, onObservation }), undefined);
      await within(started.finished, () => started.abort());
      return { nativeSession: engine.name === 'codex' ? started.threadId : undefined };
    } finally {
      await runtime.close();
    }
  }
  switch (engine.name) {
    case 'pi': {
      const { createPiRuntime } = await import('@mattsp1290/switchboard/pi');
      const runtime = await createPiRuntime({ cwd, sessionDirectory, apiKey: credentials.SWITCHBOARD_OPENCODE_API_KEY, provider: 'opencode-go', model });
      try {
        const session = await runtime.open();
        try {
          const prompt = await within(session.prompt(PROMPT, ignore, onObservation), () => session.abort());
          await within(prompt.finished, () => session.abort());
        } finally {
          await session.close();
        }
      } finally {
        await runtime.close();
      }
      return {};
    }
    default:
      return hostTurn(engine, model, cwd, scratch, onObservation, executableFile);
  }
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
  return { channel, processExit, stop: () => { if (child.exitCode === null) child.kill('SIGTERM'); } };
}

async function hostTurn(engine, model, cwd, scratch, onObservation, executableFile) {
  const signal = AbortSignal.timeout(TURN_MS);
  const stops = [];
  const codexPrivate = { sqliteHome: join(scratch, 'codex-sqlite'), logDir: join(scratch, 'codex-logs') };
  if (engine.name === 'host/codex') for (const directory of Object.values(codexPrivate)) await mkdir(directory, { recursive: true });
  const extraArgs = engine.name === 'host/codex' ? codexHostArgs(model, codexPrivate) : [];
  const launch = { kind: 'spawn', spawn: (request) => {
    const spawned = spawnChannel(request, extraArgs);
    stops.push(spawned.stop);
    return spawned;
  } };
  const variables = { PATH: process.env.PATH ?? '', HOME: homedir() };
  let adapter;
  try {
    let opened;
    if (engine.name === 'host/opencode') {
      const { opencodeHostAdapter } = await import('@mattsp1290/switchboard/host/opencode');
      // The child environment is exactly `variables`. OpenCode reads its provider credential from OPENCODE_AUTH_CONTENT.
      // A private XDG_CONFIG_HOME keeps the operator's OpenCode config (plugins, MCP servers, providers) out of the run,
      // so nothing it would start inherits the key. Data and cache stay shared: a fresh data or cache directory makes
      // OpenCode reject the session.
      const configHome = join(scratch, 'opencode-config');
      await mkdir(configHome, { recursive: true });
      const opencodeVariables = { ...variables, XDG_CONFIG_HOME: configHome,
        OPENCODE_AUTH_CONTENT: opencodeAuthContent(credentials.SWITCHBOARD_OPENCODE_API_KEY) };
      opened = await opencodeHostAdapter.open({ model, launch, environment: { variables: opencodeVariables,
        nativeConfig: { cwd, executable: executableFile, account: 'live' } } }, signal);
    } else if (engine.name === 'host/codex') {
      const { codexHostAdapter } = await import('@mattsp1290/switchboard/host/codex');
      opened = await codexHostAdapter.open({ launch, environment: { variables, nativeConfig: {
        home: process.env.CODEX_HOME || join(homedir(), '.codex'), cwd, sandbox: 'read-only',
        executable: executableFile } } }, signal);
    } else {
      const { piHostAdapter } = await import('@mattsp1290/switchboard/host/pi');
      const stream = await piHostStream(model);
      const temp = join(scratch, 'tmp');
      await mkdir(temp, { recursive: true });
      opened = await piHostAdapter.open({ launch: { kind: 'in-process' }, subagents: 'off', stream,
        environment: { variables: { PATH: variables.PATH, TMPDIR: temp }, nativeConfig: {} } }, signal);
    }
    if (opened.kind !== 'ok') throw new LiveFailure('host-open-failed', `${opened.error.code}: ${opened.error.message}`);
    adapter = opened.value;
    const result = await within(adapter.run({ prompt: PROMPT, hostOperationId: `live-${randomBytes(4).toString('hex')}`,
      recordIntent() {}, signal, onObservation }), undefined);
    if (result.kind === 'failed' && signal.aborted) throw new LiveFailure('turn-timeout');
    if (result.kind === 'failed') throw new LiveFailure('segment-failed', `${result.error.code}: ${result.error.message}`);
    // The prompt asks for text only, so a pending tool call means the turn did not finish.
    if (result.kind === 'pending') throw new LiveFailure('segment-pending', 'the segment ended with pending host tool calls');
    return { nativeSession: engine.name === 'host/codex' ? result.session?.opaque : undefined };
  } finally {
    await adapter?.close().catch(() => {});
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
