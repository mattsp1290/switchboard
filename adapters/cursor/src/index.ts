import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { cursorLocalOptions, readCursorOptions, type CursorRuntimeOptions } from './config.js';
import { sdk } from './sdk.js';

export type { CursorRuntimeOptions } from './config.js';

export type CursorOutcome = 'completed' | 'failed' | 'interrupted';
export type CursorToolStatus = 'running' | 'completed' | 'error';
export type CursorEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly callId: string; readonly name: string; readonly status: CursorToolStatus }
  | { readonly kind: 'ended'; readonly outcome: CursorOutcome };
export interface CursorTurn {
  readonly agentId: string;
  readonly finished: Promise<CursorOutcome>;
  abort(): Promise<void>;
}
export interface CursorRequest {
  readonly text: string;
  readonly agentId?: string;
  readonly onEvent: (event: CursorEvent) => void;
}
type CursorFacts = {
  readonly installation: { readonly state: 'unsupported' };
  readonly version: { readonly state: 'unsupported' };
  readonly authentication: { readonly state: 'unsupported' };
  readonly workspace: { readonly state: 'accessible' | 'inaccessible' | 'unknown' | 'cancelled' | 'not_checked' };
};
/**
 * Assignable to the root `ReadinessReport`. Cursor observes the working directory and session directory only.
 * Installation, version, and authentication stay unsupported, so the report cannot be ready.
 */
export type CursorReadinessReport = {
  readonly provider: 'cursor';
  readonly observedAt: string;
  readonly checked: readonly ('installation' | 'version' | 'authentication' | 'workspace')[];
  readonly facts: CursorFacts;
} & (
  | { readonly verdict: 'blocked'; readonly remediation: { readonly code: 'workspace_unavailable'; readonly message: string } }
  | { readonly verdict: 'unverified';
    readonly remediation: { readonly code: 'retry_check' | 'check_cancelled' | 'runtime_closed' | 'check_unavailable'; readonly message: string } });
export interface CursorRuntime {
  checkReady(): Promise<void>;
  readinessReport(options?: { readonly signal?: AbortSignal }): Promise<CursorReadinessReport>;
  start(request: CursorRequest): Promise<CursorTurn>;
  close(): Promise<void>;
}

const failure = () => new Error('Cursor operation failed.');
const writers = new Set<string>();
const unobserved = new Set(['timed_out', 'cancelled', 'unknown', 'not_checked', 'unsupported']);
const refused = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EEXIST', 'EROFS', 'ELOOP']);
const TEXT_LIMIT = 1024 * 1024;
const SNAPSHOT_LIMIT = 4 * 1024 * 1024;
const remedies = {
  workspace_unavailable: 'Make the working directory readable and the Cursor session directory writable.',
  retry_check: 'Cursor did not finish the readiness check. Try again.',
  check_cancelled: 'The Cursor readiness check was cancelled.',
  runtime_closed: 'This Cursor runtime is closed.',
  check_unavailable: 'Local Cursor checks passed. Sign-in and version are confirmed when a chat starts.',
} as const;

function agentIdText(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256) return false;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) <= 31) return false;
  return true;
}

function toolName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) <= 31) return false;
  return true;
}

function toolStatus(value: unknown): value is CursorToolStatus {
  return value === 'running' || value === 'completed' || value === 'error';
}

function errno(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function workspaceErrno(error: unknown): 'inaccessible' | 'unknown' {
  return refused.has(String(errno(error))) ? 'inaccessible' : 'unknown';
}

type Step = 'next' | 'request' | 'bad-tool' | 'overflow';

interface AgentHandle {
  readonly agentId: string;
  send(message: string): Promise<RunHandle>;
  [Symbol.asyncDispose](): Promise<void>;
}
interface RunHandle {
  supports(operation: 'cancel'): boolean;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{ status: string }>;
  cancel(): Promise<void>;
}

export function createCursorRuntime(input: CursorRuntimeOptions): CursorRuntime {
  const read = readCursorOptions(input);
  if (!read) throw failure();
  const options: CursorRuntimeOptions = read;
  const active = new Set<Promise<void>>();
  const opened: AgentHandle[] = [];
  const disposals = new Map<AgentHandle, Promise<void>>();
  const cancellers = new Set<() => Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function dispose(agent: AgentHandle): Promise<void> {
    const existing = disposals.get(agent);
    if (existing) return existing;
    const pending = agent[Symbol.asyncDispose]();
    disposals.set(agent, pending);
    return pending;
  }

  function localOptions() {
    const fields = cursorLocalOptions(options.cwd, options.sessionDirectory);
    return {
      cwd: fields.cwd,
      settingSources: fields.settingSources,
      sandboxOptions: fields.sandboxOptions,
      enableAgentRetries: fields.enableAgentRetries,
      store: new sdk.Store(fields.storeDirectory),
    };
  }

  async function observe(signal?: AbortSignal): Promise<CursorReadinessReport> {
    let workspace: CursorFacts['workspace'] = { state: 'accessible' };
    if (closed) workspace = { state: 'not_checked' };
    else if (signal?.aborted) workspace = { state: 'cancelled' };
    else {
      try { await access(options.cwd, constants.R_OK); }
      catch (error) { workspace = { state: workspaceErrno(error) }; }
      try {
        await mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 });
        await access(options.sessionDirectory, constants.R_OK | constants.W_OK);
      } catch (error) {
        if (workspace.state === 'accessible') workspace = { state: workspaceErrno(error) };
      }
    }
    const facts = {
      installation: { state: 'unsupported' }, version: { state: 'unsupported' },
      authentication: { state: 'unsupported' }, workspace,
    } as const;
    const checked = (['installation', 'version', 'authentication', 'workspace'] as const)
      .filter(fact => !unobserved.has(facts[fact].state));
    const base = { provider: 'cursor', observedAt: new Date().toISOString(), checked, facts } as const;
    if (workspace.state === 'inaccessible') {
      return { ...base, verdict: 'blocked', remediation: { code: 'workspace_unavailable', message: remedies.workspace_unavailable } };
    }
    const code = closed ? 'runtime_closed'
      : workspace.state === 'cancelled' ? 'check_cancelled'
      : workspace.state === 'unknown' ? 'retry_check'
      : 'check_unavailable';
    return { ...base, verdict: 'unverified', remediation: { code, message: remedies[code] } };
  }

  async function checkReady(): Promise<void> {
    if (closed) throw failure();
    const report = await observe();
    if (report.facts.workspace.state !== 'accessible') throw failure();
  }

  function readinessReport(readiness?: { readonly signal?: AbortSignal }): Promise<CursorReadinessReport> {
    const signal = readiness?.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(failure());
    return observe(signal);
  }

  function start(request: CursorRequest): Promise<CursorTurn> {
    const { text, agentId: requested, onEvent } = request;
    if (closed || active.size >= 32 || typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text) > TEXT_LIMIT
      || typeof onEvent !== 'function' || (requested !== undefined && (!agentIdText(requested) || writers.has(requested)))) {
      return Promise.reject(failure());
    }
    let trackedId = requested;
    if (requested !== undefined) writers.add(requested);
    const release = (): void => {
      if (trackedId === undefined) return;
      writers.delete(trackedId);
      trackedId = undefined;
    };
    const admission = Promise.withResolvers<CursorTurn>();
    const done = Promise.withResolvers<CursorOutcome>();
    let admitted = false;
    const task = execute();
    active.add(task);
    task.finally(() => {
      active.delete(task);
      release();
    }).catch(() => {});
    return admission.promise;

    async function execute(): Promise<void> {
      let agent: AgentHandle | undefined;
      const faults = { cancel: false, external: false };
      let run: RunHandle | undefined;
      let cancelStarted = false;
      const cancelActive = async (): Promise<void> => {
        faults.external = true;
        if (cancelStarted || !run?.supports('cancel')) return;
        cancelStarted = true;
        try { await run.cancel(); }
        catch { faults.cancel = true; }
      };
      cancellers.add(cancelActive);
      try {
        const local = localOptions();
        const model = { id: options.model };
        const launched = requested === undefined
          ? await sdk.create({ apiKey: options.apiKey, model, local })
          : await sdk.resume(requested, { apiKey: options.apiKey, model, local });
        agent = launched;
        opened.push(agent);
        if (closed) throw failure();
        if (requested === undefined) {
          if (!agentIdText(agent.agentId) || writers.has(agent.agentId)) throw failure();
          writers.add(agent.agentId);
          trackedId = agent.agentId;
        } else if (agent.agentId !== requested) throw failure();
        run = await agent.send(text);
        admitted = true;
        const turn: CursorTurn = {
          agentId: agent.agentId,
          finished: done.promise,
          async abort() { await cancelActive(); await done.promise; },
        };
        admission.resolve(turn);
        if (closed) await cancelActive();
        const outcome = await consume(run, agent, onEvent, faults, dispose);
        release();
        try { onEvent({ kind: 'ended', outcome }); } catch { /* callback text is discarded */ }
        done.resolve(outcome);
      } catch {
        if (agent !== undefined) { try { await dispose(agent); } catch { /* start still rejects the generic error */ } }
        release();
        if (admitted) {
          try { onEvent({ kind: 'ended', outcome: 'failed' }); } catch { /* discarded */ }
          done.resolve('failed');
        } else admission.reject(failure());
      } finally {
        cancellers.delete(cancelActive);
      }
    }
  }

  async function shutdown(): Promise<void> {
    const stops = [...cancellers];
    for (const stop of stops) { try { await stop(); } catch { /* the turn records the cancel failure */ } }
    await Promise.allSettled([...active]);
    let disposalFailed = false;
    for (const agent of opened) {
      try { await dispose(agent); }
      catch { disposalFailed = true; }
    }
    if (disposalFailed) throw failure();
  }

  return {
    checkReady, readinessReport, start, close() {
      if (closing) return closing;
      closed = true;
      closing = shutdown();
      return closing;
    },
  };
}

async function consume(
  run: RunHandle, agent: AgentHandle, onEvent: (event: CursorEvent) => void,
  faults: { cancel: boolean; external: boolean }, dispose: (agent: AgentHandle) => Promise<void>,
): Promise<CursorOutcome> {
  const state = { text: '', sent: '' };
  let step: Step = 'next';
  let callback = false;
  let streamFailed = false;
  try {
    for await (const message of run.stream()) {
      try { step = publish(message, state, onEvent); }
      catch { callback = true; break; }
      if (step !== 'next') break;
    }
  } catch { if (!faults.external) streamFailed = true; }
  if (callback || step === 'request' || step === 'bad-tool' || step === 'overflow') {
    try { if (run.supports('cancel')) await run.cancel(); }
    catch { faults.cancel = true; }
  }
  let waited = 'error';
  let waitFailed = false;
  try { waited = (await run.wait()).status; }
  catch { waitFailed = true; }
  const forced = step === 'request' || step === 'bad-tool' || step === 'overflow' || streamFailed || faults.cancel || waitFailed;
  let outcome: CursorOutcome = callback && !forced ? (waited === 'cancelled' ? 'interrupted' : 'failed')
    : forced ? 'failed'
    : waited === 'finished' ? 'completed' : waited === 'cancelled' ? 'interrupted' : 'failed';
  if (callback) { try { await dispose(agent); } catch { outcome = 'failed'; } }
  return outcome;
}

/** Append each assistant text block. `@cursor/sdk@1.4.2` delivers one chunk per assistant message. */
function publish(message: unknown, state: { text: string; sent: string }, onEvent: (event: CursorEvent) => void): Step {
  if (!isRecord(message) || typeof message.type !== 'string') return 'next';
  if (message.type === 'assistant') {
    const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : [];
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') state.text += block.text;
    }
    if (Buffer.byteLength(state.text) > SNAPSHOT_LIMIT) return 'overflow';
    if (state.text !== state.sent) {
      state.sent = state.text;
      onEvent({ kind: 'text', text: state.text });
    }
    return 'next';
  }
  if (message.type === 'tool_call') {
    const callId = message.call_id;
    const name = message.name;
    const status = message.status;
    if (!agentIdText(callId) || !toolName(name) || !toolStatus(status)) return 'bad-tool';
    onEvent({ kind: 'tool', callId, name, status });
    return 'next';
  }
  if (message.type === 'request') return 'request';
  return 'next';
}
