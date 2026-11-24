import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { callerAgentId, CursorTextPolicyUnsupportedError, readCursorOptions, textWithoutControls, type CursorRuntimeOptions } from './config.js';
import { buildCursorLaunchOptions, cursorTextPolicy, sdk, type CursorPolicy } from './sdk.js';
import type { CursorMessage } from './sdk.js';
import { createCursorModels } from './models.js';
import type { CursorModelsApi } from './models.js';
export type { CursorModel, CursorModelsApi, CursorModelsError } from './models.js';
import { hostImageLimits, parseHostImages, createToolTracker, emitObservation, emitRunStarted, isOptionalObservationListener, jsonString, normalizedUsageFromCounts, runtimeOutcome } from '#switchboard';
import type { Capability, HostImageInput, HostImageInputApi, RunObservationListener, RunObservationUsage, ToolTracker } from '#switchboard';

export type { CursorRuntimeOptions } from './config.js';
export { CursorTextPolicyUnsupportedError } from './config.js';

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
  readonly images?: readonly HostImageInput[];
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
  readonly imageInput: Capability<HostImageInputApi>;
  readonly models: Capability<CursorModelsApi>;
  checkReady(): Promise<void>;
  readinessReport(options?: { readonly signal?: AbortSignal }): Promise<CursorReadinessReport>;
  start(request: CursorRequest): Promise<CursorTurn>;
  close(): Promise<void>;
}

const failure = () => new Error('Cursor operation failed.');
const ADMISSION_MS = 30_000;

function limitAdmission<T>(promise: Promise<T>, onLate: (value: T) => void, deadline: number): { promise: Promise<T>; abandon(): void } {
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
    timer = setTimeout(giveUp, Math.max(0, deadline - performance.now()));
    promise.then((value) => {
      if (performance.now() >= deadline) giveUp();
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

type AgentHandle = Awaited<ReturnType<typeof sdk.create>>;
type RunHandle = Awaited<ReturnType<AgentHandle['send']>>;

export function createCursorRuntime(input: CursorRuntimeOptions): CursorRuntime {
  return createCursorRuntimeForPolicy(input, 'generic');
}

/** Resume only host-owned sessions created under this text contract. */
export function createCursorTextRuntime(input: CursorRuntimeOptions): CursorRuntime {
  return createCursorRuntimeForPolicy(input, 'text');
}

function createCursorRuntimeForPolicy(input: CursorRuntimeOptions, kind: CursorPolicy['kind']): CursorRuntime {
  const read = readCursorOptions(input);
  if (!read) throw failure();
  const options: CursorRuntimeOptions = read;
  const policy: CursorPolicy = kind === 'text' ? cursorTextPolicy() : { kind: 'generic' };
  const bindings = policy.kind === 'text' ? policy.support : sdk;
  const active = new Set<Promise<void>>();
  const slots = new Set<symbol>();
  const sendingAgents = new Set<AgentHandle>();
  const opened: AgentHandle[] = [];
  const lateRuns = new Set<() => Promise<void>>();
  const disposals = new Map<AgentHandle, Promise<void>>();
  const cancellers = new Set<() => Promise<void>>();
  let closed = false;
  let cleanupEpoch = 0;
  let closing: { readonly epoch: number; readonly promise: Promise<void> } | undefined;
  const catalog = createCursorModels(() => bindings.listModels({ apiKey: options.apiKey }));

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

  function ownLateAgent(late: AgentHandle): void {
    if (!opened.includes(late)) opened.push(late);
    cleanupEpoch += 1;
    void dispose(late).catch(() => { /* uncached; a later close retries */ });
  }

  function ownLateRun(late: RunHandle, agent: AgentHandle, onDrained: () => void): void {
    let pending: Promise<void> | undefined;
    const drain = (): Promise<void> => {
      if (!pending) pending = (async () => {
        if (late.supports('cancel')) await late.cancel();
        const { status } = await late.wait();
        if (status !== 'finished' && status !== 'cancelled' && status !== 'error') throw failure();
        await dispose(agent);
        sendingAgents.delete(agent);
        lateRuns.delete(drain);
        onDrained();
      })().catch((error: unknown) => { pending = undefined; throw error; });
      return pending;
    };
    lateRuns.add(drain);
    cleanupEpoch += 1;
    void drain().catch(() => { /* retained; a later close retries */ });
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
    try {
      const signal = readiness?.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(failure());
      return observe(signal === undefined ? undefined : AbortSignal.any([signal]));
    } catch { return Promise.reject(failure()); }
  }

  function start(request: CursorRequest): Promise<CursorTurn> {
    if (request === null || typeof request !== 'object') return Promise.reject(failure());
    let captured: Pick<CursorRequest, 'text' | 'agentId' | 'onEvent' | 'onObservation'>;
    let images: ReturnType<typeof parseHostImages>;
    try {
      const { text, agentId, onEvent, onObservation, images: value } = request;
      captured = { text, onEvent, ...(agentId === undefined ? {} : { agentId }), ...(onObservation === undefined ? {} : { onObservation }) };
      images = parseHostImages(value === undefined ? [] : value);
    }
    catch { return Promise.reject(failure()); }
    const { text, agentId: requested, onEvent, onObservation } = captured;
    if (images.kind === 'error' || (policy.kind === 'text' && images.value.length > 0)) return Promise.reject(failure());
    const message: CursorMessage = images.value.length === 0 ? text : { text,
      images: images.value.map((image) => ({ data: image.base64, mimeType: image.mediaType })) };
    if (closed || slots.size >= 32 || typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text) > TEXT_LIMIT
      || typeof onEvent !== 'function' || !isOptionalObservationListener(onObservation) || (requested !== undefined && (!callerAgentId(requested) || writers.has(requested)))) {
      return Promise.reject(failure());
    }
    const slot = Symbol();
    slots.add(slot);
    let trackedId = requested;
    // Fulfillment alone does not release a timed-out send; its late run must drain.
    let openingUndrained = false;
    let sendUndrained = false;
    let sendOwnsWriter = false;
    if (requested !== undefined) writers.add(requested);
    const release = (): void => {
      if (sendOwnsWriter && (openingUndrained || sendUndrained)) return;
      slots.delete(slot);
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
      let cancelling: Promise<void> | undefined;
      let completed = false;
      let policyRefusal: CursorTextPolicyUnsupportedError | undefined;
      let abandonAdmission = (): void => {};
      const cancelActive = (): Promise<void> => {
        if (!admitted) abandonAdmission();
        if (cancelling) return cancelling;
        if (completed || !run?.supports('cancel')) return Promise.resolve();
        faults.external = true;
        const current = run;
        cancelling = Promise.resolve().then(() => current.cancel()).catch(() => { faults.cancel = true; });
        return cancelling;
      };
      cancellers.add(cancelActive);
      try {
        let launch: ReturnType<typeof buildCursorLaunchOptions>;
        try { launch = buildCursorLaunchOptions(options, policy); }
        catch (error) {
          if (policy.kind === 'text' && error instanceof CursorTextPolicyUnsupportedError) policyRefusal = new CursorTextPolicyUnsupportedError();
          throw failure();
        }
        const openDeadline = performance.now() + ADMISSION_MS;
        const nativeOpen = requested === undefined ? bindings.create(launch) : bindings.resume(requested, launch);
        openingUndrained = true;
        const openSettled = () => { openingUndrained = false; if (sendOwnsWriter) release(); };
        void nativeOpen.then(openSettled, openSettled);
        const opening = limitAdmission(nativeOpen, ownLateAgent, openDeadline);
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
        sendingAgents.add(launched);
        let nativeSend: Promise<RunHandle>;
        const sendDeadline = performance.now() + ADMISSION_MS;
        try { nativeSend = agent.send(message); }
        catch (error) { sendingAgents.delete(launched); throw error; }
        sendUndrained = true;
        void nativeSend.then(undefined, () => {
          sendingAgents.delete(launched);
          sendUndrained = false;
          release();
          if (sendOwnsWriter) ownLateAgent(launched);
        });
        const sending = limitAdmission(nativeSend, (late) => ownLateRun(late, launched, () => { sendUndrained = false; release(); }), sendDeadline);
        abandonAdmission = sending.abandon;
        const sent = await sending.promise;
        if (closed) {
          ownLateRun(sent, launched, () => { sendUndrained = false; release(); });
          throw failure();
        }
        run = sent;
        sendingAgents.delete(launched);
        admitted = true;
        emitRunStarted(onObservation);
        const turn: CursorTurn = {
          agentId: agent.agentId,
          finished: done.promise,
          async abort() { await cancelActive(); await done.promise; },
        };
        admission.resolve(turn);
        if (closed) await cancelActive();
        let outcome = await consume(run, onEvent, faults, onObservation, policy.kind);
        completed = true;
        await cancelling;
        if (faults.cancel && outcome !== 'interrupted') outcome = 'failed';
        release();
        emitObservation(onObservation, { kind: 'terminal', outcome: runtimeOutcome[outcome] });
        try { onEvent({ kind: 'ended', outcome }); } catch { /* callback text is discarded */ }
        done.resolve(outcome);
      } catch {
        completed = true;
        await cancelling;
        if (!admitted && (openingUndrained || sendUndrained)) sendOwnsWriter = true;
        release();
        if (admitted) {
          emitObservation(onObservation, { kind: 'terminal', outcome: 'failed' });
          try { onEvent({ kind: 'ended', outcome: 'failed' }); } catch { /* discarded */ }
          done.resolve('failed');
        } else admission.reject(policyRefusal ?? failure());
        if (agent !== undefined && !sendUndrained) void dispose(agent).catch(() => { /* uncached; shutdown retries */ });
      } finally {
        cancellers.delete(cancelActive);
      }
    }
  }

  async function shutdown(): Promise<void> {
    const stops = [...cancellers];
    await Promise.allSettled(stops.map(async stop => { await stop(); }));
    await Promise.allSettled([...active]);
    let cancelFailed = false;
    const attempted = new Set<() => Promise<void>>();
    async function drainKnownRuns(): Promise<void> {
      for (const drain of lateRuns) {
        if (attempted.has(drain)) continue;
        attempted.add(drain);
        try { await drain(); } catch { cancelFailed = true; }
      }
    }
    let disposalFailed = false;
    let observedEpoch: number;
    do {
      observedEpoch = cleanupEpoch;
      await drainKnownRuns();
      for (const agent of opened) {
        if (sendingAgents.has(agent)) continue;
        try { await dispose(agent); }
        catch { disposalFailed = true; }
      }
      await drainKnownRuns();
    } while (observedEpoch !== cleanupEpoch);
    if (disposalFailed || cancelFailed) throw failure();
  }

  return {
    imageInput: policy.kind === 'text' ? { kind: 'unsupported', reason: 'Cursor text runtime accepts text only.' }
      : { kind: 'supported', api: hostImageLimits }, models: { kind: 'supported', api: catalog.api },
    checkReady, readinessReport, start, close() {
      closed = true;
      catalog.close();
      const epoch = cleanupEpoch;
      if (closing?.epoch === epoch) return closing.promise;
      const previous = closing?.promise;
      const work = previous ? previous.then(shutdown, shutdown) : shutdown();
      const promise = work.catch((error: unknown) => {
        if (closing?.promise === promise) closing = undefined;
        throw error;
      });
      closing = { epoch, promise };
      return promise;
    },
  };
}

async function consume(
  run: RunHandle, onEvent: (event: CursorEvent) => void, faults: { cancel: boolean; external: boolean },
  onObservation: RunObservationListener | undefined, policy: CursorPolicy['kind'],
): Promise<CursorOutcome> {
  const state: PublishState = { text: '', sent: '', reasoningStep: 0, reasoningOpen: false, trackTool: createToolTracker() };
  let step: Step = 'next';
  let callback = false;
  let streamFailed = false;
  try {
    for await (const message of run.stream()) {
      try { step = publish(message, state, onEvent, onObservation, policy); }
      catch { callback = true; break; }
      if (step !== 'next') break;
    }
  } catch { streamFailed = true; }
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
    || (input.streamFailed && !(input.faults.external && input.waited === 'cancelled')) || input.waitFailed || (input.faults.cancel && input.waited !== 'cancelled');
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
  /** Reasoning step number; bumps when assistant text or a tool call follows reasoning. */
  reasoningStep: number;
  reasoningOpen: boolean;
  /** Emits each call's `started` and arguments once. */
  readonly trackTool: ToolTracker;
}

function observedUsage(value: unknown): RunObservationUsage | undefined {
  if (!isRecord(value)) return undefined;
  return normalizedUsageFromCounts({
    inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cachedInputTokens: value.cacheReadTokens,
    cacheWriteInputTokens: value.cacheWriteTokens,
    reasoningTokens: value.reasoningTokens,
    totalTokens: value.totalTokens,
  });
}

function observeTool(message: Record<string, unknown>, callId: string, name: string, status: CursorToolStatus,
  track: ToolTracker, onObservation: RunObservationListener): void {
  const argumentsJson = message.args === undefined ? undefined : jsonString(message.args);
  for (const observation of track(callId, name, argumentsJson)) emitObservation(onObservation, observation);
  if (status === 'running') return;
  const resultJson = message.result !== undefined ? jsonString(message.result)
    : typeof message.error === 'string' ? jsonString(message.error) : undefined;
  emitObservation(onObservation, {
    kind: 'tool', callId, name, phase: status === 'completed' ? 'completed' : 'failed',
    ...(argumentsJson === undefined ? {} : { argumentsJson }),
    ...(resultJson === undefined ? {} : { resultJson }),
  });
}

function endReasoning(state: PublishState): void {
  if (!state.reasoningOpen) return;
  state.reasoningOpen = false;
  state.reasoningStep += 1;
}

/**
 * Append each assistant text block. `@cursor/sdk@1.4.2` delivers one chunk per assistant message.
 * The listener sees the same accumulated text as a snapshot. Thinking messages are chunks, so they are observed as deltas.
 */
function publish(message: unknown, state: PublishState, onEvent: (event: CursorEvent) => void,
  onObservation: RunObservationListener | undefined, policy: CursorPolicy['kind']): Step {
  if (!isRecord(message) || typeof message.type !== 'string') return 'next';
  if (policy === 'text' && (message.type === 'tool_call' || message.type === 'task')) return 'bad-tool';
  if (message.type === 'assistant') {
    const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : [];
    if (policy === 'text' && content.some(block => isRecord(block) && block.type === 'tool_use')) return 'bad-tool';
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
      if (Buffer.byteLength(state.text) + Buffer.byteLength(block.text) > SNAPSHOT_LIMIT) return 'overflow';
      state.text += block.text;
    }
    if (content.some((block) => isRecord(block) && block.type === 'text')) endReasoning(state);
    if (state.text !== state.sent) {
      state.sent = state.text;
      emitObservation(onObservation, { kind: 'text', messageId: 'assistant', mode: 'snapshot', text: state.text });
      onEvent({ kind: 'text', text: state.text });
    }
    return 'next';
  }
  if (message.type === 'thinking') {
    if (typeof message.text === 'string' && message.text.length > 0) {
      state.reasoningOpen = true;
      emitObservation(onObservation, { kind: 'reasoning', messageId: `reasoning:${state.reasoningStep}`, mode: 'delta', text: message.text });
    }
    return 'next';
  }
  if (message.type === 'usage') {
    if (onObservation) {
      try {
        const row = observedUsage(message.usage);
        if (row !== undefined) emitObservation(onObservation, { kind: 'usage', rows: [row] });
      } catch { /* observation only */ }
    }
    return 'next';
  }
  if (message.type === 'tool_call') {
    const callId = toolCallId(message.call_id);
    const name = message.name;
    const status = message.status;
    if (callId === undefined || !toolName(name) || !toolStatus(status)) return 'bad-tool';
    endReasoning(state);
    if (onObservation) {
      try { observeTool(message, callId, name, status, state.trackTool, onObservation); } catch { /* observation only */ }
    }
    onEvent({ kind: 'tool', callId, name, status });
    return 'next';
  }
  if (message.type === 'request') return 'request';
  return 'next';
}
