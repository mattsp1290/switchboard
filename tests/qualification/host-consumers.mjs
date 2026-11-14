import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseInteractionContinuation, parseSessionReference } from '@mattsp1290/switchboard';

/** @import {
 * Capability, DispatchIdentity, DispatchSnapshot, EventObserver, InteractionContinuation,
 * Outcome, PendingApproval, ReconciliationHandle, SessionBinding, SessionCorrelation, SessionReference,
 * } from '@mattsp1290/switchboard' */
/** @typedef {{ session: SessionReference, hostOperationId: string, continuation?: InteractionContinuation }} Request */
/** @typedef {{
 * submit(request: Request, signal: AbortSignal): Promise<Outcome<DispatchSnapshot<unknown>, { code: string }>>,
 * recover(saved: DispatchSnapshot<unknown>): ReconciliationHandle<unknown>,
 * close(): Promise<Outcome<void, { code: string }>>,
 * }} Command */
/** @typedef {{
 * events: EventObserver<{ kind: 'progress', sequence: number }>,
 * close(): Promise<Outcome<void, { code: string }>>,
 * }} View */
/** @typedef {{ kind: 'intent', identity: DispatchIdentity, correlation: SessionCorrelation } | { kind: 'unknown', snapshot: DispatchSnapshot<unknown>, correlation: SessionCorrelation }} SavedCommand */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @template T @param {Outcome<T, { code: string }>} outcome @returns {T} */
function requireOk(outcome) {
  if (outcome.kind === 'error') throw new Error(outcome.error.code);
  return outcome.value;
}

/**
 * @param {{ connect(recordIntent: (identity: DispatchIdentity) => void): Command,
 * journalFile: string, expectedBinding: SessionBinding, grant: SessionReference,
 * correlation: SessionCorrelation, hostOperationId: string, onIntentPersisted?: () => void }} options
 */
export function createCrewActivity(options) {
  const { journalFile, hostOperationId, onIntentPersisted } = options;
  const binding = structuredClone(options.expectedBinding);
  const grant = requireOk(parseSessionReference({ value: options.grant, expected: binding }));
  const correlation = structuredClone(options.correlation);

  /** @param {unknown} value @returns {DispatchIdentity & { target: Extract<DispatchIdentity['target'], { kind: 'session' }> }} */
  function identity(value) {
    if (!isRecord(value) || value.hostOperationId !== hostOperationId
      || !isRecord(value.target) || value.target.kind !== 'session') {
      throw new Error('Wrong command identity.');
    }
    const reference = requireOk(parseSessionReference({ value: value.target.reference, expected: binding }));
    if (JSON.stringify(reference) !== JSON.stringify(grant)) throw new Error('Outside host grant.');
    return { hostOperationId, target: { kind: 'session', reference } };
  }

  /** @returns {SavedCommand | undefined} */
  function load() {
    if (!existsSync(journalFile)) return undefined;
    /** @type {unknown} */
    const saved = JSON.parse(readFileSync(journalFile, 'utf8'));
    if (!isRecord(saved) || !isRecord(saved.correlation)
      || saved.correlation.threadId !== correlation.threadId
      || saved.correlation.runId !== correlation.runId
      || saved.correlation.requestId !== correlation.requestId) throw new Error('Invalid host journal.');
    if (saved.kind === 'intent') return { kind: 'intent', identity: identity(saved.identity), correlation };
    if (saved.kind !== 'unknown' || !isRecord(saved.snapshot)
      || !isRecord(saved.snapshot.observation) || saved.snapshot.observation.kind !== 'outcome-unknown') {
      throw new Error('Invalid host journal.');
    }
    return { kind: 'unknown', correlation,
      snapshot: { identity: identity(saved.snapshot.identity), observation: { kind: 'outcome-unknown' } } };
  }

  /** @param {SavedCommand} record */
  function save(record) {
    writeFileSync(journalFile, JSON.stringify(record));
  }

  const connection = options.connect((canonical) => {
    const admitted = identity(canonical);
    if (load() !== undefined) throw new Error('Command already admitted.');
    save({ kind: 'intent', identity: admitted, correlation });
    onIntentPersisted?.();
  });
  return {
    /** @param {Request} request @param {AbortSignal} signal */
    async execute(request, signal) {
      const command = identity({ hostOperationId: request.hostOperationId,
        target: { kind: 'session', reference: request.session } });
      const saved = load();
      if (saved?.kind === 'intent') throw new Error('Intent requires investigation.');
      if (saved?.kind === 'unknown') {
        return requireOk(await connection.recover(saved.snapshot).reconcile(signal));
      }
      const snapshot = requireOk(await connection.submit({ session: command.target.reference, hostOperationId }, signal));
      if (snapshot.observation.kind === 'outcome-unknown') save({ kind: 'unknown', snapshot, correlation });
      return snapshot;
    },
    close: connection.close,
  };
}

/**
 * @param {{ connection: View, correlation: SessionCorrelation, pending: PendingApproval,
 * capabilities: readonly Capability<unknown>[], hostOperationId: string,
 * onProgress: (sequence: number) => void }} options
 */
export function openAgentView(options) {
  const { connection, hostOperationId, onProgress } = options;
  const pending = structuredClone(options.pending);
  const correlation = structuredClone(options.correlation);
  const capabilities = options.capabilities.map((capability) => capability.kind === 'supported'
    ? { kind: capability.kind } : { kind: capability.kind, reason: capability.reason });
  const subscription = requireOk(connection.events.subscribe((event) => onProgress(event.sequence)));
  return {
    presentation: { correlation, nativePending: structuredClone(pending), capabilities },
    /** @param {unknown} value @param {Pick<Command, 'submit'>} command @param {AbortSignal} signal */
    async reply(value, command, signal) {
      const continuation = parseInteractionContinuation({ value, expected: pending });
      if (continuation.kind === 'error') return continuation;
      return command.submit({ session: pending.target.session, hostOperationId,
        continuation: continuation.value }, signal);
    },
    async close() {
      subscription.dispose();
      await subscription.ended;
      return connection.close();
    },
  };
}
