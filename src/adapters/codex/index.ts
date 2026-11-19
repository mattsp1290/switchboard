import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { createAuthContext } from '../../core/auth.js';
import type { AuthConfiguration, AuthScope } from '../../core/auth.js';
import { createDispatchOperation } from '../../core/dispatch.js';
import type { DispatchEvidence, DispatchIdentity } from '../../core/dispatch.js';
import { createEventStream } from '../../core/events.js';
import type { HostAdapter, HostAdapterError, HostAdapterEvent, HostAdapterRegistration, HostContinueInput,
  HostLaunch, HostOpenOptions, HostRunInput, HostSegmentResult, HostToolCall, HostToolDeclaration, HostUsage,
} from '../../core/host-adapter.js';
import type { InteractionContinuation } from '../../core/interaction.js';
import { parseInteractionContinuation } from '../../core/interaction.js';
import type { SessionBinding } from '../../core/sessions.js';
import { createCodexWriters, openCodexExecution } from './execution.js';
import type { CleanupStep, CodexSession, CodexTurnCompletion } from './execution.js';
import { codexCheckpoint, readCodexHistoryFingerprint } from './fingerprint.js';
import type { CodexDynamicTool, CodexSandboxMode } from './features.js';
import { createCodexInteraction } from './interaction.js';
import type { CodexHostCall, CodexInteraction } from './interaction.js';
import { codexHostRouteConfig, codexProxyConfig } from './proxy.js';
import { checkCodexRoute, copyCodexHostRoute } from './route.js';
import type { CodexHostRoute, CodexProxyRoute } from './route.js';
import { bindCodexRequester } from './sessions.js';
import { openCodexTransport } from './transport.js';
import type { BorrowedChannel, TransportBounds } from './transport.js';

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
/** In-process memory of the declarations sent at thread/start. A fresh process starts empty. */
const remembered = new Map<string, string>();
const discovery = Object.freeze({ maxResults: 10, maxExamined: 10, maxDurationMs: 5000 });
const featurePins = [
  { keys: ['shell_tool', 'unified_exec', 'shell_snapshot'], on: (enabled: ReadonlySet<string>) => enabled.has('shell') || enabled.has('shell_tool'),
    off: 'the engine shell is on and the host did not enable it' },
  { keys: ['view_image'], on: (enabled: ReadonlySet<string>) => enabled.has('view_image'),
    off: 'view_image is on and the host did not leave it on' },
  { keys: ['request_user_input', 'default_mode_request_user_input'], on: (enabled: ReadonlySet<string>) => enabled.has('request_user_input'),
    off: 'request_user_input is on and the host did not leave it on' },
] as const;
const pinsMultiAgent = (routed: boolean, subagents: 'off' | undefined) => routed || subagents === 'off';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (error: HostAdapterError) => ({ kind: 'error' as const, error: Object.freeze(error) });
const failed = (error: HostAdapterError, write: HostSegmentResult & { kind: 'failed' } extends infer T ? T extends { write: infer W } ? W : never : never): HostSegmentResult =>
  ({ kind: 'failed', error, write }) as HostSegmentResult;
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
function featureArgs(enabled: ReadonlySet<string>, subagents: 'off' | undefined, routed: boolean): readonly string[] {
  const args: string[] = [];
  const set = (name: string, on: boolean) => { args.push('-c', `features.${name}=${JSON.stringify(on)}`); };
  for (const pin of featurePins) for (const key of pin.keys) set(key, pin.on(enabled));
  if (pinsMultiAgent(routed, subagents)) { set('multi_agent', false); set('multi_agent_v2', false); }
  return args;
}
const timerBound = (value: number) => Number.isInteger(value) && value >= 1 && value <= 2147483647;
function echoPins(features: Record<string, unknown>, enabled: ReadonlySet<string>): string | undefined {
  for (const pin of featurePins) {
    if (!pin.on(enabled) && pin.keys.some((key) => features[key] !== false)) return pin.off;
  }
  return undefined;
}
function nativeOf(value: unknown): CodexHostNativeConfig | undefined {
  if (!record(value) || typeof value.home !== 'string' || typeof value.cwd !== 'string') return undefined;
  if (!isAbsolute(value.home) || !isAbsolute(value.cwd) || value.home !== resolve(value.home)) return undefined;
  return value as unknown as CodexHostNativeConfig;
}
function toCall(call: CodexHostCall): HostToolCall {
  return Object.freeze({ pending: call.pending, name: call.name, arguments: call.arguments });
}

interface PreparedRoute { readonly proxy?: CodexProxyRoute; readonly host?: CodexHostRoute; readonly args: readonly string[] }
function prepareRoute(config: AuthConfiguration<unknown>, scope: AuthScope, native: CodexHostNativeConfig):
{ readonly route: PreparedRoute } | { readonly problem: string } | { readonly unavailable: string } {
  if (config.kind === 'direct') return { problem: 'direct credentials are not a Codex host route' };
  const helperOff = native.helper === 'unavailable';
  if ((config.kind === 'litellm' || (config.kind === 'host-route' && config.credentialForm === 'helper')) && helperOff) {
    return { unavailable: 'helper' };
  }
  if (config.kind === 'litellm') {
    const providerId = native.providerId ?? 'litellm';
    const helper = native.helper;
    if (helper === undefined || helper === 'unavailable') return { problem: 'the helper form needs a host command' };
    const checked = checkCodexRoute({ kind: 'litellm-proxy', providerId, endpoint: config.endpoint, credentialPurpose: 'litellm-proxy',
      model: config.model, scope: { engine: scope.engine, account: scope.account } });
    if ('problem' in checked) return checked;
    const configured = codexProxyConfig(checked.route, { helper });
    if ('problem' in configured) return configured;
    return { route: { proxy: checked.route, args: configured.config.args } };
  }
  const providerId = native.providerId ?? 'host';
  const helper = config.credentialForm === 'helper' && native.helper !== 'unavailable' && native.helper !== undefined ? native.helper : undefined;
  const built = copyCodexHostRoute({ kind: 'host-route', providerId, endpoint: config.endpoint, protocol: config.protocol,
    credentialForm: config.credentialForm, principal: config.principal, loopbackRelay: native.loopbackRelay === true,
    model: config.model, scope: { engine: scope.engine, account: scope.account },
    sqliteHome: native.sqliteHome, logDir: native.logDir,
    ...(config.credentialForm === 'bearer' ? { envKey: native.envKey, headerEnv: native.headerEnv } : {}),
    ...(helper ? { helperCommand: helper } : {}) });
  if (!built) return { problem: 'host route is invalid' };
  const configured = codexHostRouteConfig(built);
  if ('problem' in configured) return configured;
  return { route: { host: built, args: configured.config.args } };
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
      const routed = options.route != null;
      let prepared: PreparedRoute = { args: featureArgs(enabled, options.subagents, routed) };
      if (routed && native.sandbox === 'danger-full-access') {
        return fail({ code: 'invalid-input', message: 'a host route refuses danger-full-access' });
      }
      const handlerTimeoutMs = native.handlerTimeoutMs ?? 180000;
      if (!timerBound(handlerTimeoutMs)) return fail({ code: 'invalid-input', message: 'handlerTimeoutMs is outside 1..2147483647' });
      const bridgeResult = createCodexInteraction({ maxObservers: 4, eventCapacity: 64, maxSettled: 32, maxPending: 9,
        transport: { maxHandlers: 16, handlerTimeoutMs }, userInput: enabled.has('request_user_input'),
        declaredTools: (options.tools ?? []).map((tool) => ({ name: tool.name, namespace: 'application' as const })) });
      if (bridgeResult.kind === 'error') return fail({ code: 'invalid-input', message: 'interaction bounds were rejected' });
      const bridge = bridgeResult.value;
      transportBounds = { maxFrameBytes: 1048576, maxChunkBytes: 2097151, maxDiagnosticBytes: 65536,
        maxPending: 8, maxHandlers: 16, maxWrites: 8, observationCapacity: 256, handlerTimeoutMs,
        observationTimeoutMs: 5000, writeTimeoutMs: 20000 };
      if (options.route) {
        const route = prepareRoute(options.route.config, options.route.scope, native);
        if ('unavailable' in route) return fail({ code: 'unavailable', feature: route.unavailable, message: 'The host cannot run a credential helper' });
        if ('problem' in route) return fail({ code: 'invalid-input', message: route.problem });
        prepared = { ...route.route, args: [...route.route.args, ...featureArgs(enabled, options.subagents, true)] };
      }
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
        onServerRequest: bridge.onServerRequest, ...(prepared.proxy ? { route: prepared.proxy } : prepared.host ? { route: prepared.host } : {}) });
      if (opened.kind === 'error') {
        if (transportBounds) await releaseSpawned(channel, transportBounds);
        return fail({ code: opened.error.code === 'invalid-input' ? 'invalid-input' : 'native-failure',
          message: opened.error.message ?? 'Codex app-server handshake failed' });
      }
      execution = opened.value;
      const admittedRoute = prepared.host !== undefined || prepared.proxy !== undefined;
      const pinned = await pinnedFeatures(opened.value.scope.request, enabled, signal, admittedRoute, pinsMultiAgent(admittedRoute, options.subagents));
      if (pinned) { await execution.close(); return fail({ code: 'invalid-input', message: pinned }); }
      const bound = await bindCodexRequester({ scope: opened.value.scope, bounds: discovery, signal, nativeFormat: 'codex-thread/paginated' });
      if (bound.kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: 'Codex requester was not admitted' }); }
      return await finishOpen({ options, signal, native, enabled, prepared, bridge, execution: opened.value, binding: bound.value.binding, variables });
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

async function pinnedFeatures(request: (call: { method: string; params?: unknown }, signal: AbortSignal) => Promise<{ kind: string; envelope?: { reply?: { kind: string; value?: unknown } } }>,
  enabled: ReadonlySet<string>, signal: AbortSignal, routed: boolean, multiAgent: boolean): Promise<string | undefined> {
  const exchange = await request({ method: 'config/read', params: { includeLayers: false } }, signal);
  const reply = exchange.kind === 'reply' ? exchange.envelope?.reply : undefined;
  const config = reply?.kind === 'result' && record(reply.value) && record(reply.value.config) ? reply.value.config : undefined;
  if (routed && !config) return 'the route config could not be read';
  const features = config && record(config.features) ? config.features : {};
  const mismatch = echoPins(features, enabled);
  if (mismatch) return mismatch;
  if (!routed && multiAgent && (features.multi_agent !== false || features.multi_agent_v2 !== false)) return 'multi-agent is not pinned off';
  return undefined;
}

function finishOpen(ready: {
  readonly options: HostOpenOptions<CodexHostLaunch, CodexHostNativeConfig>;
  readonly signal: AbortSignal; readonly native: CodexHostNativeConfig; readonly enabled: ReadonlySet<string>;
  readonly prepared: PreparedRoute; readonly bridge: CodexInteraction;
  readonly execution: Awaited<ReturnType<typeof openCodexExecution>> extends infer T ? T extends { kind: 'ok'; value: infer V } ? V : never : never;
  readonly binding: SessionBinding; readonly variables: Readonly<Record<string, string>>;
}) {
  return openAdapter(ready);
}

async function openAdapter(ready: Parameters<typeof finishOpen>[0]) {
  const { options, signal, native, bridge, execution, binding, variables } = ready;
  const tools = options.tools ?? [];
  const canonical = canonicalTools(tools);
  const stream = createEventStream<HostAdapterEvent>({ maxObservers: 4, capacity: 64 });
  let session: CodexSession | undefined;
  let segment: { phase: 'intent' | 'native'; text: string; usage: HostUsage } | undefined;
  let turnCompletion: Promise<CodexTurnCompletion> | undefined;
  let turnResult: CodexTurnCompletion | undefined;
  let capacityRefused = false;
  let closing: ReturnType<HostAdapter['close']> | undefined;
  const publish = (event: HostAdapterEvent) => { if (segment && segment.phase !== 'intent') stream.publish(Object.freeze(event)); };
  const calls = () => bridge.hostCalls().map(toCall);
  execution.events.subscribe(() => {});
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
  });
  const resume = options.resume;
  if (resume && remembered.has(resume.session.opaque) && remembered.get(resume.session.opaque) !== canonical) {
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
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }), features: threadFeatures(native, options) });
    if (resumed.kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: resumed.error.message ?? resumed.error.code }); }
    if (resumed.value.kind !== 'resumed') { await execution.close(); return fail({ code: 'busy', message: `resume is ${resumed.value.kind}` }); }
    session = resumed.value.session;
    if (bridge.attach(session).kind === 'error') { await execution.close(); return fail({ code: 'native-failure', message: 'interaction attach failed' }); }
    watch(session);
    remembered.set(session.threadId, canonical);
  }
  function watch(current: CodexSession): void {
    current.events.subscribe((event) => {
      if (!segment || segment.phase === 'intent') return;
      if (event.kind === 'text-delta') {
        segment.text += event.delta;
        publish({ kind: 'text-delta', nativeItemId: event.itemId, text: event.delta });
      } else if (event.kind === 'usage') {
        segment.usage = Object.freeze({ scope: 'cumulative', native: Object.freeze({ namespace: 'codex-app-server/token-usage',
          schemaVersion: 1, data: { total: event.total, last: event.last, modelContextWindow: event.modelContextWindow } }) });
        publish({ kind: 'usage', usage: segment.usage });
      }
    });
  }
  function threadFeatures(config: CodexHostNativeConfig, openOptions: HostOpenOptions<CodexHostLaunch, CodexHostNativeConfig>) {
    const declared = openOptions.resume ? undefined : dynamicTools(openOptions.tools ?? []);
    const sandbox = config.sandbox ?? (ready.prepared.host ? 'read-only' as const : undefined);
    return { approvalPolicy: 'never' as const, cwd: config.cwd,
      ...(sandbox ? { sandbox } : {}),
      ...(options.route ? { model: options.route.config.model } : {}),
      ...(declared ? { dynamicTools: declared } : {}) };
  }
  async function credentialOk(hostSignal: AbortSignal): Promise<HostAdapterError | undefined> {
    const route = options.route;
    const host = ready.prepared.host;
    if (!route || !host || host.credentialForm !== 'bearer' || !host.envKey) return undefined;
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
  async function settle(hostSignal: AbortSignal, accepted: DispatchEvidence): Promise<HostSegmentResult> {
    const current = segment;
    const active = session;
    if (!current || !active) return failed({ code: 'native-failure', message: 'no segment' }, { kind: 'not-attempted' });
    const limited = (): HostSegmentResult => {
      capacityRefused = false;
      return failed({ code: 'pending-limit', message: 'one assistant message produced more host calls than the pending limit' },
        { kind: 'accepted', evidence: accepted });
    };
    let quiet = 0;
    while (true) {
      const sampled = hostSignal.aborted || turnResult || !turnCompletion ? turnResult
        : await Promise.race([turnCompletion.then((value) => value), delay(20).then(() => undefined)]);
      const pending = bridge.hostCalls();
      const choice = decideSettle({ aborted: hostSignal.aborted, pending: pending.length, completion: sampled !== undefined, quiet, capacityRefused });
      if (choice === 'limit') return limited();
      if (choice === 'pending') return pendingSegment(active, current, pending);
      if (choice === 'completion' && sampled) return completionResult(active, current, sampled, accepted, pending);
      if (choice === 'aborted') return failed({ code: 'native-failure', message: 'the segment aborted' }, { kind: 'accepted', evidence: accepted });
      if (pending.length > 0) quiet += 1; else quiet = 0;
      await delay(10);
    }
  }
  function completionResult(active: CodexSession, current: NonNullable<typeof segment>, completion: CodexTurnCompletion,
    accepted: DispatchEvidence, pending: readonly CodexHostCall[]): HostSegmentResult {
    const acceptedWrite = { kind: 'accepted' as const, evidence: accepted };
    switch (completion.kind) {
      case 'terminal':
        switch (completion.terminal.status) {
          case 'completed':
            return pending.length > 0 ? pendingSegment(active, current, pending)
              : { kind: 'complete', session: active.reference, text: current.text, usage: current.usage };
          case 'failed':
            return failed({ code: 'native-failure', message: 'the native turn failed' }, acceptedWrite);
          case 'interrupted':
            return failed({ code: 'native-failure', message: 'the native turn was interrupted' }, acceptedWrite);
          default: {
            const status: never = completion.terminal.status;
            return failed({ code: 'native-failure', message: `the native turn status is ${String(status)}` }, acceptedWrite);
          }
        }
      case 'rejected':
        return failed({ code: 'native-failure', message: 'the native turn was rejected' }, acceptedWrite);
      case 'unconcluded':
      case 'not-sent':
      case 'not-dispatched':
        return failed({ code: 'native-failure', message: 'the native turn outcome is unknown' }, { kind: 'outcome-unknown' });
      default: {
        const leftover: never = completion;
        return failed({ code: 'native-failure', message: `the native turn outcome is ${String(leftover)}` }, { kind: 'outcome-unknown' });
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
        features: threadFeatures(native, options) });
      if (created.kind === 'error') return { kind: 'outcome-unknown' as const };
      session = created.value;
      remembered.set(session.threadId, canonical);
      if (bridge.attach(session).kind === 'error') return { kind: 'outcome-unknown' as const };
      watch(session);
    }
    const active = session;
    if (!active) return { kind: 'outcome-unknown' as const };
    if (answers) {
      for (const answer of answers) {
        const replied = await bridge.reply({ value: answer, signal: hostSignal, recordIntent: () => {} });
        if (replied.kind === 'error') return { kind: 'outcome-unknown' as const };
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
      return parseInteractionContinuation({ value: answer, expected: expected.pending }).kind === 'ok';
    }) && ids.size === 0;
  }
  async function segmentOf(input: { readonly hostOperationId: string; readonly recordIntent: HostRunInput['recordIntent'];
    readonly signal: AbortSignal }, prompt: string | undefined, answers: readonly InteractionContinuation[] | undefined): Promise<HostSegmentResult> {
    if (closing) return failed({ code: 'closed', message: 'the adapter is closed' }, { kind: 'not-attempted' });
    if (segment) return failed({ code: 'busy', message: 'a segment is already running' }, { kind: 'not-attempted' });
    if (answers && !answersMatch(answers)) return failed({ code: 'invalid-input', message: 'continuations must cover the pending set exactly' }, { kind: 'not-attempted' });
    if (prompt !== undefined && (bridge.hostCalls().length > 0 || (turnCompletion !== undefined && turnResult === undefined))) {
      return failed({ code: 'busy', message: 'a turn is already in progress' }, { kind: 'not-attempted' });
    }
    segment = { phase: 'intent', text: '', usage: emptyUsage() };
    const target: DispatchIdentity['target'] = session
      ? { kind: 'session', reference: session.reference } : { kind: 'new-session', binding };
    try {
      const denied = await credentialOk(input.signal);
      if (denied) return failed(denied, { kind: 'not-attempted' });
      const handle = createDispatchOperation({ mode: 'fresh', signal: input.signal, recordIntent: input.recordIntent,
        identity: { hostOperationId: input.hostOperationId, target },
        dispatchNative: async (recorded) => {
          if (segment) segment.phase = 'native';
          const observation = await dispatchTurn(prompt, answers, input.signal);
          if (observation.kind !== 'accepted' && observation.kind !== 'conclusive') return { kind: 'outcome-unknown' };
          return { kind: 'accepted', evidence: { ...observation.evidence, identity: recorded } };
        } });
      const snapshot = await handle.run();
      if (snapshot.observation.kind === 'not-dispatched') {
        return failed({ code: 'native-failure', message: snapshot.observation.reason }, { kind: 'not-dispatched', reason: snapshot.observation.reason });
      }
      if (snapshot.observation.kind !== 'accepted' && snapshot.observation.kind !== 'conclusive') {
        return failed({ code: 'native-failure', message: 'the native outcome is unknown' }, { kind: 'outcome-unknown' });
      }
      return await settle(input.signal, snapshot.observation.evidence);
    } finally { segment = undefined; }
  }
  const adapter: HostAdapter<'codex'> = { identity, capabilities: Object.freeze({
    maxPendingPerMessage: 8, continuation: 'same-process', usage: 'cumulative', toolDeclarations: 'fixed-at-creation',
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
    close: () => closing ??= (async () => { await execution.close(); stream.close(); return { kind: 'ok' as const, value: undefined }; })() };
  return { kind: 'ok' as const, value: adapter };
}
type SettleChoice = 'limit' | 'completion' | 'pending' | 'wait' | 'aborted';
function decideSettle(facts: { readonly aborted: boolean; readonly pending: number; readonly completion: boolean; readonly quiet: number; readonly capacityRefused: boolean }): SettleChoice {
  if (facts.aborted) return facts.completion ? 'completion' : 'aborted';
  if (facts.pending > 8 || facts.capacityRefused) return 'limit';
  if (facts.completion) return 'completion';
  if (facts.pending > 0 && facts.quiet >= 2) return 'pending';
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
