import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AdapterError, AdapterIdentity, Outcome } from '../../core/contracts.js';
import { createDispatchOperation } from '../../core/dispatch.js';
import type { DispatchHandle, DispatchIdentity } from '../../core/dispatch.js';
import { createEventStream } from '../../core/events.js';
import type { HostAdapter, HostAdapterError, HostAdapterEvent, HostAdapterRegistration, HostContinueInput,
  HostLaunch, HostOpenOptions, HostRunInput, HostSegmentResult, HostWriteStatus,
} from '../../core/host-adapter.js';
import {
  emitObservation, emitRunStarted, isOptionalObservationListener, jsonString, normalizedUsageFromCounts, segmentTerminal, tokenCount,
  usageFromUncachedCounts,
} from '../../core/run-observation.js';
import type { RunObservation, RunObservationListener, RunObservationUsage } from '../../core/run-observation.js';
import type { SessionReference } from '../../core/sessions.js';
import { sessionLimits } from '../../core/sessions.js';
import { openOpenCodeProtocol } from './protocol.js';
import type { OpenCodeHostChannel, OpenCodeProtocol, OpenCodeRpcOutcome } from './protocol.js';

/** ACP protocol version this adapter speaks. It is not an OpenCode release. */
export const OPENCODE_HOST_ACP_VERSION = '1';
const protocolVersion = 1;
const acknowledgementMs = 15000;
const exitMs = 5000;
const maxPrompt = 1_048_576;
const rejectedUpdate = 'OpenCode sent an update this session cannot accept.';
const incompleteTurn = 'OpenCode turn did not complete.';
const authenticationRequired = 'OpenCode authentication is required.';
const exitUnobserved = 'OpenCode process exit was not observed.';
const exitFailed = 'OpenCode process exit failed.';
const maxFrameBytes = 1_048_576;
const inspectReason = 'OpenCode text sessions do not expose pending host calls.';
const fingerprintReason = 'OpenCode text sessions do not expose a history fingerprint.';
const ignoredUpdates = new Set([
  'usage_update', 'available_commands_update', 'session_info_update', 'current_mode_update',
  'plan', 'agent_thought_chunk', 'user_message_chunk',
]);

export interface OpenCodeHostNativeConfig {
  /** Absolute cwd passed to `session/new` and the host spawn. */
  readonly cwd: string;
  /** Absolute `opencode` executable. The spawn argv is `[executable, 'acp']`. */
  readonly executable: string;
  /** Host-chosen account. It becomes the session binding account. */
  readonly account: string;
}
export interface OpenCodeHostSpawnRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}
export interface OpenCodeHostSpawned {
  readonly channel: OpenCodeHostChannel;
  /** Fulfillment means the host accepts the exit. A non-zero status must reject. The adapter ignores the fulfillment value. */
  readonly processExit: PromiseLike<unknown>;
}
export type OpenCodeHostLaunch = HostLaunch<
  (request: OpenCodeHostSpawnRequest, signal: AbortSignal) => OpenCodeHostSpawned | PromiseLike<OpenCodeHostSpawned>,
  OpenCodeHostChannel>;
export interface OpenCodeHostOpenOptions extends HostOpenOptions<OpenCodeHostLaunch, OpenCodeHostNativeConfig> {
  readonly model: string;
}
export type { OpenCodeHostChannel };

const identity: AdapterIdentity<'opencode'> = Object.freeze({
  engine: 'opencode', adapter: 'opencode-host', version: '1', contractVersion: 1,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function plain(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > limit || /\p{Cs}/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function identifier(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function fail(error: HostAdapterError) {
  return { kind: 'error' as const, error: Object.freeze(error) };
}
function failed(error: SegmentError, write: HostWriteStatus): HostSegmentResult {
  return { kind: 'failed', error, write };
}
const notAttempted: HostWriteStatus = { kind: 'not-attempted' };
type SegmentError = Exclude<HostAdapterError, { readonly code: 'pending-limit' }>;

function nativeOf(value: unknown): OpenCodeHostNativeConfig | undefined {
  if (!record(value)) return undefined;
  const { cwd, executable, account } = value;
  if (typeof cwd !== 'string' || typeof executable !== 'string' || typeof account !== 'string') return undefined;
  if (!isAbsolute(cwd) || cwd !== resolve(cwd) || !isAbsolute(executable) || executable !== resolve(executable)) return undefined;
  if (!identifier(cwd, sessionLimits.identifierLength) || !identifier(executable, sessionLimits.identifierLength)
    || !identifier(account, sessionLimits.identifierLength)) return undefined;
  return { cwd, executable, account };
}
function variablesOf(value: unknown): Record<string, string> | undefined {
  if (!record(value)) return undefined;
  const copy: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    copy[key] = entry;
  }
  return copy;
}
function promptText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxPrompt || value.startsWith('/')) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code <= 31 || (code >= 127 && code <= 159)) return undefined;
  }
  return value;
}
function isHostChannel(value: unknown): value is OpenCodeHostChannel {
  return record(value)
    && typeof value.listen === 'function'
    && typeof value.write === 'function'
    && typeof value.endInput === 'function';
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value && typeof value.then === 'function';
}
function spawnedOf(value: unknown): OpenCodeHostSpawned | undefined {
  if (!record(value) || !isHostChannel(value.channel) || !isPromiseLike(value.processExit)) return undefined;
  return { channel: value.channel, processExit: value.processExit };
}
function modelSelect(value: unknown): boolean {
  if (!record(value) || !Array.isArray(value.configOptions)) return false;
  return value.configOptions.some((entry) => record(entry) && entry.id === 'model' && entry.type === 'select');
}
function currentModel(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.configOptions)) return undefined;
  const option = value.configOptions.find((entry) => record(entry) && entry.id === 'model');
  return record(option) ? option.currentValue : undefined;
}
function modelStillCaller(update: Record<string, unknown>, model: string): boolean {
  if (!Array.isArray(update.configOptions)) return true;
  const option = update.configOptions.find((entry) => record(entry) && entry.id === 'model');
  if (!record(option)) return true;
  return option.currentValue === model;
}
function childMeta(value: unknown): boolean {
  return record(value) && Object.hasOwn(value, 'opencode/child-session');
}
function promptFrameFits(sessionId: string, text: string): boolean {
  const encoded = JSON.stringify({
    jsonrpc: '2.0', id: 2_147_483_647, method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text }] },
  });
  return Buffer.byteLength(encoded) + 1 <= maxFrameBytes;
}
async function releaseSpawn(value: unknown): Promise<void> {
  let detach = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exiting = record(value) && isPromiseLike(value.processExit)
    ? Promise.resolve(value.processExit).then(() => undefined, () => undefined)
    : Promise.resolve();
  try {
    if (!record(value) || !record(value.channel)) return;
    const channel = value.channel;
    if (typeof channel.listen === 'function') {
      try {
        const sink = Object.assign((_chunk: Uint8Array) => {}, { ended() {} });
        const remove = channel.listen(sink);
        if (typeof remove === 'function') detach = remove;
      } catch { /* still end stdin */ }
    }
    if (typeof channel.endInput === 'function') {
      try { channel.endInput(); } catch { /* the adapter does not signal the process */ }
    }
    await Promise.race([
      exiting,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, exitMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { detach(); } catch { /* the sink is already gone */ }
  }
}
function chunkText(update: Record<string, unknown>): string | undefined {
  if (!record(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') return undefined;
  return update.content.text;
}
function itemId(value: unknown): string {
  return identifier(value, sessionLimits.identifierLength) ? value : 'turn';
}
function usageRow(update: Record<string, unknown>): RunObservationUsage | undefined {
  const input = tokenCount(update.inputTokens);
  const output = tokenCount(update.outputTokens);
  const thought = tokenCount(update.thoughtTokens) ?? 0;
  const read = tokenCount(update.cachedReadTokens) ?? 0;
  const write = tokenCount(update.cachedWriteTokens) ?? 0;
  const total = tokenCount(update.totalTokens);
  // OpenCode counts input without cache and output without reasoning, and totals all five buckets.
  if (input !== undefined && output !== undefined && total !== undefined && total === input + output + thought + read + write) {
    return usageFromUncachedCounts({
      input,
      output: output + thought,
      total: input + output + thought + read + write,
      reasoning: thought > 0 ? thought : undefined,
      cacheRead: read > 0 ? read : undefined,
      cacheWrite: write > 0 ? write : undefined,
    });
  }
  return normalizedUsageFromCounts({
    inputTokens: update.inputTokens,
    outputTokens: update.outputTokens,
    totalTokens: update.totalTokens,
    reasoningTokens: update.thoughtTokens,
    cachedInputTokens: update.cachedReadTokens,
    cacheWriteInputTokens: update.cachedWriteTokens,
  });
}
/** The one observed tool update of a turn (the segment fails on it): `started`, then its arguments or its closing phase. */
function toolObservation(update: Record<string, unknown>): readonly RunObservation[] {
  const callId = update.toolCallId;
  if (!identifier(callId, sessionLimits.identifierLength)) return [];
  const name = identifier(update.kind, 64) ? update.kind : 'other';
  const argumentsJson = jsonString(update.rawInput);
  const resultJson = jsonString(update.rawOutput);
  const started: RunObservation = { kind: 'tool', callId, name, phase: 'started' };
  const status = update.status;
  if (status === undefined || status === 'pending' || status === 'in_progress') {
    return argumentsJson === undefined || argumentsJson === '{}' ? [started]
      : [started, { kind: 'tool', callId, name, phase: 'arguments', argumentsJson }];
  }
  if (status !== 'completed' && status !== 'failed') return [];
  return [started, {
    kind: 'tool', callId, name, phase: status === 'completed' ? 'arguments-ended' : 'failed',
    ...(argumentsJson === undefined ? {} : { argumentsJson }), ...(resultJson === undefined ? {} : { resultJson }),
  }];
}
function usageData(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!record(value)) return null;
  return Object.freeze({ ...value });
}
function rpcError(outcome: OpenCodeRpcOutcome): HostAdapterError {
  if (outcome.kind === 'error' && outcome.error.code === -32000) {
    return { code: 'native-failure', message: authenticationRequired };
  }
  if (outcome.kind === 'error') return { code: 'native-failure', message: 'OpenCode rejected the session.' };
  return { code: 'native-failure', message: 'OpenCode did not acknowledge the session.' };
}
type ExitWatch = 'observed' | 'rejected' | 'timeout';

interface PermissionAnswer {
  id: number | string;
  answered: boolean;
}
interface Turn {
  phase: 'intent' | 'native';
  promptWritten: boolean;
  sawTraffic: boolean;
  cancelSent: boolean;
  settled: boolean;
  nativeTerminal: boolean;
  text: string;
  readonly onObservation: RunObservationListener | undefined;
  failure?: SegmentError;
  stopReason?: string;
  usage: unknown;
  resolve: () => void;
  readonly done: Promise<void>;
}
type CompleteSegment = Extract<HostSegmentResult, { kind: 'complete' }>;
type UpdateDecision =
  | 'ignore'
  | 'traffic'
  | 'reject'
  | { readonly kind: 'tool'; readonly update: Record<string, unknown> }
  | { readonly kind: 'text'; readonly text: string; readonly nativeItemId: string };

function readUpdate(params: unknown, context: {
  readonly phase: 'setup' | 'live' | 'closed';
  readonly sessionId: string | undefined;
  readonly modelPinned: boolean;
  readonly model: string;
  readonly turn: Turn | undefined;
}): UpdateDecision {
  if (!record(params) || !record(params.update) || typeof params.update.sessionUpdate !== 'string') return 'reject';
  if (context.sessionId !== undefined && (params.sessionId !== context.sessionId || childMeta(params._meta))) return 'reject';
  const update = params.update;
  const name = update.sessionUpdate;
  if (typeof name !== 'string') return 'reject';
  if (childMeta(update._meta)) return 'reject';
  const active = context.phase === 'live' ? context.turn : undefined;
  const live = active && !active.settled ? active : undefined;
  if (context.phase === 'setup') {
    if (ignoredUpdates.has(name)) return 'ignore';
    if (name === 'config_option_update' && (!context.modelPinned || modelStillCaller(update, context.model))) return 'ignore';
    return 'reject';
  }
  if (!live) {
    if (ignoredUpdates.has(name) || (name === 'config_option_update' && modelStillCaller(update, context.model))) return 'ignore';
    if (name === 'agent_message_chunk' && chunkText(update) !== undefined) return 'ignore';
    return 'reject';
  }
  if (ignoredUpdates.has(name)) return live.promptWritten ? 'traffic' : 'ignore';
  if (name === 'config_option_update') {
    if (!modelStillCaller(update, context.model)) return 'reject';
    return live.promptWritten ? 'traffic' : 'ignore';
  }
  if (name === 'agent_message_chunk') {
    const text = chunkText(update);
    if (text === undefined) return 'reject';
    if (!live.promptWritten || live.failure) return 'ignore';
    return { kind: 'text', text, nativeItemId: itemId(update.messageId) };
  }
  if ((name === 'tool_call' || name === 'tool_call_update') && context.sessionId !== undefined) return { kind: 'tool', update };
  return 'reject';
}

function evidence(recorded: DispatchIdentity) {
  return {
    identity: recorded,
    source: 'native-acknowledgement' as const,
    nativeOperation: null,
    observation: { namespace: 'opencode-acp/turn', schemaVersion: 1, data: null },
  };
}

/**
 * Public OpenCode host adapter. It is the ACP client for one host-spawned `opencode acp` process.
 * It never signals that process, never chooses a model, and fails closed on tools and permissions.
 */
export const opencodeHostAdapter: HostAdapterRegistration<OpenCodeHostOpenOptions, 'opencode'> = Object.freeze({
  identity,
  async open(options: OpenCodeHostOpenOptions, signal: AbortSignal) {
    if (!(signal instanceof AbortSignal)) return fail({ code: 'invalid-input', message: 'open requires an AbortSignal' });
    if (signal.aborted) return fail({ code: 'closed', message: 'open was aborted' });
    let model: unknown;
    let environment: OpenCodeHostOpenOptions['environment'] | undefined;
    let launch: OpenCodeHostOpenOptions['launch'] | undefined;
    let resume: unknown;
    let route: unknown;
    let instructions: unknown;
    let tools: unknown;
    let builtInTools: unknown;
    let subagents: unknown;
    try {
      if (!record(options)) return fail({ code: 'invalid-input', message: 'model must be a caller-supplied id' });
      model = options.model;
      environment = options.environment;
      launch = options.launch;
      resume = options.resume;
      route = options.route;
      instructions = options.instructions;
      tools = options.tools;
      builtInTools = options.builtInTools;
      subagents = options.subagents;
    } catch {
      return fail({ code: 'invalid-input', message: 'OpenCode requires a complete host environment and native config' });
    }
    if (!plain(model, 256)) return fail({ code: 'invalid-input', message: 'model must be a caller-supplied id' });
    const native = nativeOf(environment?.nativeConfig);
    const variables = variablesOf(environment?.variables);
    if (!environment || !native || !variables) {
      return fail({ code: 'invalid-input', message: 'OpenCode requires a complete host environment and native config' });
    }
    if (!launch) return fail({ code: 'unsupported', feature: 'host-launcher', message: 'OpenCode opens only through a host launch' });
    if (launch.kind === 'in-process') return fail({ code: 'unavailable', feature: 'in-process', message: 'OpenCode has no in-process launch' });
    if (launch.kind === 'channel') return fail({ code: 'unavailable', feature: 'channel', message: 'OpenCode has no host channel launch' });
    if (launch.kind !== 'spawn' || typeof launch.spawn !== 'function') {
      return fail({ code: 'invalid-input', message: 'OpenCode opens only through a host spawn' });
    }
    if (resume !== undefined) return fail({ code: 'unsupported', feature: 'session-load', message: 'OpenCode text sessions cannot be resumed' });
    if (route !== undefined) return fail({ code: 'unavailable', feature: 'host-route', message: 'OpenCode text sessions have no host route' });
    if (instructions !== undefined) return fail({ code: 'unavailable', feature: 'instructions', message: 'OpenCode text sessions cannot take host instructions' });
    if (tools !== undefined && (!Array.isArray(tools) || tools.length > 0)) {
      return fail({ code: 'unavailable', feature: 'host-tools', message: 'OpenCode text sessions have no host tools' });
    }
    if (builtInTools !== undefined) return fail({ code: 'unavailable', feature: 'built-in-tools', message: 'OpenCode text sessions cannot switch built-in tools off' });
    if (subagents !== undefined) return fail({ code: 'unavailable', feature: 'subagents', message: 'OpenCode text sessions cannot switch child sessions off' });
    const callerModel = model;
    let raw: unknown;
    try {
      raw = await launch.spawn({ executable: native.executable, args: [native.executable, 'acp'], cwd: native.cwd, env: variables }, signal);
      const parsed = spawnedOf(raw);
      if (!parsed) {
        await releaseSpawn(raw);
        return fail({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher returned no channel' });
      }
      return await openSession({ signal, native, model: callerModel, channel: parsed.channel, processExit: parsed.processExit });
    } catch {
      await releaseSpawn(raw);
      if (signal.aborted) return fail({ code: 'closed', message: 'open was aborted' });
      return fail({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher denied the process' });
    }
  },
});

async function openSession(ready: {
  readonly signal: AbortSignal;
  readonly native: OpenCodeHostNativeConfig;
  readonly model: string;
  readonly channel: OpenCodeHostChannel;
  readonly processExit: PromiseLike<unknown>;
}) {
  const { signal, native, model, channel, processExit } = ready;
  const exitReady = new Promise<ExitWatch>((resolve) => {
    Promise.resolve(processExit).then(() => resolve('observed'), () => resolve('rejected'));
  });
  const stream = createEventStream<HostAdapterEvent>({ maxObservers: 8, capacity: 64 });
  const permissions: PermissionAnswer[] = [];
  let phase: 'setup' | 'live' | 'closed' = 'setup';
  let sessionId: string | undefined;
  let setupError: HostAdapterError | undefined;
  let modelPinned = false;
  let unusable: SegmentError | undefined;
  let turn: Turn | undefined;
  let closePromise: Promise<Outcome<void, AdapterError>> | undefined;
  let shuttingDown: Promise<void> | undefined;
  let protocol: OpenCodeProtocol | undefined;
  let promptArmed = false;
  let trailingCancelSent = false;
  let exitQuiet = false;
  function rpc(): OpenCodeProtocol {
    if (protocol === undefined) throw new Error('OpenCode protocol is not open');
    return protocol;
  }

  function sendCancel(active: Turn): void {
    if (exitQuiet || !sessionId || active.cancelSent || !active.promptWritten) return;
    for (const item of [...permissions]) answerCancelled(item);
    active.cancelSent = true;
    trailingCancelSent = true;
    rpc().notify('session/cancel', { sessionId });
  }
  function answerCancelled(item: PermissionAnswer): void {
    if (item.answered) return;
    item.answered = true;
    rpc().respond(item.id, { outcome: { outcome: 'cancelled' } });
    const index = permissions.indexOf(item);
    if (index >= 0) permissions.splice(index, 1);
  }
  function failActive(active: Turn, error: SegmentError): void {
    if (active.settled) return;
    if (!active.promptWritten) {
      if (active.failure) return;
      unusable ??= error;
      active.failure = error;
      return;
    }
    if (!active.failure) active.failure = error;
    sendCancel(active);
  }
  function watchExit(): Promise<ExitWatch> {
    return new Promise((resolve) => {
      let settled = false;
      const finishWatch = (status: ExitWatch) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(status);
      };
      const timer = setTimeout(() => finishWatch('timeout'), exitMs);
      void exitReady.then((status) => finishWatch(status));
    });
  }
  function retire(error: SegmentError, failTurn: boolean): void {
    if (phase === 'closed') return;
    if (phase === 'setup') {
      void cleanup(error).catch(() => undefined);
      return;
    }
    unusable ??= error;
    if (failTurn && turn && !turn.settled) failActive(turn, error);
    void shutdownChannel().catch(() => undefined);
  }
  function latchExit(status: ExitWatch): void {
    exitQuiet = true;
    const error: SegmentError = {
      code: 'native-failure',
      message: status === 'rejected' ? exitFailed : incompleteTurn,
    };
    if (turn && !turn.settled && !turn.failure) turn.failure = error;
    retire(error, false);
  }
  function markReaderStopped(reason: 'stop' | 'eof' | 'bad-frame' = 'stop'): void {
    retire({ code: 'native-failure', message: incompleteTurn }, false);
    if (reason === 'bad-frame' && turn && !turn.settled && !turn.failure) {
      turn.failure = { code: 'native-failure', message: incompleteTurn };
    }
  }
  function shutdownChannel(): Promise<void> {
    if (!shuttingDown) {
      shuttingDown = (async () => {
        phase = 'closed';
        signal.removeEventListener('abort', onAbort);
        for (const item of [...permissions]) answerCancelled(item);
        const closeAbort = new AbortController();
        void exitReady.then(() => closeAbort.abort()).catch(() => undefined);
        if (sessionId) {
          try {
            await rpc().request('session/close', { sessionId }, { signal: closeAbort.signal, timeoutMs: acknowledgementMs });
          } catch { /* the original error stays */ }
        }
        try { channel.endInput(); } catch { /* the original error stays */ }
      })();
    }
    return shuttingDown;
  }
  async function releaseAfterExit(): Promise<ExitWatch> {
    const watched = await shutdownChannel().then(() => watchExit());
    try { rpc().stop(); } catch { /* the reader is already gone */ }
    try { rpc().releaseReader(); } catch { /* the sink is already gone */ }
    return watched;
  }
  function cleanup(error: HostAdapterError): Promise<HostAdapterError> {
    setupError ??= error;
    return releaseAfterExit().then(() => setupError ?? error);
  }
  function noteDisallowed(): void {
    const error: SegmentError = { code: 'native-failure', message: rejectedUpdate };
    if (phase === 'setup') {
      void cleanup(error).catch(() => undefined);
      return;
    }
    const active = turn;
    if (active && !active.settled) {
      if (active.promptWritten) {
        active.sawTraffic = true;
        failActive(active, error);
        return;
      }
      failActive(active, error);
      if (promptArmed && phase === 'live' && sessionId && !trailingCancelSent) {
        trailingCancelSent = true;
        rpc().notify('session/cancel', { sessionId });
      }
      return;
    }
    unusable ??= error;
    if (promptArmed && phase === 'live' && sessionId && !trailingCancelSent) {
      trailingCancelSent = true;
      rpc().notify('session/cancel', { sessionId });
    }
  }
  /** The turn whose listener may receive observations now: live, prompt written, unsettled, not failed, with a listener. */
  function observingTurn(): Turn | undefined {
    return phase === 'live' && turn && !turn.settled && !turn.failure && turn.promptWritten && turn.onObservation ? turn : undefined;
  }
  function observeQuiet(active: Turn, update: Record<string, unknown>): void {
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const text = chunkText(update);
      if (text !== undefined && text.length > 0) {
        emitObservation(active.onObservation, { kind: 'reasoning', messageId: itemId(update.messageId), mode: 'delta', text });
      }
    }
    // `usage_update` carries only `{ used, size, cost }`, no token counts, so it yields no usage row.
  }
  function handleUpdate(params: unknown): void | 'yield' {
    const decision = readUpdate(params, { phase, sessionId, modelPinned, model, turn });
    if (decision === 'ignore') return;
    if (decision === 'traffic') {
      if (turn && !turn.settled && turn.promptWritten) turn.sawTraffic = true;
      const watcher = observingTurn();
      if (watcher && record(params) && record(params.update)) observeQuiet(watcher, params.update);
      return;
    }
    if (decision === 'reject') {
      noteDisallowed();
      return;
    }
    if (decision.kind === 'tool') {
      const watcher = observingTurn();
      if (watcher) {
        for (const observation of toolObservation(decision.update)) emitObservation(watcher.onObservation, observation);
      }
      noteDisallowed();
      return;
    }
    const active = turn;
    if (!active || active.settled || !active.promptWritten || active.failure) return;
    active.sawTraffic = true;
    if (active.text.length + decision.text.length > maxPrompt) {
      failActive(active, { code: 'native-failure', message: incompleteTurn });
      return;
    }
    active.text += decision.text;
    emitObservation(active.onObservation, { kind: 'text', messageId: decision.nativeItemId, mode: 'delta', text: decision.text });
    const published = stream.publish(Object.freeze({ kind: 'text-delta', nativeItemId: decision.nativeItemId, text: decision.text }));
    if (published.kind === 'closed' || published.disconnected > 0) {
      failActive(active, { code: 'native-failure', message: incompleteTurn });
    }
    return 'yield';
  }

  protocol = openOpenCodeProtocol(channel, {
    onNotification(message) {
      if (message.method !== 'session/update') {
        noteDisallowed();
        return;
      }
      return handleUpdate(message.params);
    },
    onRequest(message) {
      if (message.method === 'session/request_permission') {
        const item = { id: message.id, answered: false };
        const active = observingTurn();
        if (active) {
          const call = record(message.params) && record(message.params.toolCall) ? message.params.toolCall.toolCallId : undefined;
          emitObservation(active.onObservation, {
            kind: 'interrupt', id: identifier(call, sessionLimits.identifierLength) ? call : String(message.id), reason: 'permission',
          });
        }
        permissions.push(item);
        answerCancelled(item);
        noteDisallowed();
        return;
      }
      rpc().respondError(message.id, -32601);
      noteDisallowed();
    },
    onStopped(reason) { markReaderStopped(reason); },
  });
  const onAbort = () => {
    void cleanup({ code: 'closed', message: 'open was aborted' }).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    rpc().start();
  } catch {
    if (shuttingDown) await shuttingDown.catch(() => undefined);
    else await releaseSpawn({ channel, processExit: exitReady });
    return fail(setupError ?? {
      code: 'unavailable',
      feature: 'host-launcher',
      message: 'The host launcher denied the process',
    });
  }
  void exitReady.then((status) => latchExit(status)).catch(() => undefined);

  async function exchange(
    method: string,
    params: unknown,
    accept: (value: unknown) => HostAdapterError | undefined,
    onOutcome?: (outcome: OpenCodeRpcOutcome) => void,
  ): Promise<HostAdapterError | undefined> {
    if (setupError || signal.aborted) return setupError ?? { code: 'closed', message: 'open was aborted' };
    const outcome = await rpc().request(method, params, { signal, timeoutMs: acknowledgementMs, ...(onOutcome ? { onOutcome } : {}) });
    if (setupError) return setupError;
    if (signal.aborted) return { code: 'closed', message: 'open was aborted' };
    if (outcome.kind !== 'result') return rpcError(outcome);
    return accept(outcome.value);
  }

  const handshake = await exchange('initialize', {
    protocolVersion, clientInfo: { name: 'switchboard-opencode-host', version: OPENCODE_HOST_ACP_VERSION }, clientCapabilities: {},
  }, (value) => record(value) && value.protocolVersion === protocolVersion
    ? undefined
    : { code: 'native-failure', message: 'OpenCode ACP protocol version is not 1.' });
  if (handshake) return fail(await cleanup(handshake));
  const created = await exchange('session/new', { cwd: native.cwd, mcpServers: [] }, (value) => {
    if (!record(value) || !identifier(value.sessionId, sessionLimits.opaqueLength)) {
      return { code: 'native-failure', message: 'OpenCode did not return a session.' };
    }
    sessionId = value.sessionId;
    if (!modelSelect(value)) return { code: 'unavailable', feature: 'model', message: 'OpenCode did not offer a model option.' };
    return undefined;
  }, (outcome) => {
    if (outcome.kind === 'result' && record(outcome.value) && identifier(outcome.value.sessionId, sessionLimits.opaqueLength)) {
      sessionId = outcome.value.sessionId;
    }
  });
  if (created) return fail(await cleanup(created));
  const configured = await exchange('session/set_config_option', { sessionId, configId: 'model', value: model }, (value) => (
    currentModel(value) === model ? undefined : { code: 'native-failure', message: 'OpenCode did not apply the caller model.' }
  ), (outcome) => {
    if (outcome.kind === 'result' && currentModel(outcome.value) === model) modelPinned = true;
  });
  if (configured || !sessionId) return fail(await cleanup(configured ?? { code: 'native-failure', message: 'OpenCode did not return a session.' }));
  phase = 'live';
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted || setupError) return fail(await cleanup(setupError ?? { code: 'closed', message: 'open was aborted' }));

  const reference: SessionReference = Object.freeze({
    kind: 'session', formatVersion: 1, opaque: sessionId,
    binding: Object.freeze({
      engine: 'opencode', nativeVersion: OPENCODE_HOST_ACP_VERSION, account: native.account,
      authorizedScope: native.cwd, nativeFormat: 'acp-v1',
    }),
  });

  function classify(active: Turn, recorded: DispatchIdentity): { kind: 'outcome-unknown' } | { kind: 'accepted'; evidence: ReturnType<typeof evidence> } | {
    kind: 'conclusive'; evidence: ReturnType<typeof evidence>; result: CompleteSegment;
  } {
    if (active.promptWritten && !active.failure && (active.stopReason === 'end_turn' || active.stopReason === 'max_tokens')) {
      const result: CompleteSegment = {
        kind: 'complete', session: reference, text: active.text,
        usage: Object.freeze({
          scope: 'segment',
          native: Object.freeze({
            namespace: 'opencode-acp/turn', schemaVersion: 1,
            data: Object.freeze({ stopReason: active.stopReason, usage: usageData(active.usage) }),
          }),
        }),
      };
      return { kind: 'conclusive', evidence: evidence(recorded), result };
    }
    if (active.promptWritten && active.sawTraffic) return { kind: 'accepted', evidence: evidence(recorded) };
    return { kind: 'outcome-unknown' };
  }
  function applyOutcome(active: Turn, outcome: OpenCodeRpcOutcome): void {
    if (active.settled || !active.promptWritten) return;
    if (outcome.kind === 'result' || outcome.kind === 'error') active.nativeTerminal = true;
    if (outcome.kind === 'result') {
      active.sawTraffic = true;
      const stopReason = record(outcome.value) && typeof outcome.value.stopReason === 'string' ? outcome.value.stopReason : '';
      active.stopReason = stopReason;
      active.usage = record(outcome.value) ? outcome.value.usage : null;
      if (!active.failure && stopReason !== 'end_turn' && stopReason !== 'max_tokens') {
        active.failure = { code: 'native-failure', message: incompleteTurn };
      }
      return;
    }
    if (outcome.kind === 'error') {
      active.sawTraffic = true;
      if (!active.failure) {
        active.failure = {
          code: 'native-failure',
          message: outcome.error.code === -32000 ? authenticationRequired : incompleteTurn,
        };
      }
      return;
    }
    if (phase === 'live') retire({ code: 'native-failure', message: incompleteTurn }, false);
    if (active.sawTraffic && !active.failure) active.failure = { code: 'native-failure', message: incompleteTurn };
  }
  function finishTurn(active: Turn): void {
    if (active.settled) return;
    active.settled = true;
    active.resolve();
  }

  async function finish(): Promise<Outcome<void, AdapterError>> {
    const watched = await releaseAfterExit();
    stream.close();
    if (turn && !turn.settled) finishTurn(turn);
    if (watched === 'rejected') return { kind: 'error', error: { code: 'native-failure', message: exitFailed } };
    if (watched === 'timeout') return { kind: 'error', error: { code: 'native-failure', message: exitUnobserved } };
    return { kind: 'ok', value: undefined };
  }

  async function segment(active: Turn, input: HostRunInput, prompt: string): Promise<HostSegmentResult> {
    try {
      let handle: DispatchHandle<CompleteSegment>;
      try {
        handle = createDispatchOperation<CompleteSegment>({
          mode: 'fresh', signal: input.signal, recordIntent: input.recordIntent,
          identity: { hostOperationId: input.hostOperationId, target: { kind: 'session', reference } },
          dispatchNative: async (recorded) => {
            active.phase = 'native';
            if (!active.failure && phase !== 'closed') {
              const onRunAbort = () => {
                if (!active.promptWritten || active.settled) return;
                if (!active.nativeTerminal) sendCancel(active);
                if (!active.failure) active.failure = { code: 'native-failure', message: incompleteTurn };
                retire({ code: 'native-failure', message: incompleteTurn }, false);
              };
              input.signal.addEventListener('abort', onRunAbort);
              try {
                const outcome = await rpc().request('session/prompt', {
                  sessionId, prompt: [{ type: 'text', text: prompt }],
                }, {
                  signal: input.signal,
                  beforeWrite() {
                    active.promptWritten = true;
                    promptArmed = true;
                    emitRunStarted(active.onObservation);
                  },
                  onOutcome(next) { applyOutcome(active, next); },
                });
                applyOutcome(active, outcome);
                // A line queued behind the prompt result can fail the turn before classify.
                // Yielding also lets flushDeferred leave the drain stack.
                await Promise.resolve();
              } finally {
                input.signal.removeEventListener('abort', onRunAbort);
              }
            }
            const observation = classify(active, recorded);
            finishTurn(active);
            return observation;
          },
        });
      } catch {
        return failed({ code: 'invalid-input', message: 'the segment request is malformed' }, notAttempted);
      }
      const snapshot = await handle.run();
      const observation = snapshot.observation;
      if (observation.kind === 'conclusive') return observation.result;
      if (observation.kind === 'not-dispatched') {
        return failed({ code: 'native-failure', message: observation.reason }, observation);
      }
      if (observation.kind === 'accepted') return failed(active.failure ?? { code: 'native-failure', message: incompleteTurn }, observation);
      return failed(active.failure ?? { code: 'native-failure', message: incompleteTurn }, { kind: 'outcome-unknown' });
    } finally {
      finishTurn(active);
      if (turn === active) turn = undefined;
    }
  }

  const adapter: HostAdapter<'opencode'> = {
    identity,
    capabilities: Object.freeze({
      maxPendingPerMessage: 0,
      continuation: 'same-process',
      inspect: Object.freeze({ kind: 'unsupported', reason: inspectReason }),
      fingerprint: Object.freeze({ kind: 'unsupported', reason: fingerprintReason }),
      usage: 'segment',
      toolDeclarations: 'fixed-at-creation',
    }),
    events: Object.freeze({ subscribe: stream.subscribe }),
    continue: (_input: HostContinueInput) => Promise.resolve(failed(
      { code: 'unsupported', feature: 'tool', message: 'OpenCode text sessions do not accept host tools.' },
      notAttempted,
    )),
    async run(input: HostRunInput): Promise<HostSegmentResult> {
      if (input === null || typeof input !== 'object') {
        return failed({ code: 'invalid-input', message: 'the segment request is malformed' }, notAttempted);
      }
      if (closePromise || phase === 'closed') return failed({ code: 'closed', message: 'the adapter is closed' }, notAttempted);
      if (unusable) return failed(unusable, notAttempted);
      if (turn) return failed({ code: 'busy', message: 'a segment is already running' }, notAttempted);
      const onObservation: RunObservationListener | undefined = input.onObservation;
      if (!isOptionalObservationListener(onObservation)) {
        return failed({ code: 'invalid-input', message: 'onObservation must be a function' }, notAttempted);
      }
      const prompt = promptText(input.prompt);
      if (prompt === undefined || !sessionId || !promptFrameFits(sessionId, prompt)) {
        return failed({ code: 'invalid-input', message: 'the prompt must be plain text without a slash command' }, notAttempted);
      }
      let resolveTurn: () => void = () => {};
      const active: Turn = {
        phase: 'intent', promptWritten: false, sawTraffic: false, cancelSent: false, settled: false, nativeTerminal: false, text: '', usage: null,
        onObservation,
        resolve: () => resolveTurn(),
        done: new Promise((resolve) => { resolveTurn = resolve; }),
      };
      turn = active;
      const result = await segment(active, input, prompt);
      if (active.promptWritten && onObservation) {
        const promptUsage = !record(active.usage) ? undefined : usageRow(active.usage);
        if (promptUsage) emitObservation(onObservation, { kind: 'usage', rows: [promptUsage] });
        emitObservation(onObservation, segmentTerminal(result, active.stopReason === 'cancelled' ? 'cancelled' : 'failed'));
      }
      return result;
    },
    async interrupt({ timeoutMs }) {
      const active = turn;
      if (exitQuiet && (!active || !active.nativeTerminal)) return { kind: 'unconfirmed-within-bound' };
      if (!active || active.nativeTerminal) return { kind: 'terminal-observed' };
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return { kind: 'unconfirmed-within-bound' };
      if (active.settled || active.phase === 'intent' || !active.promptWritten) return { kind: 'unconfirmed-within-bound' };
      sendCancel(active);
      const timer = new AbortController();
      const timed = delay(timeoutMs, 'timeout' as const, { signal: timer.signal }).then((value) => value, () => 'timeout' as const);
      const winner = await Promise.race([
        active.done.then(() => active.nativeTerminal ? 'done' as const : 'local' as const),
        timed,
      ]);
      timer.abort();
      return winner === 'done' ? { kind: 'terminal-observed' } : { kind: 'unconfirmed-within-bound' };
    },
    close() {
      if (!closePromise) {
        let settled: ((value: Outcome<void, AdapterError>) => void) | undefined;
        closePromise = new Promise((resolve) => { settled = resolve; });
        void finish().then((value) => { settled?.(value); }, () => {
          settled?.({ kind: 'error', error: { code: 'native-failure', message: exitUnobserved } });
        });
      }
      return closePromise;
    },
  };
  return { kind: 'ok' as const, value: adapter };
}
