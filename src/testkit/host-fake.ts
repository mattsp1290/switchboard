import { types } from 'node:util';
import {
  createDispatchOperation, createEventStream, parseCheckpointReference, parseInteractionContinuation, parseSessionReference,
} from '../index.js';
import type {
  CheckpointReference, DispatchEvidence, DispatchTarget, HostAdapter, HostAdapterCapabilities, HostAdapterError, HostAdapterEvent,
  HostAdapterRegistration, HostContinueInput, HostLaunch, HostOpenOptions, HostSegmentRequest, HostSegmentResult,
  HostToolCall, HostUsage, HostWriteStatus, Outcome, SessionReference,
} from '../index.js';
import type { HostConformanceSubject } from './host-contracts.js';

export interface FakeHostOptions {
  readonly continuation?: 'same-process' | 'fresh-process';
  readonly maxPendingPerMessage?: number;
  readonly inspect?: boolean;
  readonly fingerprint?: 'segment-end' | 'after-process-exit' | 'unsupported';
  /** Deliberate contract violations that the conformance suite must reject. */
  readonly faults?: { readonly fallbackOnDeniedLaunch?: boolean; readonly dropExtraCalls?: boolean };
}

interface NativeSession {
  readonly reference: SessionReference;
  readonly toolKey: string;
  turns: number;
  calls: readonly HostToolCall[] | null;
  holder: object | null;
  segmentOpen: boolean;
}

const namespace = 'switchboard-host-fake';
const binding = Object.freeze({ engine: 'fixture-host', nativeVersion: '1', account: 'test-account',
  authorizedScope: 'test-scope', nativeFormat: 'fixture-host-v1' });
const prompts = Object.freeze({ text: 'reply with text', toolCall: 'call the tool', twoToolCalls: 'call the tool twice' });
const tool = Object.freeze({ name: 'lookup', description: 'Looks up a fixture value.', inputSchema: Object.freeze({ type: 'object' }) });
const evidence = Object.freeze({ namespace, schemaVersion: 1, data: Object.freeze({}) });

function refuse(error: HostAdapterError): Outcome<never, HostAdapterError> {
  return { kind: 'error', error: Object.freeze(error) };
}
type SegmentError = Exclude<HostAdapterError, { readonly code: 'pending-limit' }>;
function failed(error: SegmentError, write: HostWriteStatus = { kind: 'not-attempted' }): HostSegmentResult {
  return Object.freeze({ kind: 'failed', error: Object.freeze(error), write });
}
const invalid = (message: string): SegmentError => ({ code: 'invalid-input', message });
const closedError: SegmentError = { code: 'closed', message: 'The adapter is closed.' };

function historyOf(session: NativeSession): CheckpointReference {
  return Object.freeze({ kind: 'checkpoint', formatVersion: 1, binding, sessionOpaque: session.reference.opaque,
    opaque: `history-${session.turns}` });
}

/** A controlled in-memory host adapter: no process, no model and no native engine. It qualifies nothing native. */
export function createFakeHostSubject(options: FakeHostOptions = {}): HostConformanceSubject {
  const { continuation = 'same-process', maxPendingPerMessage = 1, inspect = true, fingerprint = 'segment-end',
    faults = {} } = options;
  const sessions = new Map<string, NativeSession>();
  const counts = { attempts: 0, signals: 0 };
  const identity = Object.freeze({ engine: 'fixture-host', adapter: namespace, version: '1', contractVersion: 1 as const });
  let operations = 0;

  function launch(mode: 'allow' | 'deny'): HostLaunch {
    return { kind: 'spawn', spawn: () => {
      counts.attempts++;
      if (mode === 'deny') throw new Error('The host launcher denied the launch.');
      return { kill: () => { counts.signals++; } };
    } };
  }

  async function open(settings: HostOpenOptions, signal: AbortSignal): Promise<Outcome<HostAdapter, HostAdapterError>> {
    if (signal.aborted) return refuse({ code: 'native-failure', message: 'Open was aborted.' });
    const tools = settings.tools ?? [];
    if (new Set(tools.map((declared) => declared.name)).size !== tools.length) return refuse(invalid('Tool names must be unique.'));
    if (settings.launch !== undefined) {
      const { launch: lent } = settings;
      if (lent.kind !== 'spawn' || typeof lent.spawn !== 'function') {
        return refuse({ code: 'unsupported', feature: 'launch', message: 'The fake launches only through a spawn function.' });
      }
      try {
        lent.spawn();
      } catch {
        if (!faults.fallbackOnDeniedLaunch) {
          return refuse({ code: 'unavailable', feature: 'host-launcher', message: 'The host launcher refused the launch.' });
        }
      }
    }
    let resumed: NativeSession | undefined;
    if (settings.resume !== undefined) {
      const parsed = parseSessionReference({ value: settings.resume.session, expected: binding });
      resumed = parsed.kind === 'ok' ? sessions.get(parsed.value.opaque) : undefined;
      if (resumed === undefined) return refuse(invalid('The session cannot be resumed.'));
      const { expectedHistory } = settings.resume;
      if (expectedHistory !== undefined) {
        const checked = parseCheckpointReference({ value: expectedHistory, session: resumed.reference });
        if (checked.kind === 'error') return refuse(invalid('The expected history does not belong to this session.'));
        if (checked.value.opaque !== historyOf(resumed).opaque) {
          return refuse({ code: 'history-mismatch', message: 'The native history differs from the expected history.' });
        }
      }
      if (settings.tools !== undefined && JSON.stringify(settings.tools) !== resumed.toolKey) {
        return refuse(invalid('Tool declarations are fixed for the life of the native session.'));
      }
    }
    return { kind: 'ok', value: instance(resumed, tools) };
  }

  function instance(resumed: NativeSession | undefined, declared: HostOpenOptions['tools']): HostAdapter {
    const holder = {};
    const toolKey = JSON.stringify(declared ?? []);
    let current = resumed;
    let active = false;
    let closing: Promise<Outcome<void>> | undefined;
    const stream = createEventStream<HostAdapterEvent>({ maxObservers: 4, capacity: 64 });
    const usage = (): HostUsage => Object.freeze({ scope: 'segment', native: { namespace, schemaVersion: 1, data: { tokens: 1 } } });

    function ensure(): NativeSession {
      if (current !== undefined) return current;
      const reference: SessionReference = Object.freeze({ kind: 'session', formatVersion: 1, binding, opaque: `session-${sessions.size + 1}` });
      current = { reference, toolKey, turns: 0, calls: null, holder, segmentOpen: true };
      sessions.set(reference.opaque, current);
      return current;
    }
    function call(session: NativeSession, index: number): HostToolCall {
      const target = Object.freeze({ kind: 'tool' as const, session: session.reference, nativeToolCallId: `call-${session.turns}-${index}` });
      const args = Object.freeze({ query: `fixture-${index}` });
      stream.publish({ kind: 'tool-call-start', target, name: tool.name });
      stream.publish({ kind: 'tool-call-arguments-delta', target, delta: JSON.stringify(args) });
      stream.publish({ kind: 'tool-call-end', target, arguments: args });
      return Object.freeze({ pending: Object.freeze({ kind: 'tool', target }), name: tool.name, arguments: args });
    }
    function reply(session: NativeSession): HostSegmentResult {
      const text = `fixture reply ${session.turns}`;
      const used = usage();
      stream.publish({ kind: 'text-delta', nativeItemId: `item-${session.turns}`, text });
      stream.publish({ kind: 'usage', usage: used });
      return Object.freeze({ kind: 'complete', session: session.reference, text, usage: used });
    }
    function model(prompt: string, accepted: DispatchEvidence): HostSegmentResult {
      const session = ensure();
      session.segmentOpen = true;
      session.holder = holder;
      session.turns++;
      if (prompt !== prompts.toolCall && prompt !== prompts.twoToolCalls) return reply(session);
      const wanted = prompt === prompts.toolCall ? 1 : 2;
      if (wanted > maxPendingPerMessage && !faults.dropExtraCalls) {
        return Object.freeze({
          kind: 'failed' as const,
          error: Object.freeze({
            code: 'pending-limit' as const,
            message: 'The engine produced more host calls than one message may hold.',
          }),
          write: { kind: 'accepted' as const, evidence: accepted },
        } satisfies HostSegmentResult);
      }
      session.calls = Object.freeze(Array.from({ length: Math.min(wanted, maxPendingPerMessage) }, (_, index) => call(session, index)));
      session.holder = holder;
      return Object.freeze({ kind: 'pending', session: session.reference, calls: session.calls, approvals: Object.freeze([]), usage: usage() });
    }
    async function dispatch(request: HostSegmentRequest, native: (accepted: DispatchEvidence) => HostSegmentResult) {
      const target: DispatchTarget = current === undefined ? { kind: 'new-session', binding } : { kind: 'session', reference: current.reference };
      let operation;
      try {
        operation = createDispatchOperation<HostSegmentResult>({
          mode: 'fresh', signal: request.signal, recordIntent: request.recordIntent,
          identity: { hostOperationId: request.hostOperationId, target },
          dispatchNative: (canonical) => {
            const accepted: DispatchEvidence = { identity: canonical, source: 'native-acknowledgement',
              nativeOperation: { namespace, id: `turn-${++operations}` }, observation: evidence };
            return { kind: 'conclusive', evidence: accepted, result: native(accepted) };
          },
        });
      } catch {
        return failed(invalid('The segment request is malformed.'));
      }
      const { observation } = await operation.run();
      if (observation.kind === 'conclusive') return observation.result;
      return failed({ code: 'native-failure', message: 'The segment did not complete.' }, observation);
    }
    async function answer(input: HostContinueInput): Promise<HostSegmentResult> {
      if (closing !== undefined) return failed(closedError);
      const session = current;
      const calls = session?.calls;
      if (session === undefined || calls == null) return failed(invalid('No host call is pending.'));
      if (session.holder !== holder && session.segmentOpen) {
        return failed({ code: 'busy', message: 'Pending calls stay with the open segment that produced them.' });
      }
      if (session.holder !== holder && continuation === 'same-process') {
        return failed({ code: 'unsupported', feature: 'fresh-process-continuation', message: 'The pending call belongs to another process.' });
      }
      if (!Array.isArray(input.answers) || input.answers.length !== calls.length) return failed(invalid('Answer every pending call once.'));
      const unanswered = new Set(calls);
      for (const value of input.answers) {
        const match = [...unanswered].find((pending) => parseInteractionContinuation({ value, expected: pending.pending }).kind === 'ok');
        if (match === undefined) return failed(invalid('An answer matches no unanswered pending call.'));
        unanswered.delete(match);
      }
      return dispatch(input, () => {
        session.segmentOpen = true;
        session.holder = holder;
        session.calls = null;
        session.turns++;
        for (const pending of calls) {
          stream.publish({ kind: 'tool-delivery', target: pending.pending.target, delivery: { kind: 'confirmed', evidence } });
        }
        return reply(session);
      });
    }
    function occupy(body: () => Promise<HostSegmentResult>): Promise<HostSegmentResult> {
      if (closing !== undefined) return Promise.resolve(failed(closedError));
      if (active) return Promise.resolve(failed({ code: 'busy', message: 'One segment is already running.' }));
      active = true;
      return body().finally(() => { active = false; });
    }

    const capabilities: HostAdapterCapabilities = {
      imageInput: { kind: 'unsupported', reason: 'image input is not supported' },
      models: { kind: 'unsupported', reason: 'model catalog is not supported' },
      maxPendingPerMessage, continuation, usage: 'segment', toolDeclarations: 'fixed-at-creation',
      inspect: inspect
        ? { kind: 'supported', api: { pending: async () => ({ kind: 'ok', value: { calls: current?.calls ?? [], approvals: [] } }) } }
        : { kind: 'unsupported', reason: 'The fake was configured without inspection.' },
      fingerprint: fingerprint === 'unsupported'
        ? { kind: 'unsupported', reason: 'The fake was configured without fingerprints.' }
        : { kind: 'supported', api: { validity: fingerprint, read: async () => {
          if (current === undefined) return refuse(invalid('No session exists yet.'));
          if (fingerprint === 'after-process-exit' && current.segmentOpen) {
            return refuse({ code: 'unavailable', feature: 'fingerprint',
              message: 'An after-process-exit fingerprint cannot be read while the segment is open.' });
          }
          return { kind: 'ok', value: historyOf(current) };
        } } },
    };
    const adapter: HostAdapter = {
      identity,
      capabilities: Object.freeze(capabilities),
      events: Object.freeze({ subscribe: stream.subscribe }),
      run: (input) => {
        let requestedImages: boolean;
        try { const images = input.images; requestedImages = images !== undefined && (!Array.isArray(images) || images.length !== 0 || types.isProxy(images)); } catch { return Promise.resolve(failed(invalid('Image input is malformed.'))); }
        if (requestedImages) return Promise.resolve(failed({ code: 'unsupported', feature: 'image-input', message: 'image input is not supported' }));
        const prompt = input.prompt;
        if (typeof prompt !== 'string') return Promise.resolve(failed(invalid('The prompt must be text.')));
        return occupy(() => dispatch(input, (accepted) => model(prompt, accepted)));
      },
      continue: (input) => occupy(() => answer(input)),
      interrupt: ({ timeoutMs }) => new Promise((resolve) => {
        setTimeout(() => resolve(active ? { kind: 'unconfirmed-within-bound' } : { kind: 'terminal-observed' }), timeoutMs);
      }),
      close: () => {
        if (closing === undefined) {
          if (current !== undefined && current.holder === holder) current.segmentOpen = false;
          stream.close();
          closing = Promise.resolve(Object.freeze({ kind: 'ok', value: undefined }));
        }
        return closing;
      },
    };
    return Object.freeze(adapter);
  }

  const registration: HostAdapterRegistration<HostOpenOptions> = Object.freeze({ identity, open });
  return Object.freeze({
    registration, launch, tool, prompts,
    launches: () => ({ ...counts }),
    dispose: async () => { sessions.clear(); },
  });
}
