import { execFile, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Codex } from '@openai/codex-sdk';
import { withSdkProcess } from './process.js';
import type { ThreadOptions } from '@openai/codex-sdk';

export interface CodexRuntimeOptions {
  readonly cwd: string;
  readonly model: string;
  readonly codexHome?: string;
  readonly codexPathOverride?: string;
}
export interface CodexTerminal {
  readonly kind: 'ended';
  readonly outcome: 'completed' | 'failed' | 'interrupted';
}
export type CodexEvent = { readonly kind: 'text'; readonly itemId: string; readonly text: string } | CodexTerminal;
export interface CodexTurn {
  readonly threadId: string;
  readonly finished: Promise<CodexTerminal>;
  abort(): Promise<void>;
}
export interface CodexRequest {
  readonly text: string;
  readonly threadId?: string;
  readonly onEvent: (event: CodexEvent) => void;
}
type Inconclusive = { readonly state: 'timed_out' | 'cancelled' | 'unknown' | 'not_checked' };
// Narrower than the root types on purpose: Codex pins one exact version and one login method.
type Qualified = { readonly state: 'qualified'; readonly required: '0.169.0'; readonly observed: '0.169.0' };
type SignedIn = { readonly state: 'signed_in'; readonly method: 'chatgpt' };
type Facts<Installation, Version, Authentication> = {
  readonly installation: Installation; readonly version: Version;
  readonly authentication: Authentication; readonly workspace: { readonly state: 'unsupported' };
};
type CodexFacts = Facts<{ readonly state: 'available' } | { readonly state: 'not_installed' | 'not_executable' } | Inconclusive,
  Qualified | { readonly state: 'mismatch'; readonly required: '0.169.0'; readonly observed: string } | Inconclusive,
  SignedIn | { readonly state: 'sign_in_required' | 'unsupported_method' } | Inconclusive>;
export interface CodexReadinessOptions {
  readonly signal?: AbortSignal;
  /** Deadline for each probe in milliseconds, an integer from 1 through 10000. Defaults to 10000. */
  readonly timeoutMs?: number;
}
/** Assignable to the root `ReadinessReport`. Each call runs fresh bounded probes against the executable resolved at creation. */
export type CodexReadinessReport = {
  readonly provider: 'codex';
  readonly observedAt: string;
  readonly checked: readonly ('installation' | 'version' | 'authentication')[];
} & (
  | { readonly verdict: 'ready'; readonly remediation: null; readonly facts: Facts<{ readonly state: 'available' }, Qualified, SignedIn> }
  | { readonly verdict: 'blocked'; readonly facts: CodexFacts;
    readonly remediation: { readonly code: 'install_required' | 'version_required' | 'sign_in_required'; readonly message: string } }
  | { readonly verdict: 'unverified'; readonly facts: CodexFacts;
    readonly remediation: { readonly code: 'retry_check' | 'check_cancelled' | 'runtime_closed'; readonly message: string } });
export interface CodexRuntime {
  checkReady(): Promise<void>;
  readinessReport(options?: CodexReadinessOptions): Promise<CodexReadinessReport>;
  start(request: CodexRequest): Promise<CodexTurn>;
  close(): Promise<void>;
}

const run = promisify(execFile);
const writers = new Set<string>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = () => new Error('Codex operation failed.');
// Matches plain(value, 256) and must stay identical in the three text adapters.
function callerModelId(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256 || /\p{Cs}/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function absolutePath(value: unknown): boolean {
  return typeof value === 'string' && isAbsolute(value);
}
const QUALIFIED = '0.169.0';
const INSTALL = 'Install Codex CLI 0.169.0 to use Codex chat.';
const SIGN_IN = 'Sign in with ChatGPT using codex login to use Codex chat.';
const UNVERIFIED = {
  retry_check: 'Codex did not finish the readiness check. Try again.',
  check_cancelled: 'The Codex readiness check was cancelled.',
  runtime_closed: 'This Codex runtime is closed.',
} as const;
const versionLine = /^codex-cli (\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4})?)?)$/;
const unobserved = new Set(['timed_out', 'cancelled', 'unknown', 'not_checked', 'unsupported']);
type ProbeKind = 'ok' | 'exited' | 'missing' | 'denied' | 'timed_out' | 'cancelled' | 'unknown';
type Probe = { readonly spawned: boolean; readonly kind: ProbeKind; readonly stdout: string; readonly stderr: string };
const field = (error: unknown, key: string): unknown => error !== null && typeof error === 'object' ? Reflect.get(error, key) : undefined;
const inconclusive = (kind: ProbeKind): Inconclusive => ({ state: kind === 'timed_out' || kind === 'cancelled' ? kind : 'unknown' });
const notChecked = { state: 'not_checked' } as const;

function nativeEnvironment(codexHome: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'CODEX_HOME']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  return env;
}

export function createCodexRuntime(options: CodexRuntimeOptions): CodexRuntime {
  if (!callerModelId(options.model) || !absolutePath(options.cwd)
    || (options.codexHome !== undefined && !absolutePath(options.codexHome))
    || (options.codexPathOverride !== undefined && !absolutePath(options.codexPathOverride))) throw failure();
  const cwd = resolve(options.cwd);
  const env = nativeEnvironment(options.codexHome);
  const executable = options.codexPathOverride ?? (env.PATH === undefined ? [] : env.PATH.split(delimiter)).map(dir => resolve(dir, 'codex')).find(path => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  async function runCli(args: string[], signal: AbortSignal, maxBuffer: number) {
    if (!executable) throw failure();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    return withSdkProcess(deadline, () => run(executable, args, {
      env, cwd, signal: deadline, maxBuffer, encoding: 'utf8',
    }));
  }
  /** Native output stays here. Callers receive enums and only a version that matches `versionLine`. */
  async function probe(args: string[], signal: AbortSignal, timeoutMs: number): Promise<Probe> {
    const none = (kind: ProbeKind, spawned = false): Probe => ({ spawned, kind, stdout: '', stderr: '' });
    if (!executable) return none('missing');
    if (signal.aborted) return none('cancelled');
    const timer = AbortSignal.timeout(timeoutMs);
    const deadline = AbortSignal.any([signal, timer]);
    let child: ChildProcess | undefined;
    try {
      const { stdout, stderr } = await withSdkProcess(deadline, () => {
        const running = run(executable, args, { env, cwd, signal: deadline, maxBuffer: 16_384, encoding: 'utf8' });
        child = running.child;
        return running;
      });
      return { spawned: true, kind: 'ok', stdout, stderr };
    } catch (error) {
      const code = field(error, 'code');
      const stderr = field(error, 'stderr');
      const spawned = child?.pid !== undefined;
      if (signal.aborted || timer.aborted) return none(signal.aborted ? 'cancelled' : 'timed_out', spawned);
      if (typeof code === 'number') return { spawned, kind: 'exited', stdout: '', stderr: typeof stderr === 'string' ? stderr : '' };
      if (spawned || (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM')) return none('unknown', spawned);
      // Spawn also reports ENOENT for a missing cwd, so only the executable path itself proves absence.
      return none(await access(executable, constants.X_OK).then((): ProbeKind => 'unknown', (reason: unknown): ProbeKind => {
        const denied = field(reason, 'code');
        return denied === 'ENOENT' || denied === 'ENOTDIR' ? 'missing' : denied === 'EACCES' || denied === 'EPERM' ? 'denied' : 'unknown';
      }));
    }
  }
  async function observe(signal: AbortSignal, timeoutMs: number): Promise<CodexReadinessReport> {
    const version = await probe(['--version'], signal, timeoutMs);
    const installation = version.spawned ? { state: 'available' } as const : version.kind === 'missing' ? { state: 'not_installed' } as const
      : version.kind === 'denied' ? { state: 'not_executable' } as const : inconclusive(version.kind);
    const seen = version.kind === 'ok' ? versionLine.exec(version.stdout.trim())?.[1] : undefined;
    const qualified = !version.spawned ? notChecked : version.kind !== 'ok' ? inconclusive(version.kind)
      : seen === QUALIFIED ? { state: 'qualified', required: QUALIFIED, observed: QUALIFIED } as const
      : seen ? { state: 'mismatch', required: QUALIFIED, observed: seen } as const : { state: 'unknown' } as const;
    let authentication: CodexFacts['authentication'] = notChecked;
    // Login status runs only for the qualified CLI, as before. Only exact lines are evidence; anything else is unknown.
    if (qualified.state === 'qualified') {
      const login = await probe(['login', 'status'], signal, timeoutMs);
      const said = login.stderr.trim();
      authentication = login.kind === 'ok' && said === 'Logged in using ChatGPT' ? { state: 'signed_in', method: 'chatgpt' }
        : (login.kind === 'ok' || login.kind === 'exited') && said === 'Not logged in' ? { state: 'sign_in_required' }
        : login.kind === 'ok' && said.startsWith('Logged in using ') ? { state: 'unsupported_method' } : inconclusive(login.kind);
    }
    return report(installation, qualified, authentication);
  }
  function report(installation: CodexFacts['installation'], version: CodexFacts['version'],
    authentication: CodexFacts['authentication']): CodexReadinessReport {
    const workspace = { state: 'unsupported' } as const;
    const facts = { installation, version, authentication, workspace };
    const checked = (['installation', 'version', 'authentication'] as const).filter(fact => !unobserved.has(facts[fact].state));
    const base = { provider: 'codex', observedAt: new Date().toISOString(), checked } as const;
    if (installation.state === 'available' && version.state === 'qualified' && authentication.state === 'signed_in') {
      return { ...base, verdict: 'ready', remediation: null, facts: { installation, version, authentication, workspace } };
    }
    const blocked = installation.state === 'not_installed' || installation.state === 'not_executable' ? 'install_required'
      : version.state === 'mismatch' ? 'version_required'
      : authentication.state === 'sign_in_required' || authentication.state === 'unsupported_method' ? 'sign_in_required' : undefined;
    if (blocked) return { ...base, facts, verdict: 'blocked', remediation: { code: blocked, message: blocked === 'sign_in_required' ? SIGN_IN : INSTALL } };
    const code = closed ? 'runtime_closed' : [installation, version, authentication].some(fact => fact.state === 'cancelled') ? 'check_cancelled' : 'retry_check';
    return { ...base, facts, verdict: 'unverified', remediation: { code, message: UNVERIFIED[code] } };
  }
  /** The legacy projection: qualified means exactly `codex-cli 0.169.0`, signed in means exit 0 and the exact ChatGPT line. */
  function assertReady({ facts }: CodexReadinessReport): void {
    if (facts.version.state !== 'qualified') throw new Error(INSTALL);
    if (facts.authentication.state !== 'signed_in') throw new Error(SIGN_IN);
  }

  async function disableMcpServers(signal: AbortSignal): Promise<string> {
    // Native config merges retain transport fields, so disabled entries must keep their transport kind.
    const { stdout } = await runCli(['mcp', 'list', '--json'], signal, 1024 * 1024);
    const servers: unknown = JSON.parse(stdout);
    if (!Array.isArray(servers) || servers.length > 512) throw failure();
    const disabled = servers.map((server: unknown) => {
      if (!server || typeof server !== 'object' || !('name' in server)
        || typeof server.name !== 'string' || !server.name || server.name.length > 256 || !('transport' in server)) throw failure();
      const transport = server.transport;
      if (!transport || typeof transport !== 'object' || !('type' in transport)) throw failure();
      switch (transport.type) {
        case 'stdio':
          return JSON.stringify(server.name) + '={enabled=false,command="switchboard-disabled-mcp"}';
        case 'streamable_http':
          return JSON.stringify(server.name) + '={enabled=false,url="http://127.0.0.1:9/disabled"}';
        default:
          throw failure();
      }
    });
    return 'mcp_servers={' + disabled.join(',') + '}';
  }

  const threadOptions: ThreadOptions = {
    model: options.model, modelReasoningEffort: 'low', workingDirectory: cwd,
    sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false,
    webSearchMode: 'disabled', skipGitRepoCheck: true,
  };
  const active = new Map<AbortController, Promise<CodexTerminal>>();
  const checks = new Map<AbortController, Promise<unknown>>();
  let closed = false;

  function track<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const settled = work(controller.signal).finally(() => checks.delete(controller));
    checks.set(controller, settled);
    return settled;
  }
  function checkReady(): Promise<void> {
    return closed ? Promise.reject(failure()) : track(signal => observe(signal, 10_000).then(assertReady));
  }
  function readinessReport(options?: CodexReadinessOptions): Promise<CodexReadinessReport> {
    const { signal, timeoutMs = 10_000 } = options ?? {};
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
      || (signal !== undefined && !(signal instanceof AbortSignal))) return Promise.reject(failure());
    if (closed) return Promise.resolve(report(notChecked, notChecked, notChecked));
    return track(own => observe(signal ? AbortSignal.any([own, signal]) : own, timeoutMs));
  }

  function start(request: CodexRequest): Promise<CodexTurn> {
    const { threadId: requested, text, onEvent } = request;
    if (closed || active.size >= 32 || typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text) > 1024 * 1024 || typeof onEvent !== 'function'
      || (requested !== undefined && (!uuid.test(requested) || writers.has(requested)))) return Promise.reject(failure());
    let reserved = requested;
    if (reserved !== undefined) writers.add(reserved);
    const controller = new AbortController();
    const admission = Promise.withResolvers<CodexTurn>();
    let admitted = false;
    let streamFault = false;

    async function consume(): Promise<CodexTerminal> {
      let outcome: CodexTerminal['outcome'] = 'failed';
      let terminal: CodexTerminal['outcome'] | undefined;
      try {
        if (!executable) throw failure();
        assertReady(await observe(controller.signal, 10_000));
        controller.signal.throwIfAborted();
        const sdk = new Codex({
          codexPathOverride: executable, env, configOverrides: [await disableMcpServers(controller.signal)],
          config: {
            forced_login_method: 'chatgpt', model_provider: 'openai',
            chatgpt_base_url: 'https://chatgpt.com/backend-api', openai_base_url: 'https://chatgpt.com/backend-api/codex',
            project_doc_max_bytes: 0,
            features: { shell_tool: false, apps: false, plugins: false, hooks: false,
              js_repl: false, image_generation: false, multi_agent_v2: false, skip_host_skill_discovery: true },
          },
        });
        const thread = requested === undefined ? sdk.startThread(threadOptions) : sdk.resumeThread(requested, threadOptions);
        const { events } = await thread.runStreamed(text, { signal: controller.signal });
        let observedId: string | undefined;
        await withSdkProcess(controller.signal, async () => {
          for await (const event of events) {
            if (controller.signal.aborted) continue;
            try {
              if (terminal !== undefined) throw failure();
              switch (event.type) {
                case 'thread.started': {
                  const id = event.thread_id;
                  if (typeof id !== 'string' || !uuid.test(id) || observedId !== undefined
                    || (requested !== undefined ? id !== requested : writers.has(id))) throw failure();
                  observedId = id;
                  reserved = id;
                  writers.add(id);
                  break;
                }
                case 'turn.started':
                  if (observedId === undefined || admitted) throw failure();
                  admitted = true;
                  admission.resolve({ threadId: observedId, finished, async abort() { controller.abort(); await finished; } });
                  break;
                case 'item.started':
                case 'item.updated':
                case 'item.completed': {
                  if (event.item.type === 'agent_message') {
                    if (!admitted) throw failure();
                    const { id, text: snapshot } = event.item;
                    if (typeof id !== 'string' || !id || id.length > 512 || typeof snapshot !== 'string'
                      || Buffer.byteLength(snapshot) > 4 * 1024 * 1024) throw failure();
                    onEvent({ kind: 'text', itemId: id, text: snapshot });
                  }
                  break;
                }
                case 'turn.completed':
                  if (!admitted) throw failure();
                  terminal = 'completed';
                  break;
                case 'turn.failed':
                  terminal = 'failed';
                  break;
              }
            } catch {
              streamFault = true;
              controller.abort();
            }
          }
        });
        outcome = terminal ?? 'failed';
      } catch {
        outcome = 'failed';
      } finally {
        if (streamFault) outcome = 'failed';
        else if (terminal !== undefined) outcome = terminal;
        else if (controller.signal.aborted) outcome = 'interrupted';
        if (reserved !== undefined) writers.delete(reserved);
        active.delete(controller);
      }
      const end: CodexTerminal = { kind: 'ended', outcome };
      if (admitted) {
        try { onEvent(end); } catch { /* A consumer exception cannot change the native outcome. */ }
      } else admission.reject(failure());
      return end;
    }

    const finished = consume();
    active.set(controller, finished);
    return admission.promise;
  }

  return { checkReady, readinessReport, start, async close() {
    closed = true;
    const readiness = [...checks.entries()];
    for (const [controller] of readiness) controller.abort();
    const pending = [...active.entries()];
    for (const [controller] of pending) controller.abort();
    await Promise.allSettled([...pending.map(([, finished]) => finished), ...readiness.map(([, ready]) => ready)]);
  } };
}
