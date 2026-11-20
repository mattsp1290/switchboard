import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AdapterError, AdapterIdentity, Outcome } from '../../core/contracts.js';
import { createDispatchOperation } from '../../core/dispatch.js';
import type { DispatchIdentity } from '../../core/dispatch.js';
import { createEventStream } from '../../core/events.js';
import type { HostAdapter, HostAdapterError, HostAdapterEvent, HostAdapterRegistration, HostContinueInput,
  HostLaunch, HostOpenOptions, HostRunInput, HostSegmentResult, HostWriteStatus,
} from '../../core/host-adapter.js';
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
  if (!identifier(cwd, sessionLimits.identifierLength) || !identifier(account, sessionLimits.identifierLength)) return undefined;
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
function spawnedOf(value: unknown): OpenCodeHostSpawned | undefined {
  if (!record(value) || !record(value.channel)) return undefined;
  const { listen, write, endInput } = value.channel;
  const processExit = value.processExit;
  if (typeof listen !== 'function' || typeof write !== 'function' || typeof endInput !== 'function') return undefined;
  if (!record(processExit) && typeof processExit !== 'object') return undefined;
  if (typeof (processExit as { then?: unknown } | null)?.then !== 'function') return undefined;
  return { channel: value.channel as unknown as OpenCodeHostChannel, processExit: processExit as PromiseLike<unknown> };
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
  if (!Array.isArray(update.configOptions)) return false;
  return update.configOptions.some((entry) => record(entry) && entry.id === 'model' && entry.currentValue === model);
}
function childSession(update: Record<string, unknown>): boolean {
  return record(update._meta) && Object.hasOwn(update._meta, 'opencode/child-session');
}
function chunkText(update: Record<string, unknown>): string | undefined {
  if (!record(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') return undefined;
  return update.content.text;
}
function itemId(value: unknown): string {
  return identifier(value, sessionLimits.identifierLength) ? value : 'turn';
}
function usageData(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  return { ...value };
}
function rpcError(outcome: OpenCodeRpcOutcome): HostAdapterError {
  if (outcome.kind === 'error' && outcome.error.code === -32000) {
    return { code: 'native-failure', message: authenticationRequired };
  }
  if (outcome.kind === 'error') return { code: 'native-failure', message: 'OpenCode rejected the session.' };
  return { code: 'native-failure', message: 'OpenCode did not acknowledge the session.' };
}
function observeExit(processExit: PromiseLike<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (observed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(observed);
    };
    const timer = setTimeout(() => finish(false), exitMs);
    Promise.resolve(processExit).then(() => finish(true), () => finish(false));
  });
}

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
  text: string;
  failure?: SegmentError;
  stopReason?: string;
  usage: unknown;
  resolve: () => void;
  readonly done: Promise<void>;
}
type CompleteSegment = Extract<HostSegmentResult, { kind: 'complete' }>;

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
    if (!record(options) || !plain(options.model, 256)) return fail({ code: 'invalid-input', message: 'model must be a caller-supplied id' });
    const native = nativeOf(options.environment?.nativeConfig);
    const variables = variablesOf(options.environment?.variables);
    if (!options.environment || !native || !variables) {
      return fail({ code: 'invalid-input', message: 'OpenCode requires a complete host environment and native config' });
    }
    const launch = options.launch;
    if (!launch) return fail({ code: 'unsupported', feature: 'host-launcher', message: 'OpenCode opens only through a host launch' });
    if (launch.kind === 'in-process') return fail({ code: 'unavailable', feature: 'in-process', message: 'OpenCode has no in-process launch' });
    if (launch.kind === 'channel') return fail({ code: 'unavailable', feature: 'channel', message: 'OpenCode has no host channel launch' });
    if (launch.kind !== 'spawn' || typeof launch.spawn !== 'function') {
      return fail({ code: 'invalid-input', message: 'OpenCode opens only through a host spawn' });
    }
    if (options.resume !== undefined) return fail({ code: 'unsupported', feature: 'session-load', message: 'OpenCode text sessions cannot be resumed' });
    if (options.route !== undefined) return fail({ code: 'unavailable', feature: 'host-route', message: 'OpenCode text sessions have no host route' });
    if (options.instructions !== undefined) return fail({ code: 'unavailable', feature: 'instructions', message: 'OpenCode text sessions cannot take host instructions' });
    if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length > 0)) {
      return fail({ code: 'unavailable', feature: 'host-tools', message: 'OpenCode text sessions have no host tools' });
    }
    if (options.builtInTools !== undefined) return fail({ code: 'unavailable', feature: 'built-in-tools', message: 'OpenCode text sessions cannot switch built-in tools off' });
    if (options.subagents !== undefined) return fail({ code: 'unavailable', feature: 'subagents', message: 'OpenCode text sessions cannot switch child sessions off' });
    const model = options.model;
    let spawned: OpenCodeHostSpawned;
    try {
      const raw = await launch.spawn({ executable: native.executable, args: [native.executable, 'acp'], cwd: native.cwd, env: variables }, signal);
      const parsed = spawnedOf(raw);
      if (!parsed) return fail({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher returned no channel' });
      spawned = parsed;
    } catch {
      if (signal.aborted) return fail({ code: 'closed', message: 'open was aborted' });
      return fail({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher denied the process' });
    }
    return openSession({ signal, native, model, channel: spawned.channel, processExit: spawned.processExit });
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
  const stream = createEventStream<HostAdapterEvent>({ maxObservers: 8, capacity: 64 });
  const permissions: PermissionAnswer[] = [];
  let phase: 'setup' | 'live' | 'closed' = 'setup';
  let sessionId: string | undefined;
  let setupError: HostAdapterError | undefined;
  let cleaned = false;
  let unusable: SegmentError | undefined;
  let turn: Turn | undefined;
  let closePromise: Promise<Outcome<void, AdapterError>> | undefined;
  let protocol: OpenCodeProtocol = undefined as unknown as OpenCodeProtocol;

  function sendCancel(active: Turn): void {
    if (!sessionId || active.cancelSent || !active.promptWritten) return;
    for (const item of permissions) answerCancelled(item);
    active.cancelSent = true;
    protocol.notify('session/cancel', { sessionId });
  }
  function answerCancelled(item: PermissionAnswer): void {
    if (item.answered) return;
    item.answered = true;
    protocol.respond(item.id, { outcome: { outcome: 'cancelled' } });
  }
  function rejectTurn(active: Turn, error: SegmentError): void {
    if (active.settled || active.failure) return;
    active.sawTraffic = true;
    active.failure = error;
    sendCancel(active);
  }
  function cleanup(error: HostAdapterError): HostAdapterError {
    if (cleaned) return setupError ?? error;
    cleaned = true;
    setupError ??= error;
    phase = 'closed';
    try {
      if (sessionId) protocol.request('session/close', { sessionId }, { signal: new AbortController().signal, timeoutMs: acknowledgementMs });
    } catch { /* the original open error stays */ }
    try { channel.endInput(); } catch { /* the original open error stays */ }
    protocol.stop();
    return setupError;
  }
  function failSetup(error: HostAdapterError): void {
    if (phase !== 'setup') return;
    cleanup(error);
  }
  function noteIncoming(): void {
    if (phase === 'setup') {
      failSetup({ code: 'native-failure', message: rejectedUpdate });
      return;
    }
    if (turn && !turn.settled) {
      rejectTurn(turn, { code: 'native-failure', message: rejectedUpdate });
      return;
    }
    unusable ??= { code: 'native-failure', message: rejectedUpdate };
  }
  function handleUpdate(params: unknown): void | 'yield' {
    if (!record(params) || !record(params.update) || typeof params.update.sessionUpdate !== 'string') {
      if (phase === 'setup') failSetup({ code: 'native-failure', message: rejectedUpdate });
      else if (turn && !turn.settled) rejectTurn(turn, { code: 'native-failure', message: rejectedUpdate });
      else unusable ??= { code: 'native-failure', message: rejectedUpdate };
      return;
    }
    const update = params.update;
    const name = update.sessionUpdate;
    if (typeof name !== 'string') return;
    if (childSession(update)) {
      if (phase === 'setup') failSetup({ code: 'native-failure', message: rejectedUpdate });
      else if (turn && !turn.settled) rejectTurn(turn, { code: 'native-failure', message: rejectedUpdate });
      else unusable ??= { code: 'native-failure', message: rejectedUpdate };
      return;
    }
    if (phase === 'setup') {
      if (ignoredUpdates.has(name) || name === 'config_option_update') return;
      failSetup({ code: 'native-failure', message: rejectedUpdate });
      return;
    }
    const active = turn;
    if (!active || active.settled) return;
    active.sawTraffic = true;
    if (ignoredUpdates.has(name)) return;
    if (name === 'config_option_update') {
      if (!modelStillCaller(update, model)) rejectTurn(active, { code: 'native-failure', message: rejectedUpdate });
      return;
    }
    if (name === 'agent_message_chunk') {
      if (active.failure) return;
      const text = chunkText(update);
      if (text === undefined) {
        rejectTurn(active, { code: 'native-failure', message: rejectedUpdate });
        return;
      }
      if (!active.promptWritten) return;
      active.text += text;
      stream.publish(Object.freeze({ kind: 'text-delta', nativeItemId: itemId(update.messageId), text }));
      return 'yield';
    }
    rejectTurn(active, { code: 'native-failure', message: rejectedUpdate });
  }

  protocol = openOpenCodeProtocol(channel, {
    onNotification(message) {
      if (message.method !== 'session/update') {
        if (phase === 'setup') failSetup({ code: 'native-failure', message: rejectedUpdate });
        else if (turn && !turn.settled) rejectTurn(turn, { code: 'native-failure', message: rejectedUpdate });
        return;
      }
      return handleUpdate(message.params);
    },
    onRequest(message) {
      if (message.method === 'session/request_permission') {
        const item = { id: message.id, answered: false };
        permissions.push(item);
        answerCancelled(item);
        noteIncoming();
        return;
      }
      protocol.respondError(message.id, -32601);
      noteIncoming();
    },
  });
  protocol.start();

  const onAbort = () => failSetup({ code: 'closed', message: 'open was aborted' });
  signal.addEventListener('abort', onAbort, { once: true });

  async function exchange(method: string, params: unknown, accept: (value: unknown) => HostAdapterError | undefined): Promise<HostAdapterError | undefined> {
    if (setupError || signal.aborted) return setupError ?? { code: 'closed', message: 'open was aborted' };
    const outcome = await protocol.request(method, params, { signal, timeoutMs: acknowledgementMs });
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
  if (handshake) return fail(cleanup(handshake));
  const created = await exchange('session/new', { cwd: native.cwd, mcpServers: [] }, (value) => {
    if (!record(value) || !identifier(value.sessionId, sessionLimits.opaqueLength)) {
      return { code: 'native-failure', message: 'OpenCode did not return a session.' };
    }
    sessionId = value.sessionId;
    if (!modelSelect(value)) return { code: 'unavailable', feature: 'model', message: 'OpenCode did not offer a model option.' };
    return undefined;
  });
  if (created) return fail(cleanup(created));
  const configured = await exchange('session/set_config_option', { sessionId, configId: 'model', value: model }, (value) => (
    currentModel(value) === model ? undefined : { code: 'native-failure', message: 'OpenCode did not apply the caller model.' }
  ));
  if (configured || !sessionId) return fail(cleanup(configured ?? { code: 'native-failure', message: 'OpenCode did not return a session.' }));
  phase = 'live';
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted || setupError) return fail(cleanup(setupError ?? { code: 'closed', message: 'open was aborted' }));

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
    if (!active.failure && (active.stopReason === 'end_turn' || active.stopReason === 'max_tokens')) {
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
    if (active.sawTraffic || active.failure) return { kind: 'accepted', evidence: evidence(recorded) };
    return { kind: 'outcome-unknown' };
  }
  function applyOutcome(active: Turn, outcome: OpenCodeRpcOutcome): void {
    if (active.settled) return;
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
    if (active.sawTraffic && !active.failure) active.failure = { code: 'native-failure', message: incompleteTurn };
  }
  function finishTurn(active: Turn): void {
    if (active.settled) return;
    active.settled = true;
    active.resolve();
  }

  async function finish(): Promise<Outcome<void, AdapterError>> {
    phase = 'closed';
    for (const item of permissions) answerCancelled(item);
    if (sessionId) protocol.request('session/close', { sessionId }, { signal: new AbortController().signal, timeoutMs: acknowledgementMs });
    try { channel.endInput(); } catch { /* exit attestation is separate from stdin */ }
    const observed = await observeExit(processExit);
    protocol.stop();
    stream.close();
    if (!observed) return { kind: 'error', error: { code: 'native-failure', message: exitUnobserved } };
    return { kind: 'ok', value: undefined };
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
      if (closePromise || phase === 'closed') return failed({ code: 'closed', message: 'the adapter is closed' }, notAttempted);
      if (unusable) return failed(unusable, notAttempted);
      if (turn) return failed({ code: 'busy', message: 'a segment is already running' }, notAttempted);
      const prompt = promptText(input.prompt);
      if (prompt === undefined) return failed({ code: 'invalid-input', message: 'the prompt must be plain text without a slash command' }, notAttempted);
      let resolveTurn: () => void = () => {};
      const active: Turn = {
        phase: 'intent', promptWritten: false, sawTraffic: false, cancelSent: false, settled: false, text: '', usage: null,
        resolve: () => resolveTurn(),
        done: new Promise((resolve) => { resolveTurn = resolve; }),
      };
      turn = active;
      try {
        const handle = createDispatchOperation<CompleteSegment>({
          mode: 'fresh', signal: input.signal, recordIntent: input.recordIntent,
          identity: { hostOperationId: input.hostOperationId, target: { kind: 'session', reference } },
          dispatchNative: async (recorded) => {
            active.phase = 'native';
            if (!active.failure) {
              const outcome = await protocol.request('session/prompt', {
                sessionId, prompt: [{ type: 'text', text: prompt }],
              }, {
                signal: input.signal,
                beforeWrite() { active.promptWritten = true; },
                onOutcome(next) {
                  applyOutcome(active, next);
                  finishTurn(active);
                },
              });
              applyOutcome(active, outcome);
              await Promise.resolve();
            }
            const observation = classify(active, recorded);
            finishTurn(active);
            return observation;
          },
        });
        const snapshot = await handle.run();
        const observation = snapshot.observation;
        if (observation.kind === 'conclusive') return observation.result;
        if (observation.kind === 'not-dispatched') {
          return failed({ code: 'native-failure', message: observation.reason }, observation);
        }
        if (observation.kind === 'accepted') return failed(active.failure ?? { code: 'native-failure', message: incompleteTurn }, observation);
        return failed({ code: 'native-failure', message: incompleteTurn }, { kind: 'outcome-unknown' });
      } finally {
        finishTurn(active);
        if (turn === active) turn = undefined;
      }
    },
    async interrupt({ timeoutMs }) {
      const active = turn;
      if (!active || active.settled) return { kind: 'terminal-observed' };
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return { kind: 'unconfirmed-within-bound' };
      if (active.phase === 'intent' || !active.promptWritten) return { kind: 'unconfirmed-within-bound' };
      sendCancel(active);
      const timer = new AbortController();
      const timed = delay(timeoutMs, 'timeout' as const, { signal: timer.signal }).then((value) => value, () => 'timeout' as const);
      const winner = await Promise.race([active.done.then(() => 'done' as const), timed]);
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
