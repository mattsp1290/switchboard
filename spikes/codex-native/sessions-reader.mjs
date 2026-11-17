import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { accountLogin } from './account-reads.mjs';
// The compiled product modules, mounted read-only from the host's fresh build.
import { codexSessionMethods, codexSessions } from '../dist/adapters/codex/sessions.js';
import { openCodexTransport } from '../dist/adapters/codex/transport.js';

// Container side of the pg51 native proof: one scenario per container against a borrowed app-server. It reports facts and
// named failed checks; the host (sessions-proof.mjs) is the only place a run passes. Never retries and never infers.
const SCENARIOS = ['read', 'malformed', 'inaccessible', 'unprivate', 'legacy', 'resume'];
const [scenario, manifestJson = '{}'] = process.argv.slice(2);
const manifest = JSON.parse(manifestJson);
if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
const home = '/root/.codex';
const report = { scenario, failures: [], methods: [], inference: 0 };
const need = (condition, label) => { if (!condition) report.failures.push(label); };
for (const cwd of ['/tmp/project', '/tmp/other']) mkdirSync(cwd, { recursive: true });
// R6 resumes a private writable copy in this container's tmpfs; the host's frozen source stays read-only.
if (scenario === 'resume') cpSync('/opt/resume-home', home, { recursive: true });
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url.startsWith('/v1/models?')) { response.writeHead(404).end(); return; }
  report.inference++;
  response.writeHead(403).end('Inspection inference refused');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const config = { model_provider: 'fixture', model: 'fixture-model', check_for_update_on_startup: false, 'analytics.enabled': false, 'features.apps': false };
for (const provider of ['fixture', 'other']) Object.assign(config, {
  [`model_providers.${provider}.name`]: provider, [`model_providers.${provider}.base_url`]: `http://127.0.0.1:${server.address().port}/v1`,
  [`model_providers.${provider}.wire_api`]: 'responses', [`model_providers.${provider}.supports_websockets`]: false,
  [`model_providers.${provider}.request_max_retries`]: 0, [`model_providers.${provider}.stream_max_retries`]: 0,
});
// R4 starts the server without a private index, so the adapter's own precondition must refuse before any history read.
if (scenario !== 'unprivate') Object.assign(config, { sqlite_home: '/tmp/private-index', log_dir: '/tmp/private-logs' });
const child = spawn('/opt/codex', ['app-server', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
  { cwd: '/tmp/project', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
let closed = false;
const childClosed = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
let stderrBytes = 0;
const channel = {
  listen(sink) {
    const data = (chunk) => sink.data(chunk);
    const diagnostic = (chunk) => { stderrBytes += chunk.length; sink.diagnostic(chunk); };
    const ended = () => sink.ended('process-exit');
    child.stdout.on('data', data);
    child.stderr.on('data', diagnostic);
    child.once('close', ended);
    return () => { child.stdout.off('data', data); child.stderr.off('data', diagnostic); child.off('close', ended); };
  },
  write: (frame) => new Promise((resolve, reject) => child.stdin.write(frame, (error) => (error ? reject(error) : resolve()))),
};
let notifications = 0;
const transport = openCodexTransport({ channel,
  bounds: { maxFrameBytes: 1048576, maxChunkBytes: 2097151, maxDiagnosticBytes: 65536, maxPending: 4, maxHandlers: 1, maxWrites: 8,
    observationCapacity: 1024, handlerTimeoutMs: 5000, observationTimeoutMs: 5000, writeTimeoutMs: 5000 },
  onRequest: () => ({ kind: 'error', error: { code: -32601, message: 'No server requests in this proof', data: null } }),
  onObservation: () => { notifications++; } });
const signal = () => AbortSignal.timeout(10000);
/** Raw harness requests (initialize, login, resume, evidence reads). These never count as adapter methods. */
const raw = async (method, params) => {
  const exchange = await transport.request({ method, params }, signal());
  if (exchange.kind !== 'reply') return { failure: exchange };
  const reply = exchange.envelope.reply;
  return reply.kind === 'result' ? { result: reply.value } : { error: { code: reply.error.code, message: reply.error.message } };
};
/** The borrowed request handed to the adapter: every method it sends is recorded. */
const borrowed = (call, abort) => { report.methods.push(call.method); return transport.request(call, abort); };
const bounds = { maxResults: 100, maxExamined: 1000, maxDurationMs: 20000 };
const ids = (page) => (page.kind === 'ok' ? page.value.sessions.map((session) => session.opaque).sort() : null);
const summary = (page) => (page.kind === 'ok' ? { kind: page.value.kind, ...(page.value.code ? { code: page.value.code } : {}),
  sessions: page.value.sessions.length, examined: page.value.examined, skipped: page.value.skipped, diagnostics: page.value.diagnostics.length }
  : { error: page.error.code });
const outcome = (value) => (value.kind === 'ok' ? value.value.kind : `error:${value.error.code}`);
try {
  const initialized = await raw('initialize', { clientInfo: { name: 'switchboard_sessions_proof', version: '0' }, capabilities: { experimentalApi: true } });
  need(initialized.result?.codexHome === home, 'initialize codexHome is the reader home');
  report.initialize = { codexHome: initialized.result?.codexHome ?? null, userAgent: initialized.result?.userAgent ?? null };
  need((await transport.notify({ method: 'initialized' }, signal())).kind === 'written', 'initialized notification written');
  need(!(await raw('account/login/start', { type: 'apiKey', apiKey: 'synthetic-discovery-key' })).error, 'API key login');
  const scope = { home, request: borrowed, initialize: { codexHome: initialized.result?.codexHome } };
  const access = (binding) => ({ scope, binding, bounds, signal: AbortSignal.timeout(30000) });
  const bind = async (nativeFormat) => {
    const { binding: _omitted, ...options } = access(undefined);
    return codexSessions.bind({ ...options, nativeFormat });
  };
  const reference = (binding, opaque) => ({ kind: 'session', formatVersion: 1, binding, opaque });
  const { first, legacy } = manifest;
  if (scenario === 'unprivate') {
    const resolved = await raw('config/read', { includeLayers: false });
    report.config = { sqlite_home: resolved.result?.config?.sqlite_home ?? null, log_dir: resolved.result?.config?.log_dir ?? null };
    report.methods = [];
    report.bind = outcome(await bind('codex-thread/paginated'));
    const fixed = { engine: 'codex', nativeVersion: '0.169.0', account: 'apiKey', authorizedScope: home, nativeFormat: 'codex-thread/paginated' };
    report.discover = summary(await codexSessions.discover(access(fixed)));
    need(report.bind === 'error:invalid-input' && report.discover.error === 'invalid-input', 'no private index is refused');
    need(JSON.stringify(report.methods) === JSON.stringify(['config/read', 'config/read']), 'refused before any history read');
  } else {
    const paginated = await bind('codex-thread/paginated');
    need(paginated.kind === 'ok', 'paginated binding');
    report.binding = paginated.value ?? null;
    const binding = paginated.value;
    if (scenario === 'read' || scenario === 'malformed') {
      const page = await codexSessions.discover(access(binding));
      report.discover = summary(page);
      report.ids = ids(page);
      need(page.value?.kind === 'complete', 'discovery complete');
      // Evidence the adapter does not expose: the native alias path, the fixture's creator version and Thread.path.
      const alias = await raw('getConversationSummary', { rolloutPath: `${home}/sessions/hardlink-alias.opaque` });
      report.aliasPathEqualsRequest = alias.result?.summary?.path === `${home}/sessions/hardlink-alias.opaque`;
      const read = await raw('thread/read', { threadId: manifest.second, includeTurns: false });
      report.thread = { cliVersion: read.result?.thread?.cliVersion ?? null, pathPresent: typeof read.result?.thread?.path === 'string' };
      need(report.thread.cliVersion === '0.169.0' && report.thread.pathPresent, 'native thread carries cliVersion 0.169.0 and path');
      report.inspectFirst = outcome(await codexSessions.inspect({ ...access(binding), reference: reference(binding, first) }));
      if (scenario === 'read') {
        report.inspectAbsent = outcome(await codexSessions.inspect({ ...access(binding), reference: reference(binding, manifest.absent) }));
        const ready = await codexSessions.prepareResume({ ...access(binding), reference: reference(binding, first) });
        report.prepareFirst = outcome(ready);
        need(ready.value?.threadId === first, 'ready preserves the exact native identity');
        report.prepareOtherAccount = outcome(await codexSessions.prepareResume({ ...access(binding),
          reference: reference({ ...binding, account: 'chatgpt:user-accountA' }, first) }));
        const legacyBinding = (await bind('codex-thread/legacy')).value;
        report.discoverLegacy = summary(await codexSessions.discover(access(legacyBinding)));
      }
    } else if (scenario === 'inaccessible') {
      report.methods = [];
      report.discover = summary(await codexSessions.discover(access(binding)));
      need(report.methods.length === 0, 'invalid tree refused before any native request');
    } else if (scenario === 'legacy') {
      const legacyBinding = (await bind('codex-thread/legacy')).value;
      const page = await codexSessions.discover(access(legacyBinding));
      report.discover = summary(page);
      report.ids = ids(page);
      report.discoverPaginated = summary(await codexSessions.discover(access(binding)));
      const prepared = await codexSessions.prepareResume({ ...access(legacyBinding), reference: reference(legacyBinding, legacy) });
      report.prepareLegacy = prepared.kind === 'ok' ? prepared.value : { error: prepared.error.code };
    } else if (scenario === 'resume') {
      const ready = await codexSessions.prepareResume({ ...access(binding), reference: reference(binding, first) });
      report.prepareFirst = outcome(ready);
      // The harness, not the adapter, dispatches: exact thread ID, no overrides, no history or path.
      const resumed = await raw('thread/resume', { threadId: first });
      report.resume = { sameId: resumed.result?.thread?.id === first, turns: resumed.result?.thread?.turns?.length ?? null,
        error: resumed.error ?? resumed.failure ?? null };
      need(report.resume.sameId && report.resume.turns >= 1, 'resume returns the same thread with saved turns');
      report.inspectAfter = outcome(await codexSessions.inspect({ ...access(binding), reference: reference(binding, first) }));
      report.prepareAfter = outcome(await codexSessions.prepareResume({ ...access(binding), reference: reference(binding, first) }));
      need(!(await raw('account/logout', {})).error, 'logout');
      need(!(await raw('account/login/start', accountLogin('accountA'))).error, 'synthetic ChatGPT login');
      const saved = readFileSync(`/opt/resume-home/${manifest.firstPath}`);
      report.resume.prefixPreserved = readFileSync(`${home}/${manifest.firstPath}`).subarray(0, saved.length).equals(saved);
      report.prepareChangedLogin = outcome(await codexSessions.prepareResume({ ...access(binding), reference: reference(binding, first) }));
    }
  }
  need(report.methods.every((method) => codexSessionMethods.includes(method)), 'adapter methods within the read-only allowlist');
} catch (error) {
  report.failures.push(`exception: ${error.message}`);
} finally {
  report.notifications = notifications;
  report.close = (await transport.close()).reason;
  if (!closed) child.kill('SIGTERM');
  await Promise.race([childClosed, delay(5000)]);
  if (!closed) { child.kill('SIGKILL'); await childClosed; }
  report.stderrBytes = stderrBytes;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  need(report.inference === 0, 'no inference');
}
console.log(JSON.stringify(report));
