import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { callerAgentId, cursorLocalOptions, readCursorOptions, textWithoutControls, type CursorRuntimeOptions } from './config.js';
import { sdk } from './sdk.js';
import { emitObservation, jsonString, normalizeUsage } from '#switchboard';
import type { RunObservationListener, RunObservationUsage } from '#switchboard';

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
  readonly onObservation?: RunObservationListener;
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
const ADMISSION_MS = 30_000;

function limitAdmission<T>(promise: Promise<T>, onLate: (value: T) => void): { promise: Promise<T>; abandon(): void } {
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let giveUp = (): void => {};
  const limited = new Promise<T>((resolve, reject) => {
    giveUp = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(failure());
    };
    timer = setTimeout(giveUp, ADMISSION_MS);
    promise.then((value) => {
      if (settled) { onLate(value); return; }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, () => giveUp());
  });
  return { promise: limited, abandon: () => giveUp() };
}
const writers = new Set<string>();
const unobserved = new Set(['timed_out', 'cancelled', 'unknown', 'not_checked', 'unsupported']);
const refused = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EEXIST', 'EROFS', 'ELOOP']);
const unsupportedFamilies = ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents'] as const;
const TEXT_LIMIT = 1024 * 1024;
const SNAPSHOT_LIMIT = 4 * 1024 * 1024;
const remedies = {
  workspace_unavailable: 'Make the working directory readable and the Cursor session directory writable.',
  retry_check: 'Cursor did not finish the readiness check. Try again.',
  check_cancelled: 'The Cursor readiness check was cancelled.',
  runtime_closed: 'This Cursor runtime is closed.',
  check_unavailable: 'Local Cursor checks passed. Sign-in and version are confirmed when a chat starts.',
} as const;

function toolCallId(value: unknown): string | undefined {
  if (callerAgentId(value)) return value;
  if (typeof value !== 'string') return undefined;
  const splitAt = value.indexOf('\n');
  if (splitAt <= 0 || splitAt >= value.length - 1 || value.indexOf('\n', splitAt + 1) !== -1) return undefined;
  const prefix = value.slice(0, splitAt);
  const suffix = value.slice(splitAt + 1);
  if (prefix.includes(':') || suffix.includes(':')) return undefined;
  const joined = `${prefix}:${suffix}`;
  return callerAgentId(joined) ? joined : undefined;
}

function toolName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  return textWithoutControls(value);
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
  const lateRuns: RunHandle[] = [];
  const disposals = new Map<AgentHandle, Promise<void>>();
  let drained = false;
  const cancellers = new Set<() => Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function dispose(agent: AgentHandle): Promise<void> {
    const existing = disposals.get(agent);
    if (existing) return existing;
    const pending = agent[Symbol.asyncDispose]().then(() => undefined, (error: unknown) => {
      if (disposals.get(agent) === pending) disposals.delete(agent);
      throw error;
    });
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

  function ownLateAgent(late: AgentHandle): void {
    if (!opened.includes(late)) opened.push(late);
    const owner = closing;
    void dispose(late).catch(() => {
      void owner?.then(() => {
        if (closing === owner && !disposals.has(late)) closing = undefined;
      }, () => { /* close() clears closing when shutdown rejects */ });
    });
  }

  function ownLateRun(late: RunHandle): void {
    if (drained) {
      void (async () => {
        try { if (late.supports('cancel')) await late.cancel(); }
        catch { /* this run is not queued for a later close */ }
      })();
      return;
    }
    lateRuns.push(late);
  }

  async function observe(signal?: AbortSignal): Promise<CursorReadinessReport> {
    const halted = (): CursorFacts['workspace'] | undefined =>
      closed ? { state: 'not_checked' } : signal?.aborted ? { state: 'cancelled' } : undefined;
    let stop = halted();
    let workspace: CursorFacts['workspace'] = stop ?? { state: 'accessible' };
    if (stop === undefined) {
      try { await access(options.cwd, constants.R_OK); }
      catch (error) { workspace = { state: workspaceErrno(error) }; }
      stop = halted();
      if (stop !== undefined) workspace = stop;
      else {
        try {
          await mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 });
          await access(options.sessionDirectory, constants.R_OK | constants.W_OK);
        } catch (error) {
          if (workspace.state === 'accessible') workspace = { state: workspaceErrno(error) };
        }
        const afterCreate = halted();
        if (afterCreate !== undefined) workspace = afterCreate;
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
    if (closed || report.facts.workspace.state !== 'accessible') throw failure();
  }

  function readinessReport(readiness?: { readonly signal?: AbortSignal }): Promise<CursorReadinessReport> {
    const signal = readiness?.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(failure());
    return observe(signal);
  }

  function start(request: CursorRequest): Promise<CursorTurn> {
    if (request === null || typeof request !== 'object') return Promise.reject(failure());
    const { text, agentId: requested, onEvent, onObservation } = request;
    if (closed || active.size >= 32 || typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text) > TEXT_LIMIT
      || typeof onEvent !== 'function' || (onObservation !== undefined && typeof onObservation !== 'function') || (requested !== undefined && (!callerAgentId(requested) || writers.has(requested)))) {
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
      let abandonAdmission = (): void => {};
      const cancelActive = async (): Promise<void> => {
        if (!admitted) abandonAdmission();
        if (cancelStarted || !run?.supports('cancel')) return;
        faults.external = true;
        cancelStarted = true;
        try { await run.cancel(); }
        catch { faults.cancel = true; }
      };
      cancellers.add(cancelActive);
      try {
        const local = localOptions();
        const model = { id: options.model };
        const opening = requested === undefined
          ? limitAdmission(sdk.create({ apiKey: options.apiKey, model, local }), ownLateAgent)
          : limitAdmission(sdk.resume(requested, { apiKey: options.apiKey, model, local }), ownLateAgent);
        abandonAdmission = opening.abandon;
        const launched = await opening.promise;
        agent = launched;
        opened.push(agent);
        if (closed) throw failure();
        if (requested === undefined) {
          if (!callerAgentId(agent.agentId) || writers.has(agent.agentId)) throw failure();
          writers.add(agent.agentId);
          trackedId = agent.agentId;
        } else if (agent.agentId !== requested) throw failure();
        const sending = limitAdmission(agent.send(text), ownLateRun);
        abandonAdmission = sending.abandon;
        run = await sending.promise;
        admitted = true;
        emitObservation(onObservation, { kind: 'run-started' });
        for (const family of unsupportedFamilies) emitObservation(onObservation, { kind: 'unsupported', family });
        const turn: CursorTurn = {
          agentId: agent.agentId,
          finished: done.promise,
          async abort() { await cancelActive(); await done.promise; },
        };
        admission.resolve(turn);
        if (closed) await cancelActive();
        const outcome = await consume(run, onEvent, faults, onObservation);
        release();
        emitObservation(onObservation, { kind: 'terminal', outcome: outcome === 'completed' ? 'success' : outcome === 'interrupted' ? 'cancelled' : 'failed' });
        try { onEvent({ kind: 'ended', outcome }); } catch { /* callback text is discarded */ }
        done.resolve(outcome);
      } catch {
        release();
        if (admitted) {
          emitObservation(onObservation, { kind: 'terminal', outcome: 'failed' });
          try { onEvent({ kind: 'ended', outcome: 'failed' }); } catch { /* discarded */ }
          done.resolve('failed');
        } else admission.reject(failure());
        if (agent !== undefined) void dispose(agent).catch(() => { /* uncached; shutdown retries */ });
      } finally {
        cancellers.delete(cancelActive);
      }
    }
  }

  async function shutdown(): Promise<void> {
    const stops = [...cancellers];
    for (const stop of stops) { try { await stop(); } catch { /* the turn records the cancel failure */ } }
    await Promise.allSettled([...active]);
    drained = true;
    const runs = lateRuns.splice(0);
    let cancelFailed = false;
    for (const late of runs) {
      try { if (late.supports('cancel')) await late.cancel(); }
      catch { cancelFailed = true; }
    }
    let disposalFailed = false;
    for (const agent of opened) {
      try { await dispose(agent); }
      catch { disposalFailed = true; }
    }
    if (disposalFailed || cancelFailed) throw failure();
  }

  return {
    checkReady, readinessReport, start, close() {
      closed = true;
      if (!closing) {
        closing = shutdown().then(() => undefined, (error: unknown) => {
          closing = undefined;
          throw error;
        });
      }
      return closing;
    },
  };
}

async function consume(
  run: RunHandle, onEvent: (event: CursorEvent) => void, faults: { cancel: boolean; external: boolean },
  onObservation: RunObservationListener | undefined,
): Promise<CursorOutcome> {
  const state: PublishState = { text: '', sent: '', calls: new Map() };
  let step: Step = 'next';
  let callback = false;
  let streamFailed = false;
  try {
    for await (const message of run.stream()) {
      try { step = publish(message, state, onEvent, onObservation); }
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
  return turnOutcome({ step, callback, streamFailed, waitFailed, faults, waited });
}

function turnOutcome(input: {
  step: Step;
  callback: boolean;
  streamFailed: boolean;
  waitFailed: boolean;
  faults: { cancel: boolean; external: boolean };
  waited: string;
}): CursorOutcome {
  const forced = input.step === 'request' || input.step === 'bad-tool' || input.step === 'overflow'
    || input.streamFailed || input.waitFailed || (input.faults.cancel && input.waited !== 'cancelled');
  let outcome: CursorOutcome = forced ? 'failed'
    : input.waited === 'finished' ? 'completed'
    : input.waited === 'cancelled' ? 'interrupted'
    : 'failed';
  if (input.callback && !(input.faults.external && input.waited === 'cancelled')) outcome = 'failed';
  return outcome;
}

interface PublishState {
  text: string;
  sent: string;
  /** Per callId: whether `started` and the arguments were already observed. Only filled when a listener is present. */
  readonly calls: Map<string, { argumentsSent: boolean }>;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function observedUsage(value: unknown): RunObservationUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = finiteCount(value.inputTokens);
  const outputTokens = finiteCount(value.outputTokens);
  const totalTokens = finiteCount(value.totalTokens);
  const row: { -readonly [K in keyof RunObservationUsage]: RunObservationUsage[K] } = {};
  if (inputTokens !== undefined) row.inputTokens = inputTokens;
  if (outputTokens !== undefined) row.outputTokens = outputTokens;
  const cachedInputTokens = finiteCount(value.cacheReadTokens);
  if (cachedInputTokens !== undefined) row.cachedInputTokens = cachedInputTokens;
  const cacheWriteInputTokens = finiteCount(value.cacheWriteTokens);
  if (cacheWriteInputTokens !== undefined) row.cacheWriteInputTokens = cacheWriteInputTokens;
  const reasoningTokens = finiteCount(value.reasoningTokens);
  if (reasoningTokens !== undefined) row.reasoningTokens = reasoningTokens;
  if (totalTokens !== undefined && inputTokens !== undefined && outputTokens !== undefined && totalTokens === inputTokens + outputTokens) {
    row.totalTokens = totalTokens;
  }
  return Object.keys(row).length === 0 ? undefined : normalizeUsage(row);
}

function observeTool(message: Record<string, unknown>, callId: string, name: string, status: CursorToolStatus,
  state: PublishState, onObservation: RunObservationListener): void {
  let call = state.calls.get(callId);
  if (call === undefined) {
    call = { argumentsSent: false };
    state.calls.set(callId, call);
    emitObservation(onObservation, { kind: 'tool', callId, name, phase: 'started' });
  }
  if (message.args !== undefined && !call.argumentsSent) {
    const argumentsJson = jsonString(message.args);
    if (argumentsJson !== undefined) {
      call.argumentsSent = true;
      emitObservation(onObservation, { kind: 'tool', callId, name, phase: 'arguments', argumentsJson });
    }
  }
  if (status === 'running') return;
  const resultJson = message.result !== undefined ? jsonString(message.result)
    : typeof message.error === 'string' ? jsonString(message.error) : undefined;
  emitObservation(onObservation, {
    kind: 'tool', callId, name, phase: status === 'completed' ? 'completed' : 'failed',
    ...(resultJson === undefined ? {} : { resultJson }),
  });
}

/**
 * Append each assistant text block. `@cursor/sdk@1.4.2` delivers one chunk per assistant message.
 * The listener sees the same accumulated text as a snapshot. Thinking messages are chunks, so they are observed as deltas.
 */
function publish(message: unknown, state: PublishState, onEvent: (event: CursorEvent) => void,
  onObservation: RunObservationListener | undefined): Step {
  if (!isRecord(message) || typeof message.type !== 'string') return 'next';
  if (message.type === 'assistant') {
    const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
      if (Buffer.byteLength(state.text) + Buffer.byteLength(block.text) > SNAPSHOT_LIMIT) return 'overflow';
      state.text += block.text;
    }
    if (state.text !== state.sent) {
      state.sent = state.text;
      emitObservation(onObservation, { kind: 'text', messageId: 'assistant', mode: 'snapshot', text: state.text });
      onEvent({ kind: 'text', text: state.text });
    }
    return 'next';
  }
  if (message.type === 'thinking') {
    if (typeof message.text === 'string' && message.text.length > 0) {
      emitObservation(onObservation, { kind: 'reasoning', messageId: 'reasoning', mode: 'delta', text: message.text });
    }
    return 'next';
  }
  if (message.type === 'usage') {
    const row = observedUsage(message.usage);
    if (row !== undefined) emitObservation(onObservation, { kind: 'usage', rows: [row] });
    return 'next';
  }
  if (message.type === 'tool_call') {
    const callId = toolCallId(message.call_id);
    const name = message.name;
    const status = message.status;
    if (callId === undefined || !toolName(name) || !toolStatus(status)) return 'bad-tool';
    if (onObservation) observeTool(message, callId, name, status, state, onObservation);
    onEvent({ kind: 'tool', callId, name, status });
    return 'next';
  }
  if (message.type === 'request') return 'request';
  return 'next';
}
