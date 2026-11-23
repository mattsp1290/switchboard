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
  HostPendingSet, HostModel, HostNativeError, HostLaunch, HostOpenOptions, HostRunInput, HostSegmentRequest, HostSegmentResult, HostToolCall, HostToolDeclaration, HostUsage,
  HostWriteStatus,
} from '../../core/host-adapter.js';
import type { InteractionContinuation } from '../../core/interaction.js';
import { hostImagesRequested, parseHostImages } from '../../core/image-input.js';
import type { SessionBinding } from '../../core/sessions.js';
import { codexActivityItem } from './activity.js';
import { listCodexModels } from './models.js';
import { boundedCodexMessage, codexNativeError, createCodexErrorIntake } from './native-errors.js';
import { codexSettlement } from './settlement.js';
import { codexImages, codexImageLimits, codexImageFrameBytes, codexOrdinaryFrameBytes, codexTurnInput } from './images.js';
import type { CodexImage } from './images.js';
import { createCodexWriters, openCodexExecution } from './execution.js';
import type { CodexInterruptResult, CodexSession, CodexTokenUsage, CodexTurnCompletion } from './execution.js';
import { monitorCodexTurn } from './turn-monitor.js';
import type { CodexTurnMonitor } from './turn-monitor.js';
import { codexCheckpoint, readCodexHistoryFingerprint } from './fingerprint.js';
import type { CodexApprovalsReviewer, CodexDynamicTool, CodexSandboxMode } from './features.js';
import { createCodexInteraction } from './interaction.js';
import type { CodexHostCall, CodexInteraction, CodexPreparedBatch } from './interaction.js';
import { codexProxyConfig } from './proxy.js';
import { checkCodexHostRoute, checkCodexRoute, codexHostRouteConfig } from './route.js';
import type { CodexHostRoute, CodexProxyRoute } from './route.js';
import { bindCodexRequester } from './sessions.js';
import { openCodexTransport } from './transport.js';
import type { BorrowedChannel, CodexTransport, TransportBounds } from './transport.js';

export type CodexHostModel = HostModel;
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
  readonly approvalPolicy?: 'never' | 'untrusted' | 'on-request';
  readonly approvalsReviewer?: CodexApprovalsReviewer;
  readonly model?: string;
  readonly effort?: string;
  readonly activity?: 'items';
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
  /** Resolve after owned stdout is drained/closed (Node ChildProcess 'close', not 'exit'). */
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
type SegmentError = Exclude<HostAdapterError, { readonly code: 'pending-limit' }>;
function failed(error: SegmentError, write: HostWriteStatus, nativeError?: HostNativeError): HostSegmentResult {
  return { kind: 'failed', error, write, ...(nativeError === undefined ? {} : { nativeError }) };
}
/** Native `total` as one observation row. `reasoningOutputTokens` is the AG-UI `reasoningTokens`. */
function usageRow(total: CodexTokenUsage): RunObservationUsage {
  return { inputTokens: total.inputTokens, outputTokens: total.outputTokens, cachedInputTokens: total.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens, reasoningTokens: total.reasoningOutputTokens,
    totalTokens: total.totalTokens };
}
/**
 * Pinned 0.169.0 `ServerNotification` reasoning methods, checked against `codex app-server generate-ts`:
 * `item/reasoning/textDelta` carries `{ threadId, turnId, itemId, delta, contentIndex }` and `item/reasoning/summaryTextDelta` adds a numeric
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
  if (!record(value)) return undefined;
  const fields = ['home', 'cwd', 'executable', 'sqliteHome', 'logDir', 'providerId', 'loopbackRelay', 'helper', 'envKey',
    'headerEnv', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'model', 'effort', 'activity', 'handlerTimeoutMs'] as const;
  const native: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field, value[field]]));
  if (typeof native.home !== 'string' || typeof native.cwd !== 'string') return undefined;
  if (!isAbsolute(native.home) || !isAbsolute(native.cwd) || native.home !== resolve(native.home) || native.cwd !== resolve(native.cwd)) return undefined;
  const executable = optionalString(native.executable);
  const sqliteHome = optionalString(native.sqliteHome);
  const logDir = optionalString(native.logDir);
  const providerId = optionalString(native.providerId);
  const envKey = optionalString(native.envKey);
  if (executable === false || sqliteHome === false || logDir === false || providerId === false || envKey === false) return undefined;
  if (executable !== undefined && !isAbsolute(executable)) return undefined;
  const approvalPolicy = native.approvalPolicy === 'never' || native.approvalPolicy === 'untrusted' || native.approvalPolicy === 'on-request' ? native.approvalPolicy : undefined;
  if (native.approvalPolicy !== undefined && approvalPolicy === undefined) return undefined;
  if (native.approvalsReviewer !== undefined && native.approvalsReviewer !== 'user'
    && native.approvalsReviewer !== 'auto_review' && native.approvalsReviewer !== 'guardian_subagent') return undefined;
  for (const field of ['model', 'effort'] as const) {
    if (native[field] !== undefined && (typeof native[field] !== 'string' || native[field].trim().length === 0)) return undefined;
  }
  if (native.activity !== undefined && native.activity !== 'items') return undefined;
  const handlerTimeoutMs = native.handlerTimeoutMs;
  if (handlerTimeoutMs !== undefined && (typeof handlerTimeoutMs !== 'number' || !timerBound(handlerTimeoutMs))) return undefined;
  const sandbox = sandboxes.find((mode) => mode === native.sandbox);
  if (native.sandbox !== undefined && sandbox === undefined) return undefined;
  if (native.loopbackRelay !== undefined && typeof native.loopbackRelay !== 'boolean') return undefined;
  const helper = helperOf(native.helper);
  if (helper === false) return undefined;
  let headerEnv: Readonly<Record<string, string>> | undefined;
  if (native.headerEnv !== undefined) {
    if (!record(native.headerEnv)) return undefined;
    const entries = Object.entries(native.headerEnv);
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) return undefined;
    headerEnv = Object.freeze(Object.fromEntries(entries));
  }
  return {
    home: native.home, cwd: native.cwd,
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(native.approvalsReviewer === undefined ? {} : { approvalsReviewer: native.approvalsReviewer }),
    ...(typeof native.model === 'string' ? { model: native.model } : {}),
    ...(typeof native.effort === 'string' ? { effort: native.effort } : {}),
    ...(native.activity === 'items' ? { activity: native.activity } : {}),
    ...(executable === undefined ? {} : { executable }),
    ...(sqliteHome === undefined ? {} : { sqliteHome }),
    ...(logDir === undefined ? {} : { logDir }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(envKey === undefined ? {} : { envKey }),
    ...(handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(native.loopbackRelay === undefined ? {} : { loopbackRelay: native.loopbackRelay }),
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
  const base = { approvalPolicy: config.approvalPolicy ?? 'never', cwd: config.cwd, ...(declared ? { dynamicTools: declared } : {}) };
  const chosen = config.sandbox ? { sandbox: config.sandbox } : {};
  switch (prepared.kind) {
    case 'direct':
      return { ...base, ...chosen, ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.approvalsReviewer === undefined ? {} : { approvalsReviewer: config.approvalsReviewer }) };
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
        if ((native.approvalPolicy !== undefined && native.approvalPolicy !== 'never')
          || native.approvalsReviewer !== undefined || native.model !== undefined) {
          return fail({ code: 'invalid-input', message: 'routes refuse direct approval and model overrides' });
        }
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
      transportBounds = { maxFrameBytes: codexOrdinaryFrameBytes,
        ...(prepared.kind === 'direct' ? { maxInboundFrameBytes: codexImageFrameBytes, maxOutboundFrameBytes: codexImageFrameBytes, maxChunkBytes: 16777215 } : { maxChunkBytes: 2097151 }), maxDiagnosticBytes: 65536,
        maxPending: 8, maxHandlers: 16, maxWrites: 8, observationCapacity: 256, handlerTimeoutMs,
        observationTimeoutMs: 5000, writeTimeoutMs: 20000 };
      const bridgeResult = createCodexInteraction({ maxObservers: 4, eventCapacity: 64, maxSettled: 32, maxPending: maxPendingPerMessage,
        transport: transportBounds, approvals: prepared.kind === 'direct' && (native.approvalPolicy === 'on-request' || native.approvalPolicy === 'untrusted'), userInput: enabled.has('request_user_input'),
        declaredTools: (options.tools ?? []).map((tool) => ({ name: tool.name, namespace: 'application' as const })) });
      if (bridgeResult.kind === 'error') return fail({ code: 'invalid-input', message: 'interaction bounds were rejected' });
      const bridge = bridgeResult.value;
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
  const lifetime = new AbortController();
  const errors = createCodexErrorIntake();
  let session: CodexSession | undefined;
  let detachSessionIntake: (() => void) | undefined;
  let segment: { turn: CodexTurnMonitor | undefined; phase: 'intent' | 'native'; text: string; usage: HostUsage; observer: RunObservationListener | undefined } | undefined;
  /** Whether `run-started` went out for this segment. */
  type SegmentState = { started: boolean };
  /** A segment result plus the native terminal a failed result hides. */
  type Settled = { readonly result: HostSegmentResult; readonly failedAs?: 'cancelled' | 'outcome-unknown' };
  let turn: CodexTurnMonitor | undefined;
  let settleChanged: (() => void) | undefined;
  let settleScheduled = false;
  const requestSettle = () => {
    if (settleScheduled) return;
    settleScheduled = true;
    queueMicrotask(() => { settleScheduled = false; settleChanged?.(); });
  };
  let nativeAccepted: DispatchEvidence | undefined;
  let activeTurnId: string | undefined;
  let nativeDiscarded = 0;
  let closing: ReturnType<HostAdapter['close']> | undefined;
  const facts: HostAdapterEvent[] = [];
  let publishing = false;
  function publishNext(): void {
    const fact = facts.shift();
    if (fact) stream.publish(fact);
    if (facts.length) queueMicrotask(publishNext);
    else publishing = false;
  }
  const publishFact = (event: HostAdapterEvent) => {
    const fact = Object.freeze(event);
    // Pace ordinary bursts so healthy observers can drain. Bound admission independently of consumer windows.
    if (facts.length === 512) {
      for (const queued of facts.splice(0)) stream.publish(queued);
      stream.publish(fact);
      return;
    }
    facts.push(fact);
    if (!publishing) { publishing = true; queueMicrotask(publishNext); }
  };
  const publish = (event: HostAdapterEvent) => { if (segment && segment.phase !== 'intent') publishFact(event); };
  const observe = (observation: RunObservation) => { if (segment && segment.phase !== 'intent') emitObservation(segment.observer, observation); };
  const observeTurn = (observation: RunObservation) => {
    if (!segment || segment.phase === 'intent') return;
    const listener = segment.observer; queueMicrotask(() => { emitObservation(listener, observation); });
  };
  const pendingSet = () => Object.freeze({ calls: Object.freeze(bridge.hostCalls().map(toCall)), approvals: bridge.pending() });
  const detachProjection = bridge.project((event) => {
    if (event.kind === 'pending' || event.kind === 'host-call' || event.kind === 'settled' || event.kind === 'host-settled'
      || (event.kind === 'refused' && event.reason === 'capacity')) requestSettle();
    const settlement = codexSettlement(event);
    if (settlement) publishFact(settlement);
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
      for (const o of declaredToolObservations(target.nativeToolCallId, event.call.name, event.call.arguments ?? null)) observeTurn(o);
    }
  });
  const nativeIntake = (method: string, params: unknown) => {
    if (!session || !record(params) || params.threadId !== session.threadId) return;
    if (native.activity === 'items') {
      const item = codexActivityItem(method, params);
      if (item) publishFact({ kind: 'native-item', item });
    }
    if (method === 'error' && session) errors.notification(params, session.threadId);
  };
  const resume = options.resume;
  const resumedKey = resume ? declarationKey(native.home, resume.session.opaque) : undefined;
  if (resumedKey && remembered.has(resumedKey) && remembered.get(resumedKey) !== canonical) {
    await execution.close();
    return fail({ code: 'invalid-input', message: 'tool declarations are fixed at session creation' });
  }
  if (resume?.expectedHistory) {
    const actual = await readCodexHistoryFingerprint(native.home, resume.session.opaque, 'stable');
    const checkpoint = actual && codexCheckpoint(resume.session, actual);
    if (!checkpoint || checkpoint.opaque !== resume.expectedHistory.opaque) {
      await execution.close();
      return fail({ code: 'history-mismatch', message: 'native history does not match the expected fingerprint' });
    }
  }
  if (resume) {
    const resumed = await execution.resume({ binding: resume.session.binding, reference: resume.session, signal, bounds: discovery,
      ...(ready.prepared.kind === 'direct' ? { params: { excludeTurns: true } } : {}),
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }), features: threadFeatures(ready.prepared, native, options) });
    if (resumed.kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: resumed.error.message ?? resumed.error.code }); }
    if (resumed.value.kind !== 'resumed') { await execution.close(); return fail({ code: 'busy', message: `resume is ${resumed.value.kind}` }); }
    session = resumed.value.session;
    if (bridge.attach(session).kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: 'interaction attach failed' }); }
    watch(session);
    rememberDeclaration(native.home, session.threadId, canonical);
  }
  function watch(current: CodexSession): void {
    const intake = current.intake({ notification: nativeIntake, turnEvent: (event) => {
      if (event.kind === 'turn-accepted') { activeTurnId = event.turnId; errors.accepted(event.turnId); }
      if ('turnId' in event && event.turnId !== activeTurnId) return;
      if (event.kind === 'early-overflow') { nativeDiscarded += event.discarded; return; }
      if (!segment || segment.phase === 'intent') return;
      if (event.kind === 'text-delta') {
        segment.text += event.delta;
        publish({ kind: 'text-delta', nativeItemId: event.itemId, text: event.delta });
        observeTurn({ kind: 'text', messageId: event.itemId, mode: 'delta', text: event.delta });
      } else if (event.kind === 'native') {
        if (record(event.params) && event.params.threadId === current.threadId && activeTurnId !== undefined
          && event.params.turnId === activeTurnId && segment.observer && reasoningMethods.some((method) => method === event.method) && record(event.params)
          && typeof event.params.itemId === 'string' && typeof event.params.delta === 'string') {
          const index = event.params.summaryIndex;
          const part = event.method === 'item/reasoning/textDelta' ? 'text'
            : typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? `summary:${index}` : 'summary';
          observeTurn({ kind: 'reasoning', messageId: `${event.params.itemId}:${part}`, mode: 'delta', text: event.params.delta });
        }
      } else if (event.kind === 'usage') {
        segment.usage = Object.freeze({ scope: 'cumulative', native: Object.freeze({ namespace: 'codex-app-server/token-usage',
          schemaVersion: 1, data: { total: event.total, last: event.last, modelContextWindow: event.modelContextWindow } }) });
        publish({ kind: 'usage', usage: segment.usage });
        observeTurn({ kind: 'usage', rows: [normalizeUsage(usageRow(event.total))] });
      }
    } });
    if (intake.kind === 'error') throw new Error('native intake unavailable');
    detachSessionIntake = intake.value;
  }
  async function credentialOk(hostSignal: AbortSignal): Promise<Extract<HostAdapterError, { readonly code: 'unavailable' }> | undefined> {
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
  function pendingSegment(active: CodexSession, current: NonNullable<typeof segment>, pending: HostPendingSet): HostSegmentResult {
    return { kind: 'pending', session: active.reference, ...pending, usage: current.usage };
  }
  async function settle(hostSignal: AbortSignal, accepted: DispatchEvidence | undefined): Promise<Settled> {
    const current = segment;
    const active = session;
    if (!current || !active) return { result: failed({ code: 'native-failure', message: 'no segment' }, { kind: 'not-attempted' }) };
    const observed = turn;
    if (nativeDiscarded > 0) {
      const completion = observed?.result();
      if (completion) return completionResult(active, current, completion, accepted, pendingSet());
      return discardedFailure(accepted, errors.current());
    }
    const { choice, pending } = await collectSettleChoice({ signal: hostSignal, pending: pendingSet,
      subscribe(listener) {
        settleChanged = listener;
        const detachTurn = observed?.segment(listener);
        return () => { detachTurn?.(); if (settleChanged === listener) settleChanged = undefined; };
      }, turnFinished: () => observed?.result() !== undefined, capacityRefused: bridge.capacityRefused });
    const turnResult = observed?.result();
    switch (choice) {
      case 'limit':
        return pendingLimit(accepted);
      case 'pending':
        return { result: pendingSegment(active, current, pending) };
      case 'completion':
        return turnResult ? completionResult(active, current, turnResult, accepted, pending)
          : { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' }, errors.current()) };
      case 'aborted':
        return { result: failed({ code: 'native-failure', message: 'the segment aborted' }, accepted ? { kind: 'accepted', evidence: accepted } : { kind: 'outcome-unknown' }, errors.current()),
          failedAs: 'outcome-unknown' };
      default: {
        const leftover: never = choice;
        void leftover;
        return { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' }, errors.current()) };
      }
    }
  }
  function discardedFailure(accepted: DispatchEvidence | undefined, cause: HostNativeError | undefined): Settled {
    return { result: failed({ code: 'native-failure', message: `${nativeDiscarded} pre-acknowledgement notifications were discarded` },
      accepted ? { kind: 'accepted', evidence: accepted } : { kind: 'outcome-unknown' }, cause), failedAs: 'outcome-unknown' };
  }
  function completionResult(active: CodexSession, current: NonNullable<typeof segment>, completion: CodexTurnCompletion,
    accepted: DispatchEvidence | undefined, pending: HostPendingSet): Settled {
    if (nativeDiscarded > 0) return discardedFailure(accepted, completion.kind === 'terminal' ? codexNativeError('turn.error', completion.terminal.error) ?? errors.current() : errors.current());
    const acceptedWrite: HostWriteStatus = accepted ? { kind: 'accepted', evidence: accepted } : { kind: 'outcome-unknown' };
    switch (completion.kind) {
      case 'terminal':
        switch (completion.terminal.status) {
          case 'completed':
            return { result: (pending.calls.length > 0 || pending.approvals.length > 0) ? pendingSegment(active, current, pending)
              : { kind: 'complete', session: active.reference, text: current.text, usage: current.usage } };
          case 'failed':
            return { result: failed({ code: 'native-failure', message: 'the native turn failed' }, acceptedWrite, codexNativeError('turn.error', completion.terminal.error) ?? errors.current()) };
          case 'interrupted':
            return { result: failed({ code: 'native-failure', message: 'the native turn was interrupted' }, acceptedWrite),
              failedAs: 'cancelled' };
          default: {
            const status: never = completion.terminal.status;
            return { result: failed({ code: 'native-failure', message: `the native turn status is ${String(status)}` }, acceptedWrite) };
          }
        }
      case 'rejected':
        return { result: failed({ code: 'native-failure', message: 'the native turn was rejected' }, acceptedWrite, codexNativeError('turn/start-reply', completion.error)) };
      case 'unconcluded':
        return { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, acceptedWrite, errors.current()), failedAs: 'outcome-unknown' };
      case 'not-sent':
      case 'not-dispatched':
        return { result: failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' }, errors.current()) };
      default: {
        const leftover: never = completion;
        return { result: failed({ code: 'native-failure', message: `the native turn outcome is ${String(leftover)}` }, { kind: 'outcome-unknown' }) };
      }
    }
  }
  function pendingLimit(accepted: DispatchEvidence | undefined): Settled {
    return accepted ? { result: { kind: 'failed', error: { code: 'pending-limit', message: 'one assistant message exceeded the pending limit' }, write: { kind: 'accepted', evidence: accepted } } }
      : { result: failed({ code: 'native-failure', message: 'the pending limit was exceeded without acceptance evidence for this segment' }, { kind: 'outcome-unknown' }) };
  }
  async function dispatchTurn(prompt: string | undefined, batch: CodexPreparedBatch | undefined, hostSignal: AbortSignal, images: readonly CodexImage[] = []) {
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
    if (batch) {
      // Parsed requests and lifecycle facts are applied in wire order before the synchronous full-set commit.
      execution.flushIntake();
      if (bridge.capacityRefused()) return { kind: 'pending-limit' as const };
      const replied = batch.commit(hostSignal, (answer, call) => {
        if (segment?.observer && answer.kind === 'tool' && call) {
          for (const observation of answeredToolObservations(answer.outcome.target.nativeToolCallId, call.name, call.arguments ?? null, answer.outcome.result)) observe(observation);
        }
      }, execution.flushIntake);
      const entry = await batch.entry;
      if (entry.kind === 'error') {
        if (bridge.capacityRefused()) return { kind: 'pending-limit' as const };
        return { kind: 'not-dispatched' as const, reason: entry.error.code === 'aborted' ? 'aborted' as const : 'intent-failed' as const };
      }
      nativeAccepted = undefined;
      const written = await batch.written;
      if (written.kind === 'error' || replied.kind === 'error') return { kind: 'outcome-unknown' as const };
      return { kind: 'locally-replied' as const };
    }
    if (prompt === undefined) return { kind: 'outcome-unknown' as const };
    bridge.beginTurn();
    activeTurnId = undefined;
    nativeDiscarded = 0;
    nativeAccepted = undefined;
    errors.begin();
    const started = active.turn({ hostOperationId: 'turn', input: codexTurnInput(prompt, images),
      ...(images.length ? { maxFrameBytes: codexImageFrameBytes } : {}),
      ...(native.effort === undefined ? {} : { features: { effort: native.effort } }),
      signal: hostSignal, recordIntent: () => {} });
    if (started.kind === 'error') return { kind: 'outcome-unknown' as const };
    turn = monitorCodexTurn(started.value.completion);
    if (segment) segment.turn = turn;
    const snapshot = await started.value.run();
    const observation = snapshot.observation;
    if (observation.kind === 'accepted' || observation.kind === 'conclusive') {
      const rejection = observation.kind === 'conclusive' && observation.result.kind === 'rejected'
        ? codexNativeError('turn/start-reply', observation.result.error) : undefined;
      const evidence: DispatchEvidence = { ...observation.evidence, observation: {
        ...observation.evidence.observation, data: Object.freeze(rejection
          ? { code: rejection.code, message: rejection.message, truncated: rejection.truncated }
          : { nativeTurnId: observation.evidence.nativeOperation?.id ?? null }) } };
      return { kind: 'accepted' as const, evidence };
    }
    return snapshot.observation.kind === 'outcome-unknown' || snapshot.observation.kind === 'not-dispatched'
      ? { kind: 'outcome-unknown' as const } : snapshot.observation;
  }
  async function segmentOf(input: HostSegmentRequest, prompt: string | undefined,
  answers: readonly InteractionContinuation[] | undefined, images: readonly CodexImage[] = []): Promise<HostSegmentResult> {
    if (!isOptionalObservationListener(input.onObservation)) {
      return failed({ code: 'invalid-input', message: 'onObservation must be a function' }, { kind: 'not-attempted' });
    }
    const state: SegmentState = { started: false };
    let settled: Settled | undefined;
    try {
      settled = await segmentInner(input, prompt, answers, state, images);
      return settled.result;
    } finally {
      // A throw after the run started still gives the baseline its one terminal.
      if (state.started) {
        emitObservation(input.onObservation, segmentTerminal(settled?.result, settled?.failedAs));
      }
    }
  }
  async function segmentInner(input: HostSegmentRequest, prompt: string | undefined,
  answers: readonly InteractionContinuation[] | undefined, state: SegmentState, images: readonly CodexImage[]): Promise<Settled> {
    const refuse = (...args: Parameters<typeof failed>): Settled => ({ result: failed(...args) });
    if (closing) return refuse({ code: 'closed', message: 'the adapter is closed' }, { kind: 'not-attempted' });
    if (segment) return refuse({ code: 'busy', message: 'a segment is already running' }, { kind: 'not-attempted' });
    if (!(input.signal instanceof AbortSignal)) return refuse({ code: 'invalid-input', message: 'a segment requires an AbortSignal' }, { kind: 'not-attempted' });
    const hostSignal = AbortSignal.any([input.signal, lifetime.signal]);
    let batch: CodexPreparedBatch | undefined;
    if (answers !== undefined) {
      const prepared = bridge.prepareBatch(answers);
      if (prepared.kind === 'error') return refuse({ code: 'invalid-input', message: 'continuations must cover the encodable pending set exactly' }, { kind: 'not-attempted' });
      if (bridge.capacityRefused()) return pendingLimit(nativeAccepted);
      batch = prepared.value;
    }
    if (prompt !== undefined && (bridge.hostCalls().length > 0 || bridge.pending().length > 0 || (turn !== undefined && turn.result() === undefined))) {
      return refuse({ code: 'busy', message: 'a turn is already in progress' }, { kind: 'not-attempted' });
    }
    if (closing) return refuse({ code: 'closed', message: 'the adapter is closed' }, { kind: 'not-attempted' });
    if (segment) return refuse({ code: 'busy', message: 'a segment is already running' }, { kind: 'not-attempted' });
    // prepareBatch executes caller getters, so the preceding guards recheck ownership before claiming it.
    segment = { turn: answers !== undefined ? turn : undefined, phase: 'intent', text: '', usage: emptyUsage(), observer: input.onObservation };
    const target: DispatchIdentity['target'] = session
      ? { kind: 'session', reference: session.reference } : { kind: 'new-session', binding };
    try {
      const denied = await credentialOk(hostSignal);
      if (denied) return refuse(denied, { kind: 'not-attempted' });
      const continuation: { result?: Extract<Awaited<ReturnType<typeof dispatchTurn>>, { readonly kind: 'not-dispatched' | 'locally-replied' | 'pending-limit' }> } = {};
      const handle = createDispatchOperation({ mode: 'fresh', signal: hostSignal, recordIntent: input.recordIntent,
        identity: { hostOperationId: input.hostOperationId, target },
        dispatchNative: async (recorded) => {
          if (segment) {
            segment.phase = 'native';
            state.started = true;
            emitRunStarted(segment.observer);
          }
          const observation = await dispatchTurn(prompt, batch, hostSignal, images);
          if (observation.kind === 'locally-replied' || observation.kind === 'pending-limit' || observation.kind === 'not-dispatched') {
            continuation.result = observation; return { kind: 'outcome-unknown' };
          }
          if (observation.kind !== 'accepted' && observation.kind !== 'conclusive') return { kind: 'outcome-unknown' };
          return { kind: 'accepted', evidence: { ...observation.evidence, identity: recorded } };
        } });
      const snapshot = await handle.run();
      if (batch && hostSignal.aborted && !batch.entered()) return refuse({ code: 'native-failure', message: 'the continuation was aborted before its first reply' }, { kind: 'not-dispatched', reason: 'aborted' });
      switch (continuation.result?.kind) {
        case 'not-dispatched': {
          const result = continuation.result;
          return refuse({ code: result.reason === 'aborted' ? 'native-failure' : 'invalid-input', message: result.reason === 'aborted' ? 'the continuation was aborted before its first reply' : 'the pending set changed before its first reply' }, result);
        }
        case 'pending-limit': return pendingLimit(nativeAccepted);
        case 'locally-replied': return await settle(hostSignal, undefined);
        case undefined: break;
        default: { const missing: never = continuation.result; return missing; }
      }
      if (snapshot.observation.kind === 'not-dispatched') {
        return refuse({ code: 'native-failure', message: snapshot.observation.reason }, { kind: 'not-dispatched', reason: snapshot.observation.reason });
      }
      if (snapshot.observation.kind !== 'accepted' && snapshot.observation.kind !== 'conclusive') {
        return refuse({ code: 'native-failure', message: 'the native outcome is unknown' }, { kind: 'outcome-unknown' }, errors.current());
      }
      nativeAccepted = snapshot.observation.evidence;
      return await settle(hostSignal, snapshot.observation.evidence);
    } finally { segment = undefined; }
  }
  const adapter: HostAdapter<'codex'> = { identity, capabilities: Object.freeze({
    imageInput: ready.prepared.kind === 'direct'
      ? { kind: 'supported' as const, api: codexImageLimits }
      : { kind: 'unavailable' as const, reason: 'image input is qualified on direct sessions only' },
    models: ready.prepared.kind === 'direct' ? { kind: 'supported' as const, api: {
      list: (signal: AbortSignal) => {
        try { return listCodexModels(execution.scope.request, AbortSignal.any([signal, lifetime.signal])); }
        catch { return Promise.resolve(fail({ code: 'invalid-input', message: 'Model listing requires an AbortSignal.' })); }
      },
    } } : { kind: 'unavailable' as const, reason: 'the route fixes the model' },
    maxPendingPerMessage, continuation: 'same-process', usage: 'cumulative', toolDeclarations: 'fixed-at-creation',
    inspect: { kind: 'supported' as const, api: { pending: async () => ({ kind: 'ok' as const, value: pendingSet() }) } },
    fingerprint: { kind: 'supported' as const, api: { validity: 'segment-end' as const, read: async () => {
      if (!session) return fail({ code: 'unavailable', feature: 'fingerprint', message: 'no session is open' });
      const actual = await readCodexHistoryFingerprint(native.home, session.threadId);
      return actual ? { kind: 'ok' as const, value: codexCheckpoint(session.reference, actual) }
        : fail({ code: 'unavailable', feature: 'fingerprint', message: 'no rollout fingerprint is available' });
    } } },
  }), events: Object.freeze({ subscribe: stream.subscribe }),
    run: (input: HostRunInput) => {
      try {
        const { prompt, images } = input;
        const request = segmentRequest(input);
        if (typeof prompt !== 'string') return Promise.resolve(failed({ code: 'invalid-input', message: 'The prompt must be text.' }, { kind: 'not-attempted' }));
        if (images === undefined) return segmentOf(request, prompt, undefined);
        if (ready.prepared.kind !== 'direct' && hostImagesRequested(images)) return Promise.resolve(failed({ code: 'unsupported', feature: 'image-input', message: 'image input requires a direct session' }, { kind: 'not-attempted' }));
        const validated = parseHostImages(images);
        if (validated.kind === 'error') return Promise.resolve(failed(validated.error, { kind: 'not-attempted' }));
        if (validated.value.length === 0) return segmentOf(request, prompt, undefined);
        const parsed = codexImages(validated.value, prompt, native.effort);
        if (parsed.kind === 'error') return Promise.resolve(failed(parsed.error, { kind: 'not-attempted' }));
        return segmentOf(request, prompt, undefined, parsed.value);
      } catch { return Promise.resolve(failed({ code: 'invalid-input', message: 'The run request is malformed.' }, { kind: 'not-attempted' })); }
    },
    continue: (input: HostContinueInput) => {
      try {
        const answers = input.answers;
        if (!Array.isArray(answers)) return Promise.resolve(failed({ code: 'invalid-input', message: 'A continuation requires an answer array.' }, { kind: 'not-attempted' }));
        return segmentOf(segmentRequest(input), undefined, answers);
      } catch { return Promise.resolve(failed({ code: 'invalid-input', message: 'The continuation request is malformed.' }, { kind: 'not-attempted' })); }
    },
    interrupt: async ({ timeoutMs }) => {
      if (execution.processExited()) return { kind: 'terminal-observed' as const };
      if (!timerBound(timeoutMs)) return { kind: 'unconfirmed-within-bound' as const };
      const observed = turn;
      const result = observed?.result();
      if (result?.kind === 'unconcluded') return { kind: 'unconfirmed-within-bound' as const };
      if (!observed || result !== undefined) {
        return segment && !(result?.kind === 'terminal' && segment.turn === observed)
          ? { kind: 'unconfirmed-within-bound' as const } : { kind: 'terminal-observed' as const };
      }
      const active = session;
      if (!active || closing) return { kind: 'unconfirmed-within-bound' as const };
      const attempt = observed.interrupt(() => active.interrupt({ signal: lifetime.signal }));
      return new Promise((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let detach: (() => void) | undefined;
        const finish = (value: ReturnType<typeof interruptResult>) => {
          if (done) return;
          done = true; clearTimeout(timer); detach?.(); resolve(value);
        };
        const changed = () => {
          const completion = observed.result();
          if (completion?.kind === 'terminal' || execution.processExited()) finish({ kind: 'terminal-observed' });
          else {
            const acknowledged = attempt.result();
            if (acknowledged) finish(interruptResult(acknowledged, completion));
          }
        };
        detach = observed.interruptWaiter(changed);
        if (!detach) { finish({ kind: 'unconfirmed-within-bound' }); return; }
        timer = setTimeout(() => finish({ kind: 'unconfirmed-within-bound' }), timeoutMs);
        changed();
      });
    },
    close: () => closing ??= (async () => {
      lifetime.abort();
      await execution.close();
      detachSessionIntake?.();
      detachProjection();
      stream.close();
      facts.length = 0;
      return { kind: 'ok' as const, value: undefined };
    })() };
  return { kind: 'ok' as const, value: adapter };
}
type SettleChoice = 'limit' | 'completion' | 'pending' | 'wait' | 'aborted';
async function collectSettleChoice(input: {
  readonly signal: AbortSignal;
  readonly subscribe: (listener: () => void) => () => void;
  readonly pending: () => HostPendingSet;
  readonly turnFinished: () => boolean;
  readonly capacityRefused: () => boolean;
}): Promise<{ readonly choice: Exclude<SettleChoice, 'wait'>; readonly pending: HostPendingSet }> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let dispose = () => {};
    const finish = (quiet: boolean) => {
      if (done) return;
      const pending = input.pending();
      const choice = decideSettle({ aborted: input.signal.aborted, pending: pending.calls.length, approvals: pending.approvals.length,
        completion: input.turnFinished(), quiet, capacityRefused: input.capacityRefused() });
      // Notifications are delivered asynchronously: a request may already have been withdrawn
      // when its pending event reaches us. Keep waiting for an actual pause or completion.
      if (choice === 'wait') { if (pending.calls.length) arm(); return; }
      done = true;
      clearTimeout(quietTimer);
      input.signal.removeEventListener('abort', onAbort);
      dispose();
      resolve({ choice, pending });
    };
    const onAbort = () => finish(false);
    const arm = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), hostCallQuietMs);
    };
    dispose = input.subscribe(() => finish(false));
    input.signal.addEventListener('abort', onAbort, { once: true });
    finish(false);

  });
}
function decideSettle(facts: { readonly aborted: boolean; readonly pending: number; readonly approvals: number; readonly completion: boolean; readonly quiet: boolean; readonly capacityRefused: boolean }): SettleChoice {
  if (facts.aborted) return facts.completion ? 'completion' : 'aborted';
  if ((facts.pending + facts.approvals) > maxPendingPerMessage || facts.capacityRefused) return 'limit';
  if (facts.completion) return 'completion';
  if (facts.approvals > 0) return 'pending';
  if (facts.pending > 0 && facts.quiet) return 'pending';
  return 'wait';
}
function interruptResult(result: CodexInterruptResult, completion: CodexTurnCompletion | undefined) {
  if (result.step === 'replied') {
    return completion?.kind === 'terminal' ? { kind: 'terminal-observed' as const }
      : { kind: 'interrupted' as const, evidence: Object.freeze({ namespace: 'codex-app-server/turn-interrupt', schemaVersion: 1, data: { step: result.step } }) };
  }
  if (result.step === 'not-needed' && completion?.kind === 'terminal') return { kind: 'terminal-observed' as const };
  if (result.step === 'rejected' && result.rejection) {
    return { kind: 'unconfirmed-within-bound' as const, evidence: Object.freeze({ namespace: 'codex-app-server/turn-interrupt', schemaVersion: 1,
      data: Object.freeze({ step: result.step, code: result.rejection.code, ...boundedCodexMessage(result.rejection.message) }) }) };
  }
  return { kind: 'unconfirmed-within-bound' as const };
}

function segmentRequest(input: HostSegmentRequest): HostSegmentRequest {
  const { hostOperationId, recordIntent, signal, onObservation } = input;
  return { hostOperationId, recordIntent, signal: AbortSignal.any([signal]), ...(onObservation === undefined ? {} : { onObservation }) };
}
