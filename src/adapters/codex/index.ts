import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { createAuthContext } from '../../core/auth.js';
import type { AuthConfiguration, AuthScope } from '../../core/auth.js';
import { createDispatchOperation } from '../../core/dispatch.js';
import type { DispatchEvidence, DispatchIdentity } from '../../core/dispatch.js';
import { createEventStream } from '../../core/events.js';
import { answeredToolObservations, declaredToolObservations, emitObservation, emitRunStarted, isOptionalObservationListener, normalizeUsage, segmentTerminal } from '../../core/run-observation.js';
import type { RunObservation, RunObservationListener, RunObservationUsage } from '../../core/run-observation.js';
import type { HostAdapter, HostAdapterError, HostAdapterEvent, HostAdapterRegistration, HostContinueInput,
  HostLaunch, HostOpenOptions, HostRunInput, HostSegmentRequest, HostSegmentResult, HostToolCall, HostToolDeclaration, HostUsage,
  HostWriteStatus,
} from '../../core/host-adapter.js';
import type { InteractionContinuation } from '../../core/interaction.js';
import { parseInteractionContinuation } from '../../core/interaction.js';
import type { SessionBinding } from '../../core/sessions.js';
import { createCodexWriters, openCodexExecution } from './execution.js';
import type { CleanupStep, CodexSession, CodexTokenUsage, CodexTurnCompletion } from './execution.js';
import { codexCheckpoint, readCodexHistoryFingerprint } from './fingerprint.js';
import type { CodexDynamicTool, CodexSandboxMode } from './features.js';
import { codexNativeToolReply, createCodexInteraction } from './interaction.js';
import type { CodexHostCall, CodexInteraction } from './interaction.js';
import { codexProxyConfig } from './proxy.js';
import { checkCodexHostRoute, checkCodexRoute, codexHostRouteConfig } from './route.js';
import type { CodexHostRoute, CodexProxyRoute } from './route.js';
import { bindCodexRequester } from './sessions.js';
import { openCodexTransport } from './transport.js';
import type { BorrowedChannel, CodexTransport, TransportBounds } from './transport.js';

/** Pinned app-server this adapter was proved against. */
export const CODEX_HOST_NATIVE_VERSION = '0.169.0';

export interface CodexHostNativeConfig {
  /** Absolute `CODEX_HOME`. The adapter reads no other home. */
  readonly home: string;
  /** Absolute workspace passed as the thread `cwd`. */
  readonly cwd: string;
  readonly executable?: string;
  readonly sqliteHome?: string;
  readonly logDir?: string;
  readonly providerId?: string;
  /** Host mark: this endpoint's host and port change every turn and are not part of the session principal. */
  readonly loopbackRelay?: boolean;
  /** `'unavailable'` when the host cannot run a credential helper. Otherwise the helper command. */
  readonly helper?: 'unavailable' | { readonly command: string; readonly args: readonly string[] };
  readonly envKey?: string;
  readonly headerEnv?: Readonly<Record<string, string>>;
  readonly sandbox?: CodexSandboxMode;
  /** Bounds a held server request for the whole transport. Default 180000, above a 171s hold. */
  readonly handlerTimeoutMs?: number;
}
export interface CodexHostSpawnRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}
export interface CodexHostSpawned {
  readonly channel: BorrowedChannel;
  readonly processExit: PromiseLike<unknown>;
}
export type CodexHostLaunch = HostLaunch<
  (request: CodexHostSpawnRequest, signal: AbortSignal) => CodexHostSpawned | PromiseLike<CodexHostSpawned>,
  BorrowedChannel>;

const identity = Object.freeze({ engine: 'codex' as const, adapter: 'codex-host', version: '1', contractVersion: 1 as const });
/** One pending set per assistant message. The bridge refuses the next call at this same limit. */
const maxPendingPerMessage = 8;
/**
 * One assistant message's host calls are collected until this long passes with no further `host-call`,
 * or the turn completes, or the pending cap trips.
 */
const hostCallQuietMs = 30;
/**
 * In-process memory of the declarations sent at thread/start, keyed by home and thread. A fresh process starts empty.
 * `close` leaves the record in place. Past this many threads, the oldest key is dropped and a later resume of that
 * thread is treated like a process that never saw it.
 */
const maxRemembered = 32;
const remembered = new Map<string, string>();
const declarationKey = (home: string, threadId: string) => `${home}\0${threadId}`;
function rememberDeclaration(home: string, threadId: string, tools: string): void {
  const key = declarationKey(home, threadId);
  if (!remembered.has(key) && remembered.size >= maxRemembered) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(key, tools);
}
const discovery = Object.freeze({ maxResults: 10, maxExamined: 10, maxDurationMs: 5000 });
const featurePins = [
  { keys: ['shell_tool', 'unified_exec', 'shell_snapshot'], on: (enabled: ReadonlySet<string>) => enabled.has('shell') || enabled.has('shell_tool'),
    off: 'the engine shell is on and the host did not enable it' },
  { keys: ['view_image'], on: (enabled: ReadonlySet<string>) => enabled.has('view_image'),
    off: 'view_image is on and the host did not leave it on' },
  { keys: ['request_user_input', 'default_mode_request_user_input'], on: (enabled: ReadonlySet<string>) => enabled.has('request_user_input'),
    off: 'request_user_input is on and the host did not leave it on' },
] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (error: HostAdapterError) => ({ kind: 'error' as const, error: Object.freeze(error) });
function failed(error: HostAdapterError, write: HostWriteStatus): HostSegmentResult {
  if (error.code === 'pending-limit') {
    if (write.kind !== 'accepted') {
      return { kind: 'failed', error: { code: 'native-failure', message: 'a pending limit was not an accepted write' }, write: { kind: 'not-attempted' } };
    }
    return { kind: 'failed', error, write };
  }
  return { kind: 'failed', error, write };
}
/** Native `total` as one observation row. `reasoningOutputTokens` is the AG-UI `reasoningTokens`. */
function usageRow(total: CodexTokenUsage): RunObservationUsage {
  return { inputTokens: total.inputTokens, outputTokens: total.outputTokens, cachedInputTokens: total.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens, reasoningTokens: total.reasoningOutputTokens,
    totalTokens: total.totalTokens };
}
/**
 * Pinned 0.169.0 `ServerNotification` reasoning methods, checked against `codex app-server generate-ts`:
 * `item/reasoning/textDelta` carries `{ itemId, delta }` and `item/reasoning/summaryTextDelta` adds a numeric
 * `summaryIndex`, which keeps each summary part in its own message. `execution.ts` leaves them
 * as opaque `native` events, so `watch` projects only these two methods as `reasoning` deltas.
 */
const reasoningMethods = ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'] as const;
const emptyUsage = (): HostUsage => Object.freeze({ scope: 'cumulative', native: Object.freeze({
  namespace: 'codex-app-server/token-usage', schemaVersion: 1, data: null }) });

function canonicalTools(tools: readonly HostToolDeclaration[]): string {
  return JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
}
function dynamicTools(tools: readonly HostToolDeclaration[]): readonly CodexDynamicTool[] | undefined {
  if (tools.length === 0) return undefined;
  return [Object.freeze({ type: 'namespace', name: 'application', description: 'Host tools',
    tools: Object.freeze(tools.map((tool) => Object.freeze({ type: 'function' as const, name: tool.name,
      description: tool.description, inputSchema: tool.inputSchema, deferLoading: false }))) })];
}
function featureArgs(enabled: ReadonlySet<string>, emitMultiAgent: boolean): readonly string[] {
  const args: string[] = [];
  const set = (name: string, on: boolean) => { args.push('-c', `features.${name}=${JSON.stringify(on)}`); };
  for (const pin of featurePins) for (const key of pin.keys) set(key, pin.on(enabled));
  if (emitMultiAgent) { set('multi_agent', false); set('multi_agent_v2', false); }
  return args;
}
function emitMultiAgentArgs(kind: PreparedRoute['kind'], subagentsOff: boolean): boolean {
  switch (kind) {
    case 'host-route':
      return true;
    case 'direct':
      return subagentsOff;
    case 'litellm-proxy':
      return false;
    default: {
      const leftover: never = kind;
      return leftover;
    }
  }
}
const timerBound = (value: number) => Number.isInteger(value) && value >= 1 && value <= 2147483647;
function echoPins(features: Record<string, unknown>, enabled: ReadonlySet<string>): string | undefined {
  for (const pin of featurePins) {
    if (!pin.on(enabled) && pin.keys.some((key) => features[key] !== false)) return pin.off;
  }
  return undefined;
}
const sandboxes = ['read-only', 'workspace-write', 'danger-full-access'] as const satisfies readonly CodexSandboxMode[];
function optionalString(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : false;
}
function helperOf(value: unknown): CodexHostNativeConfig['helper'] | false {
  if (value === undefined || value === 'unavailable') return value;
  if (!record(value) || typeof value.command !== 'string' || !Array.isArray(value.args)
    || !value.args.every((arg) => typeof arg === 'string')) return false;
  return { command: value.command, args: Object.freeze([...value.args]) };
}
function nativeOf(value: unknown): CodexHostNativeConfig | undefined {
  if (!record(value) || typeof value.home !== 'string' || typeof value.cwd !== 'string') return undefined;
  if (!isAbsolute(value.home) || !isAbsolute(value.cwd) || value.home !== resolve(value.home) || value.cwd !== resolve(value.cwd)) return undefined;
  const executable = optionalString(value.executable);
  const sqliteHome = optionalString(value.sqliteHome);
  const logDir = optionalString(value.logDir);
  const providerId = optionalString(value.providerId);
  const envKey = optionalString(value.envKey);
  if (executable === false || sqliteHome === false || logDir === false || providerId === false || envKey === false) return undefined;
  if (executable !== undefined && !isAbsolute(executable)) return undefined;
  const handlerTimeoutMs = value.handlerTimeoutMs;
  if (handlerTimeoutMs !== undefined && (typeof handlerTimeoutMs !== 'number' || !timerBound(handlerTimeoutMs))) return undefined;
  const sandbox = sandboxes.find((mode) => mode === value.sandbox);
  if (value.sandbox !== undefined && sandbox === undefined) return undefined;
  if (value.loopbackRelay !== undefined && typeof value.loopbackRelay !== 'boolean') return undefined;
  const helper = helperOf(value.helper);
  if (helper === false) return undefined;
  let headerEnv: Readonly<Record<string, string>> | undefined;
  if (value.headerEnv !== undefined) {
    if (!record(value.headerEnv)) return undefined;
    const entries = Object.entries(value.headerEnv);
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) return undefined;
    headerEnv = Object.freeze(Object.fromEntries(entries));
  }
  return {
    home: value.home, cwd: value.cwd,
    ...(executable === undefined ? {} : { executable }),
    ...(sqliteHome === undefined ? {} : { sqliteHome }),
    ...(logDir === undefined ? {} : { logDir }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(envKey === undefined ? {} : { envKey }),
    ...(handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(value.loopbackRelay === undefined ? {} : { loopbackRelay: value.loopbackRelay }),
    ...(helper === undefined ? {} : { helper }),
    ...(headerEnv === undefined ? {} : { headerEnv }),
  };
}
function toCall(call: CodexHostCall): HostToolCall {
  return Object.freeze({ pending: call.pending, name: call.name, arguments: call.arguments });
}

type PreparedRoute =
  | { readonly kind: 'direct'; readonly args: readonly string[] }
  | { readonly kind: 'litellm-proxy'; readonly route: CodexProxyRoute; readonly args: readonly string[] }
  | { readonly kind: 'host-route'; readonly route: CodexHostRoute; readonly args: readonly string[] };
function withFeatureArgs(prepared: PreparedRoute, extra: readonly string[]): PreparedRoute {
  return { ...prepared, args: [...prepared.args, ...extra] };
}
function threadFeatures(prepared: PreparedRoute, config: CodexHostNativeConfig,
  openOptions: HostOpenOptions<CodexHostLaunch, CodexHostNativeConfig>) {
  const declared = openOptions.resume ? undefined : dynamicTools(openOptions.tools ?? []);
  const base = { approvalPolicy: 'never' as const, cwd: config.cwd, ...(declared ? { dynamicTools: declared } : {}) };
  const chosen = config.sandbox ? { sandbox: config.sandbox } : {};
  switch (prepared.kind) {
    case 'direct':
      return { ...base, ...chosen };
    case 'litellm-proxy':
      return { ...base, ...chosen, model: prepared.route.model };
    case 'host-route':
      return { ...base, model: prepared.route.model, sandbox: config.sandbox ?? 'read-only' as const };
    default: {
      const leftover: never = prepared;
      return leftover;
    }
  }
}
function prepareRoute(config: AuthConfiguration<unknown>, scope: AuthScope, native: CodexHostNativeConfig):
{ readonly route: PreparedRoute } | { readonly problem: string } | { readonly unavailable: string } {
  switch (config.kind) {
    case 'direct':
      return { problem: 'direct credentials are not a Codex host route' };
    case 'litellm': {
      if (native.helper === 'unavailable') return { unavailable: 'helper' };
      const providerId = native.providerId ?? 'litellm';
      const helper = native.helper;
      if (helper === undefined) return { problem: 'the helper form needs a host command' };
      const checked = checkCodexRoute({ kind: 'litellm-proxy', providerId, endpoint: config.endpoint, credentialPurpose: 'litellm-proxy',
        model: config.model, scope: { engine: scope.engine, account: scope.account } });
      if ('problem' in checked) return checked;
      const configured = codexProxyConfig(checked.route, { helper });
      if ('problem' in configured) return configured;
      return { route: { kind: 'litellm-proxy', route: checked.route, args: configured.config.args } };
    }
    case 'host-route': {
      if (config.credentialForm === 'helper' && native.helper === 'unavailable') return { unavailable: 'helper' };
      const providerId = native.providerId ?? 'host';
      const helper = config.credentialForm === 'helper' && native.helper !== undefined ? native.helper : undefined;
      const checked = checkCodexHostRoute({ kind: 'host-route', providerId, endpoint: config.endpoint, protocol: config.protocol,
        credentialForm: config.credentialForm, principal: config.principal, loopbackRelay: native.loopbackRelay === true,
        model: config.model, scope: { engine: scope.engine, account: scope.account },
        sqliteHome: native.sqliteHome, logDir: native.logDir,
        ...(config.credentialForm === 'bearer' ? { envKey: native.envKey, headerEnv: native.headerEnv } : {}),
        ...(helper ? { helperCommand: helper } : {}) });
      if ('problem' in checked) return { problem: checked.problem };
      const built = checked.route;
      const configured = codexHostRouteConfig(built);
      return { route: { kind: 'host-route', route: built, args: configured.args } };
    }
    default: {
      const leftover: never = config;
      return { problem: `route kind ${String(leftover)} is not a Codex route` };
    }
  }
}

/**
 * Public Codex host adapter. It composes the app-server stack, sets `experimentalApi`, and never executes a tool,
 * fabricates a tool result, reads ambient configuration, or signals a host-owned process.
 */
export const codexHostAdapter: HostAdapterRegistration<HostOpenOptions<CodexHostLaunch, CodexHostNativeConfig>> = Object.freeze({
  identity,
  async open(options: HostOpenOptions<CodexHostLaunch, CodexHostNativeConfig>, signal: AbortSignal) {
    let channel: BorrowedChannel | undefined;
    let execution: { close: () => Promise<unknown> } | undefined;
    let transportBounds: TransportBounds | undefined;
    try {
      if (!(signal instanceof AbortSignal)) return fail({ code: 'invalid-input', message: 'open requires an AbortSignal' });
      if (signal.aborted) return fail({ code: 'closed', message: 'open was aborted' });
      const launch = options.launch;
      if (!launch) return fail({ code: 'unsupported', feature: 'host-launcher', message: 'Codex opens only through a host launch' });
      if (launch.kind === 'in-process') return fail({ code: 'unavailable', feature: 'in-process', message: 'Codex has no in-process launch' });
      const native = nativeOf(options.environment?.nativeConfig);
      const variables = options.environment?.variables;
      if (!native || !variables) return fail({ code: 'invalid-input', message: 'Codex requires a complete host environment and native config' });
      const enabled = new Set<string>(options.builtInTools ?? []);
      let prepared: PreparedRoute = { kind: 'direct', args: [] };
      if (options.route) {
        if (native.sandbox === 'danger-full-access') {
          return fail({ code: 'invalid-input', message: 'a routed session refuses danger-full-access' });
        }
        const route = prepareRoute(options.route.config, options.route.scope, native);
        if ('unavailable' in route) return fail({ code: 'unavailable', feature: route.unavailable, message: 'The host cannot run a credential helper' });
        if ('problem' in route) return fail({ code: 'invalid-input', message: route.problem });
        prepared = route.route;
      }
      const subagentsOff = options.subagents === 'off';
      const echoMultiAgent = prepared.kind !== 'direct' || subagentsOff;
      prepared = withFeatureArgs(prepared, featureArgs(enabled, emitMultiAgentArgs(prepared.kind, subagentsOff)));
      const handlerTimeoutMs = native.handlerTimeoutMs ?? 180000;
      if (!timerBound(handlerTimeoutMs)) return fail({ code: 'invalid-input', message: 'handlerTimeoutMs is outside 1..2147483647' });
      const bridgeResult = createCodexInteraction({ maxObservers: 4, eventCapacity: 64, maxSettled: 32, maxPending: maxPendingPerMessage,
        transport: { maxHandlers: 16, handlerTimeoutMs }, userInput: enabled.has('request_user_input'),
        declaredTools: (options.tools ?? []).map((tool) => ({ name: tool.name, namespace: 'application' as const })) });
      if (bridgeResult.kind === 'error') return fail({ code: 'invalid-input', message: 'interaction bounds were rejected' });
      const bridge = bridgeResult.value;
      transportBounds = { maxFrameBytes: 1048576, maxChunkBytes: 2097151, maxDiagnosticBytes: 65536,
        maxPending: 8, maxHandlers: 16, maxWrites: 8, observationCapacity: 256, handlerTimeoutMs,
        observationTimeoutMs: 5000, writeTimeoutMs: 20000 };
      const executable = native.executable;
      let processExit: PromiseLike<unknown> | undefined;
      if (launch.kind === 'spawn') {
        if (typeof executable !== 'string' || !isAbsolute(executable)) {
          return fail({ code: 'invalid-input', message: 'spawn requires an absolute native executable' });
        }
        let spawned: CodexHostSpawned;
        try {
          spawned = await launch.spawn({ executable, args: [executable, 'app-server', '--stdio', ...prepared.args],
            cwd: native.cwd, env: variables }, signal);
        } catch {
          return fail({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher denied the process' });
        }
        if (!spawned?.channel || typeof spawned.processExit?.then !== 'function') {
          return fail({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher returned no channel' });
        }
        channel = spawned.channel;
        processExit = spawned.processExit;
      } else {
        channel = launch.channel;
        processExit = launch.processExit;
      }
      if (!channel || !processExit) return fail({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher returned no channel' });
      const opened = await openCodexExecution({ channel, processExit, writers: createCodexWriters(4), home: native.home, signal,
        transport: transportBounds,
        bounds: { maxSessions: 4, maxObservers: 4, eventCapacity: 64, maxEarlyNotifications: 32, cleanupTimeoutMs: 5000,
          acknowledgementTimeoutMs: 15000 },
        initialize: { clientInfo: { name: 'switchboard-codex-host', version: '1' }, capabilities: { experimentalApi: true } },
        onServerRequest: bridge.onServerRequest, ...(prepared.kind === 'direct' ? {} : { route: prepared.route }) });
      if (opened.kind === 'error') {
        if (transportBounds) await releaseSpawned(channel, transportBounds);
        return fail({ code: opened.error.code === 'invalid-input' ? 'invalid-input' : 'native-failure',
          message: opened.error.message ?? 'Codex app-server handshake failed' });
      }
      execution = opened.value;
      const pinned = await pinnedFeatures(opened.value.scope.request, enabled, signal, prepared.kind, echoMultiAgent);
      if (pinned) { await execution.close(); return fail({ code: 'invalid-input', message: pinned }); }
      const bound = await bindCodexRequester({ scope: opened.value.scope, bounds: discovery, signal, nativeFormat: 'codex-thread/paginated' });
      if (bound.kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: 'Codex requester was not admitted' }); }
      return await openAdapter({ options, signal, native, enabled, prepared, bridge, execution: opened.value, binding: bound.value.binding, variables });
    } catch {
      if (execution) await execution.close();
      else if (channel && transportBounds) await releaseSpawned(channel, transportBounds);
      return fail({ code: 'native-failure', message: 'Codex host adapter failed to open' });
    }
  },
});

async function releaseSpawned(channel: BorrowedChannel, bounds: TransportBounds): Promise<void> {
  try {
    const transport = openCodexTransport({ channel, bounds,
      onRequest: () => ({ kind: 'error', error: { code: -32601, message: 'closed', data: null } }), onObservation: () => {} });
    await transport.close();
  } catch { /* the child is already unreachable when the transport cannot attach */ }
}

async function pinnedFeatures(request: CodexTransport['request'],
  enabled: ReadonlySet<string>, signal: AbortSignal, kind: PreparedRoute['kind'], pinMultiAgent: boolean): Promise<string | undefined> {
  const exchange = await request({ method: 'config/read', params: { includeLayers: false } }, signal);
  const reply = exchange.kind === 'reply' ? exchange.envelope?.reply : undefined;
  const config = reply?.kind === 'result' && record(reply.value) && record(reply.value.config) ? reply.value.config : undefined;
  if (kind !== 'direct' && !config) return 'the route config could not be read';
  const features = config && record(config.features) ? config.features : {};
  const mismatch = echoPins(features, enabled);
  if (mismatch) return mismatch;
  if (pinMultiAgent && (features.multi_agent !== false || features.multi_agent_v2 !== false)) return 'multi-agent is not pinned off';
  return undefined;
}

type OpenedExecution = Awaited<ReturnType<typeof openCodexExecution>> extends infer T
  ? T extends { kind: 'ok'; value: infer V } ? V : never : never;

async function openAdapter(ready: {
  readonly options: HostOpenOptions<CodexHostLaunch, CodexHostNativeConfig>;
  readonly signal: AbortSignal; readonly native: CodexHostNativeConfig; readonly enabled: ReadonlySet<string>;
  readonly prepared: PreparedRoute; readonly bridge: CodexInteraction;
  readonly execution: OpenedExecution;
  readonly binding: SessionBinding; readonly variables: Readonly<Record<string, string>>;
}) {
  const { options, signal, native, bridge, execution, binding, variables } = ready;
  const tools = options.tools ?? [];
  const canonical = canonicalTools(tools);
  const stream = createEventStream<HostAdapterEvent>({ maxObservers: 4, capacity: 64 });
  let session: CodexSession | undefined;
  let segment: { phase: 'intent' | 'native'; text: string; usage: HostUsage; observer: RunObservationListener | undefined } | undefined;
  /** Whether `run-started` went out for this segment. */
  type SegmentState = { started: boolean };
  /** A segment result plus the native terminal a failed result hides. */
  type Settled = { readonly result: HostSegmentResult; readonly failedAs?: 'cancelled' | 'outcome-unknown' };
  let turnCompletion: Promise<CodexTurnCompletion> | undefined;
  let turnResult: CodexTurnCompletion | undefined;
  let capacityRefused = false;
  let closing: ReturnType<HostAdapter['close']> | undefined;
  const publish = (event: HostAdapterEvent) => { if (segment && segment.phase !== 'intent') stream.publish(Object.freeze(event)); };
  const observe = (observation: RunObservation) => { if (segment && segment.phase !== 'intent') emitObservation(segment.observer, observation); };
  const calls = () => bridge.hostCalls().map(toCall);
  bridge.events.subscribe((event) => {
    if (event.kind === 'refused' && event.reason === 'capacity') { capacityRefused = true; return; }
    if (event.kind === 'host-delivery') {
      publish({ kind: 'tool-delivery', target: event.target, delivery: event.delivery });
      return;
    }
    if (event.kind !== 'host-call') return;
    const target = event.call.pending.target;
    publish({ kind: 'tool-call-start', target, name: event.call.name });
    publish({ kind: 'tool-call-arguments-delta', target, delta: JSON.stringify(event.call.arguments ?? null) });
    publish({ kind: 'tool-call-end', target, arguments: event.call.arguments });
    if (segment?.observer) {
      for (const o of declaredToolObservations(target.nativeToolCallId, event.call.name, event.call.arguments ?? null)) observe(o);
    }
  });
  const resume = options.resume;
  const resumedKey = resume ? declarationKey(native.home, resume.session.opaque) : undefined;
  if (resumedKey && remembered.has(resumedKey) && remembered.get(resumedKey) !== canonical) {
    await execution.close();
    return fail({ code: 'invalid-input', message: 'tool declarations are fixed at session creation' });
  }
  if (resume?.expectedHistory) {
    const actual = await readCodexHistoryFingerprint(native.home, resume.session.opaque);
    const checkpoint = actual && codexCheckpoint(resume.session, actual);
    if (!checkpoint || checkpoint.opaque !== resume.expectedHistory.opaque) {
      await execution.close();
      return fail({ code: 'history-mismatch', message: 'native history does not match the expected fingerprint' });
    }
  }
  if (resume) {
    const resumed = await execution.resume({ binding: resume.session.binding, reference: resume.session, signal, bounds: discovery,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }), features: threadFeatures(ready.prepared, native, options) });
    if (resumed.kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: resumed.error.message ?? resumed.error.code }); }
    if (resumed.value.kind !== 'resumed') { await execution.close(); return fail({ code: 'busy', message: `resume is ${resumed.value.kind}` }); }
    session = resumed.value.session;
    if (bridge.attach(session).kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: 'interaction attach failed' }); }
    watch(session);
    rememberDeclaration(native.home, session.threadId, canonical);
  }
  function watch(current: CodexSession): void {
    current.events.subscribe((event) => {
      if (!segment || segment.phase === 'intent') return;
      if (event.kind === 'text-delta') {
        segment.text += event.delta;
        publish({ kind: 'text-delta', nativeItemId: event.itemId, text: event.delta });
        observe({ kind: 'text', messageId: event.itemId, mode: 'delta', text: event.delta });
      } else if (event.kind === 'native') {
        if (segment.observer && reasoningMethods.some((method) => method === event.method) && record(event.params)
          && typeof event.params.itemId === 'string' && typeof event.params.delta === 'string') {
          const index = event.params.summaryIndex;
          const part = event.method === 'item/reasoning/textDelta' ? 'text'
            : typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? `summary:${index}` : 'summary';
          observe({ kind: 'reasoning', messageId: `${event.params.itemId}:${part}`, mode: 'delta', text: event.params.delta });
        }
      } else if (event.kind === 'usage') {
        segment.usage = Object.freeze({ scope: 'cumulative', native: Object.freeze({ namespace: 'codex-app-server/token-usage',
          schemaVersion: 1, data: { total: event.total, last: event.last, modelContextWindow: event.modelContextWindow } }) });
        publish({ kind: 'usage', usage: segment.usage });
        observe({ kind: 'usage', rows: [normalizeUsage(usageRow(event.total))] });
      }
    });
  }
  async function credentialOk(hostSignal: AbortSignal): Promise<HostAdapterError | undefined> {
    const route = options.route;
    const host = ready.prepared.kind === 'host-route' ? ready.prepared.route : undefined;
    if (!route || !host || host.credentialForm !== 'bearer') return undefined;
    const auth = createAuthContext({ config: route.config, scope: { ...route.scope, sessionId: session?.threadId ?? 'new', adapterInstanceId: identity.adapter } });
    if (auth.kind === 'error') return { code: 'unavailable', feature: 'credential', message: 'bearer credential is unavailable' };
    const invocationId = createHash('sha256').update(session?.threadId ?? native.home).digest('hex');
    const resolved = await auth.value.resolve({ boundary: 'request', invocationId, requestId: invocationId }, hostSignal);
    if (resolved.kind === 'error' || resolved.value.kind !== 'host-route' || resolved.value.material.form !== 'bearer') {
      return { code: 'unavailable', feature: 'credential', message: 'bearer credential is unavailable' };
    }
    if (variables[host.envKey] !== resolved.value.material.token) {
      return { code: 'unavailable', feature: 'credential', message: 'bearer credential does not match the host environment' };
    }
    const headers = resolved.value.material.headers ?? {};
    const named = host.headerEnv ?? {};
    for (const [name, variable] of Object.entries(named)) {
      if (headers[name] !== variables[variable]) return { code: 'unavailable', feature: 'credential', message: 'a bearer header does not match the host environment' };
    }
    return undefined;
  }
  function pendingSegment(active: CodexSession, current: NonNullable<typeof segment>, pending: readonly CodexHostCall[]): HostSegmentResult {
    return { kind: 'pending', session: active.reference, calls: Object.freeze(pending.map(toCall)), usage: current.usage };
  }
  async function settle(hostSignal: AbortSignal, accepted: DispatchEvidence): Promise<Settled> {
    const current = segment;
    const active = session;
    if (!current || !active) return { result: failed({ code: 'native-failure', message: 'no segment' }, { kind: 'not-attempted' }) };
    const choice = await collectSettleChoice({ signal: hostSignal, bridge, turnDone: turnCompletion,
      turnFinished: () => turnResult !== undefined, capacityRefused: () => capacityRefused });
    const pending = bridge.hostCalls();
    switch (choice) {
      case 'limit':
        return { result: failed({ code: 'pending-limit', message: 'one assistant message produced more host calls than the pending limit' },
          { kind: 'accepted', evidence: accepted }) };
      case 'pending':
        return { result: pendingSegment(active, current, pending) };
      case 'completion':
        return turnResult ? completionResult(active, current, turnResult, accepted, pending)
          : { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' }) };
      case 'aborted':
        return { result: failed({ code: 'native-failure', message: 'the segment aborted' }, { kind: 'accepted', evidence: accepted }),
          failedAs: 'outcome-unknown' };
      case 'wait':
        return { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' }) };
      default: {
        const leftover: never = choice;
        void leftover;
        return { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' }) };
      }
    }
  }
  function completionResult(active: CodexSession, current: NonNullable<typeof segment>, completion: CodexTurnCompletion,
    accepted: DispatchEvidence, pending: readonly CodexHostCall[]): Settled {
    const acceptedWrite = { kind: 'accepted' as const, evidence: accepted };
    switch (completion.kind) {
      case 'terminal':
        switch (completion.terminal.status) {
          case 'completed':
            return { result: pending.length > 0 ? pendingSegment(active, current, pending)
              : { kind: 'complete', session: active.reference, text: current.text, usage: current.usage } };
          case 'failed':
            return { result: failed({ code: 'native-failure', message: 'the native turn failed' }, acceptedWrite) };
          case 'interrupted':
            return { result: failed({ code: 'native-failure', message: 'the native turn was interrupted' }, acceptedWrite),
              failedAs: 'cancelled' };
          default: {
            const status: never = completion.terminal.status;
            return { result: failed({ code: 'native-failure', message: `the native turn status is ${String(status)}` }, acceptedWrite) };
          }
        }
      case 'rejected':
        return { result: failed({ code: 'native-failure', message: 'the native turn was rejected' }, acceptedWrite) };
      case 'unconcluded':
      case 'not-sent':
      case 'not-dispatched':
        return { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' }) };
      default: {
        const leftover: never = completion;
        return { result: failed({ code: 'native-failure', message: `the native turn outcome is ${String(leftover)}` }, { kind: 'outcome-unknown' }) };
      }
    }
  }
  function evidence(active: CodexSession, completion: CodexTurnCompletion) {
    return { identity: { hostOperationId: 'turn', target: { kind: 'session' as const, reference: active.reference } },
      source: 'native-acknowledgement' as const, nativeOperation: null,
      observation: { namespace: 'codex-app-server/turn', schemaVersion: 1, data: { kind: completion.kind } } };
  }
  async function dispatchTurn(prompt: string | undefined, answers: readonly InteractionContinuation[] | undefined, hostSignal: AbortSignal) {
    const current = session;
    if (!current && prompt === undefined) return { kind: 'outcome-unknown' as const };
    if (!current) {
      const created = await execution.create({ signal: hostSignal, bounds: discovery,
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        features: threadFeatures(ready.prepared, native, options) });
      if (created.kind === 'error') return { kind: 'outcome-unknown' as const };
      if (bridge.attach(created.value).kind === 'error') {
        await created.value.close();
        return { kind: 'outcome-unknown' as const };
      }
      session = created.value;
      rememberDeclaration(native.home, session.threadId, canonical);
      watch(session);
    }
    const active = session;
    if (!active) return { kind: 'outcome-unknown' as const };
    if (answers) {
      const observer = segment?.observer;
      const known = observer ? bridge.hostCalls() : [];
      for (const answer of answers) {
        const replied = await bridge.reply({ value: answer, signal: hostSignal, recordIntent: () => {} });
        if (replied.kind === 'error') return { kind: 'outcome-unknown' as const };
        if (observer && answer.kind === 'tool') {
          const callId = answer.outcome.target.nativeToolCallId;
          const call = known.find((candidate) => candidate.pending.target.nativeToolCallId === callId);
          if (call) {
            for (const o of answeredToolObservations(callId, call.name, call.arguments ?? null, answer.outcome.result)) observe(o);
          }
        }
      }
    }
    if (prompt === undefined) return { kind: 'accepted' as const, evidence: evidence(active, { kind: 'not-dispatched' }) };
    const started = active.turn({ hostOperationId: 'turn', input: [{ type: 'text', text: prompt, text_elements: [] }],
      signal: hostSignal, recordIntent: () => {} });
    if (started.kind === 'error') return { kind: 'outcome-unknown' as const };
    turnResult = undefined;
    let observed: Promise<CodexTurnCompletion>;
    observed = started.value.completion.then((value) => { if (turnCompletion === observed) turnResult = value; return value; });
    turnCompletion = observed;
    const snapshot = await started.value.run();
    return snapshot.observation.kind === 'outcome-unknown' || snapshot.observation.kind === 'not-dispatched'
      ? { kind: 'outcome-unknown' as const } : snapshot.observation;
  }
  function answersMatch(answers: readonly InteractionContinuation[]): boolean {
    const pending = bridge.hostCalls();
    if (answers.length === 0 || answers.length !== pending.length) return false;
    const ids = new Set(pending.map((call) => call.pending.target.nativeToolCallId));
    return answers.every((answer) => {
      if (answer.kind !== 'tool') return false;
      const id = answer.outcome.target.nativeToolCallId;
      const expected = pending.find((call) => call.pending.target.nativeToolCallId === id);
      if (!expected || !ids.delete(id)) return false;
      return parseInteractionContinuation({ value: answer, expected: expected.pending }).kind === 'ok'
        && codexNativeToolReply(expected, answer) !== undefined;
    }) && ids.size === 0;
  }
  async function segmentOf(input: HostSegmentRequest, prompt: string | undefined,
  answers: readonly InteractionContinuation[] | undefined): Promise<HostSegmentResult> {
    if (!isOptionalObservationListener(input.onObservation)) {
      return failed({ code: 'invalid-input', message: 'onObservation must be a function' }, { kind: 'not-attempted' });
    }
    const state: SegmentState = { started: false };
    let settled: Settled | undefined;
    try {
      settled = await segmentInner(input, prompt, answers, state);
      return settled.result;
    } finally {
      // A throw after the run started still gives the baseline its one terminal.
      if (state.started) {
        emitObservation(input.onObservation, segmentTerminal(settled?.result, settled?.failedAs));
      }
    }
  }
  async function segmentInner(input: HostSegmentRequest, prompt: string | undefined,
  answers: readonly InteractionContinuation[] | undefined, state: SegmentState): Promise<Settled> {
    const refuse = (...args: Parameters<typeof failed>): Settled => ({ result: failed(...args) });
    if (closing) return refuse({ code: 'closed', message: 'the adapter is closed' }, { kind: 'not-attempted' });
    if (segment) return refuse({ code: 'busy', message: 'a segment is already running' }, { kind: 'not-attempted' });
    if (answers && !answersMatch(answers)) return refuse({ code: 'invalid-input', message: 'continuations must cover the pending set exactly' }, { kind: 'not-attempted' });
    if (prompt !== undefined && (bridge.hostCalls().length > 0 || (turnCompletion !== undefined && turnResult === undefined))) {
      return refuse({ code: 'busy', message: 'a turn is already in progress' }, { kind: 'not-attempted' });
    }
    capacityRefused = false;
    segment = { phase: 'intent', text: '', usage: emptyUsage(), observer: input.onObservation };
    const target: DispatchIdentity['target'] = session
      ? { kind: 'session', reference: session.reference } : { kind: 'new-session', binding };
    try {
      const denied = await credentialOk(input.signal);
      if (denied) return refuse(denied, { kind: 'not-attempted' });
      const handle = createDispatchOperation({ mode: 'fresh', signal: input.signal, recordIntent: input.recordIntent,
        identity: { hostOperationId: input.hostOperationId, target },
        dispatchNative: async (recorded) => {
          if (segment) {
            segment.phase = 'native';
            state.started = true;
            emitRunStarted(segment.observer);
          }
          const observation = await dispatchTurn(prompt, answers, input.signal);
          if (observation.kind !== 'accepted' && observation.kind !== 'conclusive') return { kind: 'outcome-unknown' };
          return { kind: 'accepted', evidence: { ...observation.evidence, identity: recorded } };
        } });
      const snapshot = await handle.run();
      if (snapshot.observation.kind === 'not-dispatched') {
        return refuse({ code: 'native-failure', message: snapshot.observation.reason }, { kind: 'not-dispatched', reason: snapshot.observation.reason });
      }
      if (snapshot.observation.kind !== 'accepted' && snapshot.observation.kind !== 'conclusive') {
        return refuse({ code: 'native-failure', message: 'the native outcome is unknown' }, { kind: 'outcome-unknown' });
      }
      return await settle(input.signal, snapshot.observation.evidence);
    } finally { segment = undefined; }
  }
  const adapter: HostAdapter<'codex'> = { identity, capabilities: Object.freeze({
    maxPendingPerMessage, continuation: 'same-process', usage: 'cumulative', toolDeclarations: 'fixed-at-creation',
    inspect: { kind: 'supported' as const, api: { pending: async () => ({ kind: 'ok' as const, value: Object.freeze(calls()) }) } },
    fingerprint: { kind: 'supported' as const, api: { validity: 'segment-end' as const, read: async () => {
      if (!session) return fail({ code: 'unavailable', feature: 'fingerprint', message: 'no session is open' });
      const actual = await readCodexHistoryFingerprint(native.home, session.threadId);
      return actual ? { kind: 'ok' as const, value: codexCheckpoint(session.reference, actual) }
        : fail({ code: 'unavailable', feature: 'fingerprint', message: 'no rollout fingerprint is available' });
    } } },
  }), events: Object.freeze({ subscribe: stream.subscribe }),
    run: (input: HostRunInput) => segmentOf(input, input.prompt, undefined),
    continue: (input: HostContinueInput) => segmentOf(input, undefined, input.answers),
    interrupt: async ({ timeoutMs }) => {
      if (!segment) return { kind: 'terminal-observed' as const };
      if (segment.phase === 'intent') return { kind: 'unconfirmed-within-bound' as const };
      const active = session;
      if (!active) return { kind: 'unconfirmed-within-bound' as const };
      const step = await Promise.race([active.interrupt(), delay(timeoutMs).then(() => 'timeout' as const)]);
      return interruptResult(step, turnResult);
    },
    close: () => closing ??= (async () => {
      await execution.close();
      stream.close();
      return { kind: 'ok' as const, value: undefined };
    })() };
  return { kind: 'ok' as const, value: adapter };
}
type SettleChoice = 'limit' | 'completion' | 'pending' | 'wait' | 'aborted';
async function collectSettleChoice(input: {
  readonly signal: AbortSignal;
  readonly bridge: CodexInteraction;
  readonly turnDone: Promise<unknown> | undefined;
  readonly turnFinished: () => boolean;
  readonly capacityRefused: () => boolean;
}): Promise<SettleChoice> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let dispose = () => {};
    const finish = (quiet: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      input.signal.removeEventListener('abort', onAbort);
      dispose();
      resolve(decideSettle({ aborted: input.signal.aborted, pending: input.bridge.hostCalls().length,
        completion: input.turnFinished(), quiet, capacityRefused: input.capacityRefused() }));
    };
    const onAbort = () => finish(false);
    const arm = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), hostCallQuietMs);
    };
    const subscribed = input.bridge.events.subscribe((event) => {
      if (event.kind === 'host-call') arm();
      else if (event.kind === 'refused' && event.reason === 'capacity') finish(false);
    });
    if (subscribed.kind === 'ok') dispose = () => subscribed.value.dispose();
    if (input.turnFinished() || input.capacityRefused() || input.signal.aborted || subscribed.kind === 'error') finish(false);
    else {
      if (input.turnDone) void input.turnDone.then(() => finish(false));
      if (input.bridge.hostCalls().length > 0) arm();
      input.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
function decideSettle(facts: { readonly aborted: boolean; readonly pending: number; readonly completion: boolean; readonly quiet: boolean; readonly capacityRefused: boolean }): SettleChoice {
  if (facts.aborted) return facts.completion ? 'completion' : 'aborted';
  if (facts.pending > maxPendingPerMessage || facts.capacityRefused) return 'limit';
  if (facts.completion) return 'completion';
  if (facts.pending > 0 && facts.quiet) return 'pending';
  return 'wait';
}
function interruptResult(step: CleanupStep | 'timeout', completion: CodexTurnCompletion | undefined) {
  switch (step) {
    case 'replied':
      return { kind: 'interrupted' as const, evidence: Object.freeze({ namespace: 'codex-app-server/turn-interrupt', schemaVersion: 1, data: { step } }) };
    case 'not-needed':
      return completion?.kind === 'terminal' ? { kind: 'terminal-observed' as const } : { kind: 'unconfirmed-within-bound' as const };
    case 'rejected':
    case 'not-sent':
    case 'uncertain':
    case 'timeout':
      return { kind: 'unconfirmed-within-bound' as const };
    default: {
      const leftover: never = step;
      void leftover;
      return { kind: 'unconfirmed-within-bound' as const };
    }
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
