import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent';
import { terminalOutcome } from './terminal.js';

export interface PiRuntimeOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly provider: 'opencode-go';
  readonly model: 'glm-5.3';
}
export interface PiTerminal {
  readonly kind: 'ended';
  readonly outcome: 'completed' | 'interrupted' | 'failed';
}
export type PiEvent = { readonly kind: 'text'; readonly text: string } | PiTerminal;
export interface PiPrompt { readonly finished: Promise<PiTerminal> }
export interface PiSession {
  readonly id: string;
  readonly sessionFile: string;
  prompt(text: string, onEvent: (event: PiEvent) => void): Promise<PiPrompt>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
type Unsupported = { readonly state: 'unsupported' };
/**
 * Assignable to the root `ReadinessReport`. Pi re-observes only the directories `createPiRuntime` checked.
 * The SDK runs in-process and its version and credentials are not probed, so Pi cannot report ready.
 */
export type PiReadinessReport = {
  readonly provider: 'pi';
  readonly observedAt: string;
  readonly checked: readonly 'workspace'[];
  readonly facts: {
    readonly installation: Unsupported; readonly version: Unsupported; readonly authentication: Unsupported;
    readonly workspace: { readonly state: 'accessible' | 'inaccessible' | 'unknown' | 'cancelled' | 'not_checked' };
  };
} & (
  | { readonly verdict: 'blocked'; readonly remediation: { readonly code: 'workspace_unavailable'; readonly message: string } }
  | { readonly verdict: 'unverified';
    readonly remediation: { readonly code: 'retry_check' | 'check_cancelled' | 'runtime_closed' | 'check_unavailable'; readonly message: string } });
export interface PiRuntime {
  open(options?: { readonly sessionFile?: string }): Promise<PiSession>;
  readinessReport(options?: { readonly signal?: AbortSignal }): Promise<PiReadinessReport>;
  close(): Promise<void>;
}

const writers = new Set<string>();
const MAX_SESSIONS = 32;
const failure = () => new Error('Pi operation failed.');
const remedies = {
  workspace_unavailable: 'Make the Pi working directory and session directory available.',
  retry_check: 'Pi did not finish the readiness check. Try again.',
  check_cancelled: 'The Pi readiness check was cancelled.',
  runtime_closed: 'This Pi runtime is closed.',
  check_unavailable: 'Local Pi checks passed. Version and sign-in are confirmed when a chat starts.',
} as const;

async function workspaceState(cwd: string, directory: string): Promise<'accessible' | 'inaccessible' | 'unknown'> {
  try {
    return (await stat(cwd)).isDirectory() && (await stat(directory)).isDirectory() ? 'accessible' : 'inaccessible';
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' ? 'inaccessible' : 'unknown';
  }
}

function emptyResources(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'You are a helpful assistant. Respond with text.',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function resumeManager(directory: string, file: string, cwd: string): SessionManager {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(file) || basename(file) !== file) throw failure();
  const path = join(directory, file);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.size === 0 || realpathSync.native(path) !== path) throw failure();
  const descriptor = openSync(path, 'r');
  let firstLine: string;
  try {
    const prefix = Buffer.alloc(64 * 1024);
    const bytes = readSync(descriptor, prefix, 0, prefix.length, 0);
    const newline = prefix.indexOf(10, 0);
    if (newline < 0 || newline >= bytes) throw failure();
    firstLine = prefix.toString('utf8', 0, newline);
  } finally { closeSync(descriptor); }
  const header: unknown = JSON.parse(firstLine);
  if (typeof header !== 'object' || header === null || !('type' in header) || header.type !== 'session'
    || !('id' in header) || typeof header.id !== 'string' || !header.id
    || !('cwd' in header) || header.cwd !== cwd) throw failure();
  const manager = SessionManager.open(path, directory, cwd);
  if (manager.getSessionId() !== header.id || manager.getHeader()?.id !== header.id) throw failure();
  return manager;
}

function sessionHandle(native: AgentSession, release: () => void): PiSession {
  const file = native.sessionFile;
  if (!file) throw failure();
  let running: { finished: Promise<PiTerminal>; stop: () => void } | undefined;
  let closing: Promise<void> | undefined;
  const abort = async () => {
    const current = running;
    if (!current) return;
    current.stop();
    try { await native.abort(); await current.finished; } catch { throw failure(); }
  };
  return {
    id: native.sessionId,
    sessionFile: basename(file),
    async prompt(text, onEvent) {
      if (closing) throw new Error('Pi session is closed.');
      if (running) throw new Error('Pi session is busy.');
      if (typeof text !== 'string' || !text.trim() || typeof onEvent !== 'function') throw failure();
      const admission = Promise.withResolvers<PiPrompt>();
      const completion = Promise.withResolvers<PiTerminal>();
      let started = false;
      const admissionState: { current: 'pending' | 'admitted' | 'rejected' } = { current: 'pending' };
      let stopped = false;
      let callbackFailed = false;
      let latestText = '';
      const emit = (event: PiEvent) => {
        try { onEvent(event); } catch { callbackFailed = true; stopped = true; void native.abort().catch(() => {}); }
      };
      const stop = () => { stopped = true; };
      const rejectAdmission = () => {
        if (admissionState.current !== 'pending') return;
        admissionState.current = 'rejected';
        admission.reject(failure());
      };
      running = { finished: completion.promise, stop };
      const before = native.messages.length;
      const unsubscribe = native.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'user') {
          // Pi 1.5.2 appends the shared user message synchronously after notifying public listeners.
          queueMicrotask(() => {
            if (!started || admissionState.current !== 'pending') return;
            const leaf = native.sessionManager.getLeafEntry();
            if (!existsSync(file) || leaf?.type !== 'message' || leaf.message !== event.message) {
              stop(); rejectAdmission(); void native.abort().catch(() => {}); return;
            }
            admissionState.current = 'admitted';
            admission.resolve({ finished: completion.promise });
          });
        }
        if ((event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
          if (event.type === 'message_end' && event.message.errorMessage !== undefined) {
            // Pi 1.5.2 notifies public listeners before appendMessage, so redact the shared message before journaling.
            event.message.errorMessage = 'Pi operation failed.';
          }
          const text = event.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
          if (text !== latestText) { latestText = text; emit({ kind: 'text', text }); }
        }
      });
      void (async () => {
        let outcome: PiTerminal['outcome'] = 'failed';
        try {
          await native.prompt(text, {
            expandPromptTemplates: false,
            preflightResult(disposition) {
              if (disposition !== 'started') { stop(); rejectAdmission(); void native.abort().catch(() => {}); return; }
              started = true;
              if (stopped) void native.abort().catch(() => {});
            },
          });
          await native.waitForIdle();
          const last = native.messages.slice(before).findLast(message => message.role === 'assistant');
          outcome = terminalOutcome(last?.role === 'assistant' ? last.stopReason : undefined, stopped && started);
          if (callbackFailed) outcome = 'failed';
        } catch {
          outcome = stopped && started ? 'interrupted' : 'failed';
          try { await native.abort(); await native.waitForIdle(); } catch { outcome = 'failed'; }
        } finally {
          unsubscribe();
          rejectAdmission();
          const terminal: PiTerminal = { kind: 'ended', outcome };
          if (admissionState.current === 'admitted') emit(terminal);
          running = undefined;
          completion.resolve(callbackFailed ? { kind: 'ended', outcome: 'failed' } : terminal);
        }
      })();
      return admission.promise;
    },
    abort,
    close() {
      closing ??= (async () => {
        await abort();
        try { await native.waitForIdle(); } catch { throw failure(); }
        try { native.dispose(); } catch { throw failure(); } finally { release(); }
      })();
      return closing;
    },
  };
}

export async function createPiRuntime(options: PiRuntimeOptions): Promise<PiRuntime> {
  try {
    if (options.provider !== 'opencode-go' || options.model !== 'glm-5.3'
      || typeof options.apiKey !== 'string' || !options.apiKey.trim()) throw failure();
    const cwd = await realpath(options.cwd);
    if (!(await stat(cwd)).isDirectory()) throw failure();
    await mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 });
    const directory = await realpath(options.sessionDirectory);
    if (!(await stat(directory)).isDirectory()) throw failure();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(options.provider, async () => ({ type: 'api_key', key: options.apiKey }));
    const models = await ModelRuntime.create({
      credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const model = models.getModel(options.provider, options.model);
    if (!model || model.provider !== options.provider || model.id !== options.model) throw failure();
    const sessions = new Set<PiSession>();
    const opening = new Set<Promise<PiSession>>();
    let closing: Promise<void> | undefined;
    return {
      open(openOptions = {}) {
        if (closing) return Promise.reject(new Error('Pi runtime is closed.'));
        if (sessions.size + opening.size >= MAX_SESSIONS) return Promise.reject(new Error('Pi session limit reached.'));
        const operation = (async () => {
          let path: string | undefined;
          let native: AgentSession | undefined;
          let reserved = false;
          try {
            if (openOptions.sessionFile !== undefined) {
              if (basename(openOptions.sessionFile) !== openOptions.sessionFile) throw failure();
              path = join(directory, openOptions.sessionFile);
              if (writers.has(path)) throw new Error('Pi session is busy.');
              writers.add(path);
              reserved = true;
            }
            const manager = openOptions.sessionFile === undefined
              ? SessionManager.create(cwd, directory)
              : resumeManager(directory, openOptions.sessionFile, cwd);
            if (path === undefined) {
              path = manager.getSessionFile();
              if (!path || writers.has(path)) throw failure();
              writers.add(path);
              reserved = true;
            }
            const result = await createAgentSession({
              cwd, agentDir: directory, modelRuntime: models, model, thinkingLevel: 'off',
              tools: [], noTools: 'all', customTools: [], resourceLoader: emptyResources(), sessionManager: manager,
              settingsManager: SettingsManager.inMemory({
                compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
                cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false, transport: 'sse',
              }),
            });
            native = result.session;
            if (closing || result.modelFallbackMessage || native.sessionId !== manager.getSessionId()
              || native.sessionFile !== path) throw failure();
            const ownedPath = path;
            const handle = sessionHandle(native, () => { writers.delete(ownedPath); sessions.delete(handle); });
            sessions.add(handle);
            return handle;
          } catch {
            if (native) {
              try { await native.abort(); await native.waitForIdle(); } catch { throw failure(); }
            }
            try { native?.dispose(); } catch { throw failure(); } finally {
              if (path && reserved) writers.delete(path);
            }
            throw failure();
          }
        })();
        opening.add(operation);
        void operation.then(() => opening.delete(operation), () => opening.delete(operation));
        return operation;
      },
      async readinessReport(readiness): Promise<PiReadinessReport> {
        const signal = readiness?.signal;
        if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure();
        const state = closing ? 'not_checked' : signal?.aborted ? 'cancelled' : await workspaceState(cwd, directory);
        const unsupported = { state: 'unsupported' } as const;
        const base = { provider: 'pi', observedAt: new Date().toISOString(),
          checked: state === 'accessible' || state === 'inaccessible' ? ['workspace' as const] : [],
          facts: { installation: unsupported, version: unsupported, authentication: unsupported, workspace: { state } } } as const;
        if (state === 'inaccessible') return { ...base, verdict: 'blocked', remediation: { code: 'workspace_unavailable', message: remedies.workspace_unavailable } };
        const code = closing ? 'runtime_closed' : state === 'cancelled' ? 'check_cancelled' : state === 'unknown' ? 'retry_check' : 'check_unavailable';
        return { ...base, verdict: 'unverified', remediation: { code, message: remedies[code] } };
      },
      close() {
        closing ??= (async () => {
          await Promise.allSettled([...opening]);
          try {
            try {
              const results = await Promise.allSettled([...sessions].map(session => session.close()));
              await models.settleCredentialWrites();
              if (results.some(result => result.status === 'rejected')) throw failure();
            } finally { await credentials.delete(options.provider); }
          } catch { throw failure(); }
        })();
        return closing;
      },
    };
  } catch { throw failure(); }
}
