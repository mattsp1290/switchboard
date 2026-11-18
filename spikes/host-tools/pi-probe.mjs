import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Container side of probe A8. It runs as PID 1 under the seccomp profile run.mjs passes (pi-seccomp.mjs), first
// checks that the profile is in force, then loads the pinned Pi SDK and runs one turn whose model stream is a function
// the probe injects, as Crew's confined worker does (crew:src/service/pi-worker.ts). It also tries the SDK's
// file-backed settings and sessions. It records; it never asserts.
const [scenario] = process.argv.slice(2);
if (!['launcher', 'launcher-locks', 'unconfined'].includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
const HOME = '/home/probe';
const version = (name) => JSON.parse(readFileSync(`/node_modules/${name}/package.json`, 'utf8')).version;
const report = { scenario, pid: process.pid, node: process.version, arch: process.arch, environmentKeys: Object.keys(process.env).sort(),
  versions: { 'pi-coding-agent': version('@earendil-works/pi-coding-agent'), 'pi-ai': version('@earendil-works/pi-ai'),
    'pi-agent-core': version('@earendil-works/pi-agent-core') }, controls: {}, turns: {} };
const outcome = (fn) => { try { return { ok: true, value: fn() ?? null }; } catch (error) { return { ok: false, code: error.code ?? null, message: String(error.message).slice(0, 200) }; } };
const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`no result within ${ms} ms`), { code: 'PROBE_TIMEOUT' })), ms))]);

// Controls: each operation the profile should refuse, tried directly.
const scratch = mkdtempSync(join(HOME, 'controls-'));
const file = join(scratch, 'file');
writeFileSync(file, 'x');
report.controls.socket = await new Promise((resolve) => {
  try {
    const socket = connect({ host: '127.0.0.1', port: 9 });
    socket.once('error', (error) => resolve({ ok: false, code: error.code, syscall: error.syscall ?? null }));
    socket.once('connect', () => { socket.destroy(); resolve({ ok: true }); });
  } catch (error) { resolve({ ok: false, code: error.code ?? null, thrown: true }); }
});
report.controls.spawn = (() => { const result = spawnSync('/bin/true'); return result.error ? { ok: false, code: result.error.code } : { ok: true, status: result.status }; })();
report.controls.utimes = outcome(() => utimesSync(file, new Date(), new Date()));
report.controls.chmod = outcome(() => chmodSync(file, 0o600));
report.controls.sqliteWriteLock = outcome(() => {
  const db = new DatabaseSync(join(scratch, 'lock.sqlite'));
  try { db.exec('CREATE TABLE t (x); BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT;'); return 'committed'; } finally { db.close(); }
});
report.controls.signalOther = outcome(() => process.kill(2, 0));

let ai;
let agent;
try {
  ai = await import('@earendil-works/pi-ai');
  agent = await import('@earendil-works/pi-coding-agent');
  report.load = { ok: true };
} catch (error) {
  report.load = { ok: false, code: error.code ?? null, message: String(error.stack ?? error).slice(0, 1500) };
}

async function turn(kind) {
  const { createAssistantMessageEventStream, createProvider, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } = ai;
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = agent;
  const record = { kind, streamCalls: [] };
  const cwd = mkdtempSync(join(HOME, `${kind}-`));
  const model = fauxProvider({ api: 'host-probe' }).getModel();
  // The injected model: the SDK calls this function instead of opening any connection.
  const stream = (_model, context) => {
    const users = context.messages.filter((message) => message.role === 'user');
    record.streamCalls.push({ messages: context.messages.length, tools: (context.tools ?? []).map((tool) => tool.name) });
    const events = createAssistantMessageEventStream();
    const text = `pi answer to ${users.length} prompt(s)`;
    const message = fauxAssistantMessage(text, { responseId: randomUUID() });
    events.push({ type: 'start', partial: fauxAssistantMessage('') });
    events.push({ type: 'text_delta', contentIndex: 0, partial: message, delta: text });
    events.push({ type: 'done', reason: 'stop', message });
    return events;
  };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(createProvider({ id: model.provider, models: [model],
    auth: { apiKey: { name: 'probe host', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  const settingsManager = kind === 'in-memory'
    ? SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' })
    : SettingsManager.create(cwd, join(cwd, 'agent'));
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, 'agent'), settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noContextFiles: true, noThemes: true, systemPrompt: 'You are a probe.' });
  await resourceLoader.reload();
  const sessionManager = kind === 'in-memory' ? SessionManager.inMemory(cwd, { id: randomUUID() })
    : SessionManager.create(cwd, join(cwd, 'sessions'));
  const { session } = await createAgentSession({ model, modelRuntime, cwd, agentDir: join(cwd, 'agent'), resourceLoader, settingsManager,
    sessionManager, tools: [], customTools: [], thinkingLevel: 'off' });
  try {
    await session.prompt('hello from the probe host', { expandPromptTemplates: false });
    await session.waitForIdle();
    const messages = sessionManager.getEntries().flatMap((entry) => (entry.type === 'message' ? [entry.message] : []));
    const last = messages.at(-1);
    record.messages = messages.map((message) => message.role);
    record.last = { role: last?.role ?? null, stopReason: last?.stopReason ?? null,
      text: (last?.content ?? []).map?.((part) => part.text ?? '').join('') ?? null, errorMessage: last?.errorMessage ?? null };
  } finally {
    session.dispose();
  }
  // What the SDK wrote, to show whether a lock file or directory was ever created.
  record.files = readdirSync(cwd, { recursive: true }).map(String).sort();
  return record;
}

if (report.load.ok) {
  for (const kind of ['in-memory', 'file-backed']) {
    try { report.turns[kind] = { ok: true, ...(await within(turn(kind), 30_000)) }; }
    catch (error) { report.turns[kind] = { ok: false, code: error.code ?? null, message: String(error.stack ?? error).slice(0, 1500) }; }
  }
}
process.stdout.write(JSON.stringify(report), () => process.exit(0));
