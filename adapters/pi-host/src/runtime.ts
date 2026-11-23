import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore, PI_AI_VERSION } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Message, Model, Provider, Usage } from '@earendil-works/pi-ai';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  hostImagesRequested, declaredToolObservations, createDispatchOperation, createEventStream, emitObservation, emitRunStarted,
  isOptionalObservationListener, jsonString, parseCheckpointReference, parseInteractionContinuation, parseSessionReference,
  segmentTerminal, usageFromCounts,
} from '#switchboard';
import type {
  DispatchEvidence, DispatchIdentity, HostAdapterError, HostAdapterEvent, HostSegmentRequest, HostSegmentResult, HostToolCall, HostToolDeclaration,
  HostUsage, Outcome, RunObservation, RunObservationListener, SessionBinding, SessionReference,
} from '#switchboard';
import { piHostIdentity, piHostLimits, validatePiHostSessionState } from './contract.js';
import type { PiHostAdapter, PiHostModelEvent, PiHostOpenOptions, PiHostSessionState, PiHostTurn } from './contract.js';
import { admitPiHostTransport } from './route.js';
import type { PiHostRouteBody, PiHostTransport } from './route.js';

const providerId = 'switchboard-host';
const modelId = 'host';

class OpenRefusal extends Error {
  constructor(readonly failure: HostAdapterError) { super(failure.message); }
}

type WorkResult =
  | { readonly kind: 'complete'; readonly text: string; readonly usage: HostUsage }
  | { readonly kind: 'pending'; readonly approvals: readonly []; readonly calls: readonly HostToolCall[]; readonly usage: HostUsage }
  | { readonly kind: 'model-failed'; readonly error: HostAdapterError };

function usageCounters(input = 0, output = 0): Usage {
  return {
    input, output, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function hostUsage(input: number, output: number): HostUsage {
  return { scope: 'segment', native: { namespace: 'pi-host', schemaVersion: 1, data: { input, output } } };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (typeof part !== 'object' || part === null || !('type' in part) || part.type !== 'text') return [];
    return 'text' in part && typeof part.text === 'string' ? [part.text] : [];
  }).join('');
}

function jsonObject(value: unknown): Record<string, never> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, never>;
}

function resources(instructions: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function hostToolDefinitions(tools: readonly HostToolDeclaration[], executed: string[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as never,
    executionMode: 'sequential' as const,
    async execute(toolCallId: string) {
      executed.push(toolCallId);
      return { content: [{ type: 'text' as const, text: '' }], details: { pending: true }, terminate: true };
    },
  }));
}

function turnsFrom(messages: readonly Message[], segment: number): PiHostTurn[] {
  return messages.map((message) => {
    if (message.role === 'toolResult') {
      const pending = typeof message.details === 'object' && message.details !== null
        && 'pending' in message.details && message.details.pending === true;
      return { segment, role: 'tool', text: textOf(message.content), toolCallId: message.toolCallId, name: message.toolName,
        ...(pending ? { pending: true } : {}) };
    }
    if (message.role === 'assistant') {
      const toolCalls = message.content.flatMap((part) => part.type === 'toolCall'
        ? [{ id: part.id, name: part.name, arguments: part.arguments }] : []);
      return { segment, role: 'assistant', text: textOf(message.content), ...(toolCalls.length > 0 ? { toolCalls } : {}) };
    }
    return { segment, role: message.role, text: textOf(message.content) };
  });
}

function messagesFrom(turns: readonly PiHostTurn[]): Message[] {
  return turns.map((turn) => {
    if (turn.role === 'system') return { role: 'system', content: turn.text, timestamp: 1 };
    if (turn.role === 'user') return { role: 'user', content: turn.text, timestamp: 1 };
    if (turn.role === 'tool') {
      return { role: 'toolResult', toolCallId: turn.toolCallId ?? '', toolName: turn.name ?? '',
        content: [{ type: 'text', text: turn.text }], isError: false, timestamp: 1,
        details: { pending: turn.pending === true } };
    }
    const toolCalls = (turn.toolCalls ?? []).flatMap((call) => {
      const argumentsValue = jsonObject(call.arguments);
      return argumentsValue === undefined ? [] : [{ type: 'toolCall' as const, id: call.id, name: call.name, arguments: argumentsValue }];
    });
    return { role: 'assistant', content: [...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []), ...toolCalls],
      api: providerId, provider: providerId, model: modelId, usage: usageCounters(),
      stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop', timestamp: 1 };
  });
}

interface Collected {
  readonly text: string;
  readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: Record<string, never> }[];
  /** Absent when no `usage` event arrived for this request. */
  readonly usage?: { readonly input: number; readonly output: number } | undefined;
  readonly failure?: 'mixed' | 'limit' | 'arguments' | 'duplicate';
}

function collectEvents(events: readonly PiHostModelEvent[], names: ReadonlySet<string>, answered: (id: string) => boolean): Collected {
  let text = '';
  let usage: Collected['usage'];
  const calls: Collected['calls'][number][] = [];
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === 'text') text += event.text;
    else if (event.kind === 'usage') usage = { input: event.input, output: event.output };
    else {
      const argumentsValue = jsonObject(event.arguments);
      if (argumentsValue === undefined || !identifier(event.id, 1024) || !identifier(event.name, 256)) {
        return { text, calls: [], usage, failure: 'arguments' };
      }
      if (ids.has(event.id) || answered(event.id)) return { text, calls: [], usage, failure: 'duplicate' };
      ids.add(event.id);
      calls.push({ id: event.id, name: event.name, arguments: argumentsValue });
    }
  }
  if (calls.length > piHostLimits.maxPendingPerMessage) return { text, calls: [], usage, failure: 'limit' };
  if (calls.some((call) => !names.has(call.name))) return { text, calls: [], usage, failure: 'mixed' };
  return { text, calls, usage };
}

function emitAssistant(stream: AssistantMessageEventStream, collected: Collected, sink: {
  text: (delta: string) => void;
  tool: (call: Collected['calls'][number], phase: 'start' | 'end') => void;
  /** One call per provider request; `usage` is absent when the request reported none. */
  boundary: (usage: { input: number; output: number } | undefined) => void;
  /** The public usage publish counts an unreported request as zero; the observation row exists only when reported. */
  usage: (usage: { input: number; output: number } | undefined) => void;
}): void {
  const message: AssistantMessage = {
    role: 'assistant', content: [], api: providerId, provider: providerId, model: modelId,
    usage: usageCounters(collected.usage?.input ?? 0, collected.usage?.output ?? 0), stopReason: 'stop', timestamp: Date.now(),
  };
  stream.push({ type: 'start', partial: message });
  sink.boundary(collected.usage);
  let index = 0;
  if (collected.text.length > 0) {
    message.content = [{ type: 'text', text: '' }];
    stream.push({ type: 'text_start', contentIndex: 0, partial: message });
    message.content = [{ type: 'text', text: collected.text }];
    stream.push({ type: 'text_delta', contentIndex: 0, delta: collected.text, partial: message });
    sink.text(collected.text);
    stream.push({ type: 'text_end', contentIndex: 0, content: collected.text, partial: message });
    index = 1;
  }
  if (collected.failure) {
    message.stopReason = 'error';
    message.errorMessage = collected.failure;
    stream.push({ type: 'error', reason: 'error', error: message });
    return;
  }
  for (const call of collected.calls) {
    const toolCall = { type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.arguments };
    message.content = [...message.content, toolCall];
    stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
    sink.tool(call, 'start');
    stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message });
    sink.tool(call, 'end');
    index += 1;
  }
  message.stopReason = collected.calls.length > 0 ? 'toolUse' : 'stop';
  sink.usage(collected.usage);
  stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
}

function hostProvider(load: (body: PiHostRouteBody, signal: AbortSignal) => Promise<readonly PiHostModelEvent[]>, names: ReadonlySet<string>, answered: (id: string) => boolean, makeSink: () => Parameters<typeof emitAssistant>[2], segment: () => number, instructions: string, tools: readonly HostToolDeclaration[], note: { failure?: Collected['failure']; refusal: HostAdapterError | undefined }): Provider {
  const model: Model<string> = {
    id: modelId, name: 'host', api: providerId, provider: providerId, baseUrl: 'http://127.0.0.1:9', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192,
  };
    const deliver = (messages: readonly Message[], signal: AbortSignal | undefined) => {
    const stream = new AssistantMessageEventStream();
    const sink = makeSink();
    void (async () => {
      try {
        const body: PiHostRouteBody = { model: modelId, protocol: 'switchboard-host', instructions,
          turns: turnsFrom(messages, segment()), tools };
        const requestSignal = signal ?? new AbortController().signal;
        const loaded = await load(body, requestSignal);
        if (requestSignal.aborted) {
          const aborted: AssistantMessage = { ...modelMessage(), stopReason: 'aborted', errorMessage: 'aborted' };
          stream.push({ type: 'error', reason: 'aborted', error: aborted });
          return;
        }
        const collected = collectEvents(loaded, names, answered);
        note.failure = collected.failure;
        emitAssistant(stream, collected, sink);
      } catch (error) {
        if (error instanceof OpenRefusal) note.refusal = error.failure;
        const failed: AssistantMessage = { ...modelMessage(), stopReason: 'error', errorMessage: 'The host stream failed.' };
        stream.push({ type: 'error', reason: 'error', error: failed });
      }
    })();
    return stream;
  };
  return {
    id: providerId, name: 'Switchboard host', baseUrl: 'http://127.0.0.1:9',
    // The empty auth result marks the provider configured. It carries no token; a host stream has no credential.
    auth: { apiKey: { name: 'host stream',
      check: async () => ({ type: 'api_key', source: 'host-stream' }),
      resolve: async () => ({ auth: {}, source: 'host-stream' }) } },
    getModels: () => [model],
    stream: (_model, context, options) => deliver(context.messages, options?.signal),
    streamSimple: (_model, context, options) => deliver(context.messages, options?.signal),
  };
}

function modelMessage(): AssistantMessage {
  return { role: 'assistant', content: [], api: providerId, provider: providerId, model: modelId,
    usage: usageCounters(), stopReason: 'error', timestamp: Date.now() };
}

async function eventsFromStream(stream: NonNullable<PiHostOpenOptions['stream']>, body: PiHostRouteBody, signal: AbortSignal): Promise<readonly PiHostModelEvent[]> {
  const events: PiHostModelEvent[] = [];
  for await (const event of stream({ instructions: body.instructions, turns: body.turns, tools: body.tools, signal })) {
    if (signal.aborted) break;
    events.push(event);
  }
  return events;
}

function identifier(value: string, limit: number): boolean {
  if (value.trim().length === 0 || value.length > limit) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

async function eventsFromRoute(transport: Extract<PiHostTransport, { kind: 'route' }>, body: PiHostRouteBody, signal: AbortSignal): Promise<readonly PiHostModelEvent[]> {
  const result = await transport.request(body, signal);
  if (result.kind === 'error') throw new OpenRefusal(result.error);
  return result.events;
}

function requireOptions(options: PiHostOpenOptions, signal: AbortSignal): {
  readonly instructions: string;
  readonly tools: readonly HostToolDeclaration[];
  readonly state: PiHostSessionState | undefined;
  readonly tempRoot: string;
} {
  if (!(signal instanceof AbortSignal)) throw new OpenRefusal({ code: 'invalid-input', message: 'The open signal is not an AbortSignal.' });
  if (options.launch?.kind !== 'in-process') throw new OpenRefusal({ code: 'invalid-input', message: 'The Pi host adapter launches in-process.' });
  if (options.environment === undefined || typeof options.environment.variables !== 'object' || options.environment.variables === null) {
    throw new OpenRefusal({ code: 'invalid-input', message: 'The Pi host adapter requires a host environment.' });
  }
  for (const value of Object.values(options.environment.variables)) {
    if (typeof value !== 'string') throw new OpenRefusal({ code: 'invalid-input', message: 'Host environment variables must be strings.' });
  }
  if (options.subagents !== 'off') throw new OpenRefusal({ code: 'invalid-input', message: 'The Pi host adapter runs with subagents off.' });
  if (options.builtInTools !== undefined && options.builtInTools.length > 0) {
    throw new OpenRefusal({ code: 'unavailable', feature: 'built-in-tools', message: 'Built-in tools are off in the host-owned Pi adapter.' });
  }
  if (options.resume !== undefined) {
    throw new OpenRefusal({ code: 'unsupported', feature: 'directory-resume', message: 'Directory resume is not available. Import session state instead.' });
  }
  if (options.instructions !== undefined && (typeof options.instructions !== 'string' || options.instructions.length > piHostLimits.maxText)) {
    throw new OpenRefusal({ code: 'invalid-input', message: 'Instructions must be a string within the published limit.' });
  }
  if (options.onState !== undefined && typeof options.onState !== 'function') {
    throw new OpenRefusal({ code: 'invalid-input', message: 'onState must be a function.' });
  }
  const tools = options.tools ?? [];
  if (tools.length > piHostLimits.maxTools) throw new OpenRefusal({ code: 'invalid-input', message: 'Too many host tools.' });
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(tool.name) || typeof tool.description !== 'string'
      || typeof tool.inputSchema !== 'object' || tool.inputSchema === null || Array.isArray(tool.inputSchema) || names.has(tool.name)) {
      throw new OpenRefusal({ code: 'invalid-input', message: 'Host tool declarations are fixed and must be unique JSON-schema tools.' });
    }
    names.add(tool.name);
  }
  if (options.state !== undefined && !validatePiHostSessionState(options.state)) {
    throw new OpenRefusal({ code: 'invalid-input', message: 'The imported session state does not match the published schema.' });
  }
  const tempRoot = options.environment.variables.TMPDIR ?? options.environment.variables.TMP ?? options.environment.variables.TEMP;
  if (tempRoot === undefined || !isAbsolute(tempRoot)) {
    throw new OpenRefusal({ code: 'invalid-input', message: 'The host environment must name an absolute temp directory.' });
  }
  return { instructions: options.instructions ?? '', tools, state: options.state, tempRoot };
}

export async function openPiHostSession(options: PiHostOpenOptions, signal: AbortSignal): Promise<Outcome<PiHostAdapter, HostAdapterError>> {
  let directory: string | undefined;
  try {
    const admitted = requireOptions(options, signal);
    const transportResult = admitPiHostTransport({
      stream: options.stream !== undefined, route: options.route, invocationId: randomUUID(),
    });
    if (transportResult.kind === 'error') return transportResult;
    const active = options.stream !== undefined
      ? { kind: 'stream' as const, stream: options.stream }
      : transportResult.value.kind === 'route' ? transportResult.value
        : undefined;
    if (active === undefined) return { kind: 'error', error: { code: 'invalid-input', message: 'The host stream is missing.' } };
    directory = await mkdtemp(join(admitted.tempRoot, 'pi-host-'));
    const names = new Set(admitted.tools.map((tool) => tool.name));
    const answered = new Set<string>();
    let continuation: {
      readonly results: ReadonlyMap<string, { readonly text: string; readonly isError: boolean }>;
      readonly targets: readonly HostToolCall['pending']['target'][];
      readonly undo: () => void;
    } | undefined;
    function clearContinuation(rollback: boolean): void {
      const staged = continuation;
      continuation = undefined;
      if (rollback) staged?.undo();
    }
    const executed: string[] = [];
    const note: { failure?: Collected['failure']; refusal: HostAdapterError | undefined } = { refusal: undefined };
    let segmentNumber = admitted.state === undefined ? 1
      : admitted.state.turns.reduce((max, turn) => Math.max(max, turn.segment), 0) + 1;
    const load = (body: PiHostRouteBody, requestSignal: AbortSignal) => active.kind === 'stream'
      ? eventsFromStream(active.stream, body, requestSignal)
      : eventsFromRoute(active, body, requestSignal);
    // The current segment's listener. One segment is one baseline, so `dispatch` sets and clears it.
    let observer: RunObservationListener | undefined;
    const observe = (observation: RunObservation) => { emitObservation(observer, observation); };
    // Native counts reach the baseline only when valid; an invalid count drops its field, never the model boundary.
    const observedCounts = (usage: { input: number; output: number } | undefined) =>
      usage === undefined ? undefined : usageFromCounts({ inputTokens: usage.input, outputTokens: usage.output });
    // A request binds the listener of the segment that issued it, so a late event from an aborted segment cannot reach the next one.
    const sinkFor = (listener: RunObservationListener | undefined) => ({
      text: (delta: string) => {
        publish({ kind: 'text-delta', nativeItemId: 'assistant', text: delta });
        emitObservation(listener, { kind: 'text', messageId: 'assistant', mode: 'delta', text: delta });
      },
      tool: (call: { id: string; name: string; arguments: unknown }, phase: 'start' | 'end') => {
        const target = { kind: 'tool' as const, session: reference(), nativeToolCallId: call.id };
        if (phase === 'start') {
          publish({ kind: 'tool-call-start', target, name: call.name });
          publish({ kind: 'tool-call-arguments-delta', target, delta: JSON.stringify(call.arguments) });
          emitObservation(listener, { kind: 'tool', callId: call.id, name: call.name, phase: 'started' });
        } else {
          publish({ kind: 'tool-call-end', target, arguments: call.arguments });
          const argumentsJson = listener ? jsonString(call.arguments) : undefined;
          emitObservation(listener, { kind: 'tool', callId: call.id, name: call.name, phase: 'arguments-ended', ...(argumentsJson === undefined ? {} : { argumentsJson }) });
        }
      },
      // Each provider request is one model boundary, with usage only when that request reported it. A later request's
      // terminal usage row replaces an earlier one (same key), so the final request's counts stand.
      boundary: (usage: { input: number; output: number } | undefined) => {
        const row = observedCounts(usage);
        emitObservation(listener, { kind: 'model-boundary', ...(row === undefined ? {} : { usage: row }) });
      },
      usage: (usage: { input: number; output: number } | undefined) => {
        publish({ kind: 'usage', usage: hostUsage(usage?.input ?? 0, usage?.output ?? 0) });
        const row = observedCounts(usage);
        if (row !== undefined) emitObservation(listener, { kind: 'usage', rows: [row] });
      },
    });
    const provider = hostProvider(load, names, (id) => answered.has(id) || (continuation?.results.has(id) ?? false), () => sinkFor(observer), () => segmentNumber, admitted.instructions, admitted.tools, note);
    const credentials = new InMemoryCredentialStore();
    const models = await ModelRuntime.create({
      credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    });
    // A provider refresh looks for Google application-default credentials. The host provider is already
    // in the snapshot, and this no-op stays in place so a later refresh cannot scan the disk.
    const registered = models as ModelRuntime & { refresh(options?: { allowNetwork?: boolean }): Promise<unknown> };
    registered.refresh = async () => ({ aborted: false, errors: new Map() });
    registered.registerNativeProvider(provider);
    const model = provider.getModels()[0];
    if (model === undefined) throw new OpenRefusal({ code: 'native-failure', message: 'The host model was not registered.' });
    const manager = SessionManager.inMemory(directory, admitted.state ? { id: admitted.state.sessionId } : undefined);
    if (admitted.state) {
      for (const turn of admitted.state.turns) {
        if (turn.role === 'tool' && turn.toolCallId !== undefined && turn.pending !== true) answered.add(turn.toolCallId);
      }
      for (const message of messagesFrom(admitted.state.turns)) manager.appendMessage(message);
    }
    const created = await createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime: models, model, thinkingLevel: 'off',
      tools: [...names], noTools: 'builtin', customTools: hostToolDefinitions(admitted.tools, executed),
      resourceLoader: resources(admitted.instructions), sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false, transport: 'sse',
      }),
    });
    if (created.extensionsResult.extensions.length > 0 || created.extensionsResult.errors.length > 0) {
      throw new OpenRefusal({ code: 'unavailable', feature: 'extensions', message: 'Extensions are off in the host-owned Pi adapter.' });
    }
    const session = created.session;
    // Pi 1.5.2 runs every call in the batch. beforeToolCall can block one call, and terminate stops the
    // loop only after the whole batch. A mixed batch is refused before any tool call is emitted.
    session.agent.toolExecution = 'sequential';
    session.agent.beforeToolCall = async ({ assistantMessage, toolCall }) => {
      const calls = assistantMessage.content.filter((part) => part.type === 'toolCall');
      if (calls.some((call) => !names.has(call.name)) || !names.has(toolCall.name)) {
        return { block: true, terminate: true, reason: 'mixed-batch' };
      }
      return undefined;
    };
    const binding: SessionBinding = {
      engine: 'pi', nativeVersion: PI_AI_VERSION,
      account: options.route?.scope.account ?? 'host',
      authorizedScope: active.kind === 'route' ? active.principal : 'host-stream',
      nativeFormat: 'pi-host-state-v1',
    };
    const parsed = parseSessionReference({
      value: { kind: 'session', formatVersion: 1, binding, opaque: session.sessionId }, expected: binding,
    });
    if (parsed.kind === 'error') throw new OpenRefusal({ code: 'native-failure', message: 'The Pi session id is not a valid session reference.' });
    const sessionReference: SessionReference = parsed.value;
    const events = createEventStream<HostAdapterEvent>({ maxObservers: 8, capacity: 64 });
    const publish = (event: HostAdapterEvent) => { events.publish(event); };
    let current: PiHostSessionState = admitted.state === undefined
      ? { formatVersion: 1, sessionId: session.sessionId, turns: [] }
      : structuredClone(admitted.state);
    let seen = session.messages.length;
    let pending: readonly HostToolCall[] = pendingCalls(current, sessionReference);
    let requiresReopen = false;
    let running = false;
    let closed = false;
    let stopping: (() => void) | undefined;
    let stopped: Promise<void> | undefined;
    let agentRun: Promise<void> | undefined;
    const reference = () => sessionReference;
    function exportState(): PiHostSessionState | undefined {
      const fresh = turnsFrom(session.messages.slice(seen).filter((message): message is Message =>
        message.role === 'system' || message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult'), segmentNumber);
      const next = { formatVersion: 1 as const, sessionId: session.sessionId, turns: [...current.turns.map((turn) => {
        const result = turn.role === 'tool' && turn.toolCallId ? continuation?.results.get(turn.toolCallId) : undefined;
        return result ? { ...turn, text: result.text, pending: false } : turn;
      }), ...fresh] };
      if (!validatePiHostSessionState(next)) return undefined;
      seen = session.messages.length;
      segmentNumber += 1;
      current = next;
      return next;
    }
    function toolCalls(message: AssistantMessage | undefined): HostToolCall[] {
      if (!message) return [];
      return message.content.flatMap((part) => part.type === 'toolCall' ? [{
        pending: { kind: 'tool' as const, target: { kind: 'tool' as const, session: sessionReference, nativeToolCallId: part.id } },
        name: part.name, arguments: part.arguments,
      }] : []);
    }
    async function finish(signal: AbortSignal): Promise<WorkResult> {
      if (signal.aborted) throw new OpenRefusal({ code: 'native-failure', message: 'The segment was aborted.' });
      const assistant = session.messages.findLast((message) => message.role === 'assistant');
      const failure = note.failure;
      const refusal = note.refusal;
      note.failure = undefined;
      note.refusal = undefined;
      const usage = hostUsage(assistant?.role === 'assistant' ? assistant.usage.input : 0, assistant?.role === 'assistant' ? assistant.usage.output : 0);
      if (refusal) return { kind: 'model-failed', error: refusal };
      if (failure === 'limit') return { kind: 'model-failed', error: { code: 'pending-limit', message: 'The assistant message asked for more host calls than the pending limit.' } };
      if (failure === 'mixed') return { kind: 'model-failed', error: { code: 'invalid-input', message: 'A mixed tool batch is not a host-tool set.' } };
      if (failure === 'duplicate') return { kind: 'model-failed', error: { code: 'invalid-input', message: 'One call identifier cannot have two results.' } };
      if (failure === 'arguments' || failure !== undefined) return { kind: 'model-failed', error: { code: 'native-failure', message: 'The host stream failed.' } };
      if (assistant?.role === 'assistant' && (assistant.stopReason === 'error' || assistant.stopReason === 'aborted')) {
        return { kind: 'model-failed', error: { code: 'native-failure', message: 'The host stream failed.' } };
      }
      const calls = toolCalls(assistant?.role === 'assistant' ? assistant : undefined);
      const exported = exportState();
      if (exported === undefined) return { kind: 'model-failed', error: { code: 'native-failure', message: 'The exported session state does not match the published schema.' } };
      pending = calls;
      for (const id of continuation?.results.keys() ?? []) answered.add(id);
      for (const target of continuation?.targets ?? []) publish({ kind: 'tool-delivery', target, delivery: { kind: 'unknown' } });
      clearContinuation(false);
      options.onState?.(exported);
      if (calls.length > 0) return { kind: 'pending', calls, approvals: [], usage };
      return { kind: 'complete', text: assistant?.role === 'assistant' ? textOf(assistant.content) : '', usage };
    }
    async function dispatch(input: HostSegmentRequest, work: () => Promise<void>): Promise<HostSegmentResult> {
      const { hostOperationId, recordIntent, onObservation } = input;
      let hostSignal: AbortSignal;
      try { hostSignal = AbortSignal.any([input.signal]); }
      catch { return { kind: 'failed', error: { code: 'invalid-input', message: 'A segment requires a signal.' }, write: { kind: 'not-attempted' } }; }
      if (!isOptionalObservationListener(onObservation)) {
        return { kind: 'failed', error: { code: 'invalid-input', message: 'onObservation must be a function.' }, write: { kind: 'not-attempted' } };
      }
      if (closed) return { kind: 'failed', error: { code: 'closed', message: 'The Pi host adapter is closed.' }, write: { kind: 'not-attempted' } };
      if (requiresReopen) return { kind: 'failed', error: { code: 'native-failure', message: 'Reopen from the last exported state after an uncertain continuation.' }, write: { kind: 'not-attempted' } };
      if (running) return { kind: 'failed', error: { code: 'busy', message: 'A segment is already running.' }, write: { kind: 'not-attempted' } };
      running = true;
      observer = onObservation;
      let started = false;
      const identity: DispatchIdentity = { hostOperationId, target: { kind: 'session', reference: sessionReference } };
      const evidence: DispatchEvidence = { identity, source: 'native-acknowledgement',
        nativeOperation: { namespace: 'pi-host', id: hostOperationId },
        observation: { namespace: 'pi-host', schemaVersion: 1, data: { accepted: true } } };
      let settle = () => {};
      stopped = new Promise<void>((resolve) => { settle = resolve; });
      stopping = () => { session.agent.abort(); };
      hostSignal.addEventListener('abort', stopping, { once: true });
      // The terminal goes out with the final result, after native work and state export are done. A segment that never reached native dispatch has no baseline.
      const attempt = async (): Promise<HostSegmentResult> => {
        try {
          const handle = createDispatchOperation<WorkResult>({
            mode: 'fresh', signal: hostSignal, identity, recordIntent,
            dispatchNative: async () => {
              started = true;
              emitRunStarted(observer, ['reasoning']);
              await work();
              const assistant = session.messages.findLast((message) => message.role === 'assistant');
              const aborted = hostSignal.aborted || (assistant?.role === 'assistant' && assistant.stopReason === 'aborted');
              if (aborted) {
                return { kind: 'outcome-unknown' };
              }
              const result = await finish(hostSignal);
              return { kind: 'conclusive', evidence, result };
            },
          });
          const snapshot = await handle.run();
          const observation = snapshot.observation;
          if (observation.kind === 'conclusive') {
            const value = observation.result;
            if (value.kind === 'model-failed') {
              const write = { kind: 'accepted' as const, evidence: observation.evidence };
              // The branches look identical but TypeScript needs `pending-limit` narrowed to pair it with an accepted write.
              return value.error.code === 'pending-limit'
                ? { kind: 'failed', error: value.error, write }
                : { kind: 'failed', error: value.error, write };
            }
            return { ...value, session: sessionReference };
          }
          return { kind: 'failed', error: { code: 'native-failure', message: 'The segment did not finish.' }, write: observation };
        } catch (error) {
          if (error instanceof OpenRefusal && error.failure.code !== 'pending-limit') {
            return { kind: 'failed', error: error.failure, write: { kind: 'not-attempted' } };
          }
          return { kind: 'failed', error: { code: 'invalid-input', message: 'The segment was refused before dispatch.' }, write: { kind: 'not-attempted' } };
        }
      };
      try {
        const result = await attempt();
        if (started) observe(segmentTerminal(result));
        return result;
      } finally {
        if (continuation) requiresReopen = true;
        clearContinuation(true);
        observer = undefined;
        hostSignal.removeEventListener('abort', stopping);
        stopping = undefined;
        running = false;
        settle();
      }
    }
    const adapter: PiHostAdapter = {
      identity: piHostIdentity,
      capabilities: {
        imageInput: { kind: 'unsupported', reason: 'image input is not supported' },
        models: { kind: 'unsupported', reason: 'model catalog is not supported' },
        maxPendingPerMessage: piHostLimits.maxPendingPerMessage, continuation: 'fresh-process', usage: 'segment',
        toolDeclarations: 'fixed-at-creation',
        inspect: { kind: 'supported', api: { pending: async (pendingSignal) => pendingSignal.aborted
          ? { kind: 'error', error: { code: 'native-failure', message: 'The pending read was aborted.' } }
          : { kind: 'ok', value: { calls: pending, approvals: [] } } } },
        fingerprint: { kind: 'supported', api: { validity: 'segment-end', read: async () => {
          const opaque = createHash('sha256').update(JSON.stringify(current)).digest('hex');
          const checkpoint = parseCheckpointReference({
            value: { kind: 'checkpoint', formatVersion: 1, binding, sessionOpaque: sessionReference.opaque, opaque },
            session: sessionReference,
          });
          return checkpoint.kind === 'ok' ? { kind: 'ok', value: checkpoint.value }
            : { kind: 'error', error: { code: 'native-failure', message: 'The session fingerprint could not be read.' } };
        } } },
      },
      events: events,
      state: () => current,
      async run(input) {
        let requestedImages: boolean;
        try { const images = input.images; requestedImages = hostImagesRequested(images); } catch { return { kind: 'failed', error: { code: 'invalid-input', message: 'image input is malformed' }, write: { kind: 'not-attempted' } }; }
        if (requestedImages) return { kind: 'failed', error: { code: 'unsupported', feature: 'image-input', message: 'image input is not supported' }, write: { kind: 'not-attempted' } };
        const prompt = input.prompt;
        if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > piHostLimits.maxText) {
          return { kind: 'failed', error: { code: 'invalid-input', message: 'The prompt must be a non-empty string.' }, write: { kind: 'not-attempted' } };
        }
        return dispatch(input, async () => {
          await session.prompt(prompt, { expandPromptTemplates: false });
          await session.waitForIdle();
        });
      },
      async continue(input) {
        if (pending.length === 0 || !Array.isArray(input.answers)) {
          return { kind: 'failed', error: { code: 'invalid-input', message: 'The continuation must cover the pending set exactly once.' }, write: { kind: 'not-attempted' } };
        }
        const expected = new Map(pending.map((call) => [call.pending.target.nativeToolCallId, call]));
        const replacements = new Map<string, { text: string; isError: boolean }>();
        const observedAnswers: RunObservation[] = [];
        for (const answer of input.answers) {
          const id = answerId(answer);
          const call = id === undefined ? undefined : expected.get(id);
          if (id === undefined || call === undefined || replacements.has(id) || answered.has(id)) {
            return { kind: 'failed', error: { code: 'invalid-input', message: 'The continuation must cover the pending set exactly once.' }, write: { kind: 'not-attempted' } };
          }
          const parsed = parseInteractionContinuation({ value: answer, expected: call.pending });
          if (parsed.kind === 'error' || parsed.value.kind !== 'tool') {
            return { kind: 'failed', error: { code: 'invalid-input', message: 'A continuation answer did not match its pending call.' }, write: { kind: 'not-attempted' } };
          }
          const result = parsed.value.outcome.result;
          const data = result.kind === 'ok' ? result.value.data : result.error.data;
          let text: string;
          try { const serialized = JSON.stringify(data);
            if (serialized === undefined || serialized.length > piHostLimits.maxText) throw new Error('unexportable tool result');
            text = serialized;
            replacements.set(id, { text, isError: result.kind === 'error' });
          } catch { return { kind: 'failed', error: { code: 'invalid-input', message: 'The tool result must be JSON.' }, write: { kind: 'not-attempted' } }; }
          if (input.onObservation) {
            observedAnswers.push(...declaredToolObservations(id, call.name, call.arguments),
              { kind: 'tool', callId: id, name: call.name, phase: result.kind === 'ok' ? 'completed' : 'failed', resultJson: text });
          }
        }
        if (replacements.size !== expected.size) {
          return { kind: 'failed', error: { code: 'invalid-input', message: 'The continuation must cover the pending set exactly once.' }, write: { kind: 'not-attempted' } };
        }
        return dispatch(input, async () => {
          const prior: { readonly message: Extract<Message, { role: 'toolResult' }>;
            readonly content: Extract<Message, { role: 'toolResult' }>['content']; readonly isError: boolean; readonly details: Extract<Message, { role: 'toolResult' }>['details'] }[] = [];
          const undo: (() => void)[] = [];
          const restore = () => {
            for (let index = undo.length - 1; index >= 0; index--) {
              try { undo[index]?.(); } catch { /* the failed segment requires reopening; finish the remaining undo operations */ }
            }
          };
          continuation = { results: replacements, targets: [...expected.values()].map(call => call.pending.target), undo: restore };
          const messages = [...session.messages, ...manager.getEntries().flatMap(entry => entry.type === 'message' ? [entry.message] : [])];
          for (const message of messages) {
            if (message.role === 'toolResult' && replacements.has(message.toolCallId)) {
              prior.push({ message, content: message.content, isError: message.isError, details: message.details });
            }
          }
          for (const saved of prior) {
            const { message } = saved;
            const replacement = replacements.get(message.toolCallId);
            message.content = [{ type: 'text', text: replacement?.text ?? '' }];
            undo.push(() => { message.content = saved.content; });
            message.isError = replacement?.isError ?? false;
            undo.push(() => { message.isError = saved.isError; });
            message.details = { pending: false };
            undo.push(() => {
              if (saved.details === undefined) delete message.details;
              else message.details = saved.details;
            });
          }
          for (const o of observedAnswers) observe(o);
          try {
            agentRun = session.agent.continue();
            await agentRun;
            await session.waitForIdle();
          } finally {
            agentRun = undefined;
          }
        });
      },
      async interrupt({ timeoutMs }) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) return { kind: 'unconfirmed-within-bound' };
        const stop = stopping;
        const done = stopped;
        if (!stop || !done) return { kind: 'terminal-observed' };
        stop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
          const winner = await Promise.race([done.then(() => 'done' as const), timeout]);
          return winner === 'done' ? { kind: 'terminal-observed' } : { kind: 'unconfirmed-within-bound' };
        } finally { clearTimeout(timer); }
      },
      async close() {
        const running = agentRun;
        closed = true;
        stopping?.();
        try { await session.abort(); } catch { /* dispose still runs */ }
        try { await running; } catch { /* the segment observes this failure */ }
        try { session.dispose(); } catch { /* closing still releases the directory */ }
        events.close();
        if (directory === undefined) {
          return { kind: 'error', error: { code: 'native-failure', message: 'The Pi host session could not be closed.' } };
        }
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          return { kind: 'error', error: { code: 'native-failure', message: 'The Pi host session could not be closed.' } };
        }
        return { kind: 'ok', value: undefined };
      },
    };
    return { kind: 'ok', value: adapter };
  } catch (error) {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof OpenRefusal) return { kind: 'error', error: error.failure };
    return { kind: 'error', error: { code: 'native-failure', message: 'The Pi host session could not be opened.' } };
  }
}

function pendingCalls(state: PiHostSessionState, session: SessionReference): HostToolCall[] {
  const done = new Set(state.turns.flatMap((turn) => turn.role === 'tool' && turn.toolCallId && turn.pending !== true ? [turn.toolCallId] : []));
  return state.turns.flatMap((turn) => turn.role === 'assistant' && turn.toolCalls ? turn.toolCalls.flatMap((call) => done.has(call.id) ? [] : [{
    pending: { kind: 'tool' as const, target: { kind: 'tool' as const, session, nativeToolCallId: call.id } },
    name: call.name, arguments: call.arguments,
  }]) : []);
}

function answerId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'tool' || !('outcome' in value)) return undefined;
  const outcome = value.outcome;
  if (typeof outcome !== 'object' || outcome === null || !('target' in outcome)) return undefined;
  const target = outcome.target;
  if (typeof target !== 'object' || target === null || !('nativeToolCallId' in target)) return undefined;
  return typeof target.nativeToolCallId === 'string' ? target.nativeToolCallId : undefined;
}
