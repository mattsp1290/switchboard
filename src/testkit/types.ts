import type {
  AdapterError, AdapterIdentity, DispatchIdentity, DispatchSnapshot, EventObserver, FreshDispatchOptions, InteractionContinuation,
  InteractionError, NativeDispatchObservation, Outcome, PendingApproval, PendingInteraction,
  ReconciliationHandle, SessionReference, SessionReferenceError,
} from '@mattsp1290/switchboard';

export interface QualificationResult {
  readonly continuation: InteractionContinuation | undefined;
}

export interface QualificationRequest {
  readonly session: unknown;
  readonly hostOperationId: string;
  readonly continuation?: unknown;
}

/** The simulated host accepts session targets only. Rejected intent becomes `not-dispatched` with reason `intent-failed`. */
export type RecordIntent = FreshDispatchOptions<QualificationResult>['recordIntent'];

export interface QualificationEvent {
  readonly kind: 'progress';
  readonly sequence: number;
}

export interface QualificationSubmitError {
  readonly code: SessionReferenceError['code'] | InteractionError['code']
    | 'missing-session' | 'stale-interaction' | 'busy' | 'closed';
}

export interface RecoverableSnapshot {
  readonly identity: DispatchIdentity;
  readonly observation: NativeDispatchObservation<QualificationResult>;
}

export interface QualificationConnection {
  readonly identity: AdapterIdentity;
  /**
   * A fresh stream equivalent to createEventStream({ maxObservers: 2, capacity: 2 }).
   * Retiring callbacks retain observer slots. Capacity includes the active callback.
   * Fixtures must not consume observer slots themselves.
   * Close ends existing observers with `closed`; later subscriptions return error `closed`.
   */
  readonly events: EventObserver<QualificationEvent>;
  /**
   * Returns error `closed` after close. All fixture connections share session reservations;
   * overlapping work on a reserved session returns `busy` until native completion.
   * Approval and tool continuations are consumed once at native acceptance;
   * later submissions return `stale-interaction`.
   */
  readonly submit: (request: QualificationRequest, signal: AbortSignal) => Promise<Outcome<
    DispatchSnapshot<QualificationResult>, QualificationSubmitError
  >>;
  /**
   * Reconciles native observations without dispatching. On a closed connection, native lookup
   * must throw or reject so reconciliation returns error `lookup-failed`, without incrementing `lookupCalls`.
   * Authoritative evidence has a non-null `nativeOperation` receipt equal to the acknowledgement receipt.
   * Its observation namespace matches the receipt namespace, and its observation `schemaVersion` is 1.
   */
  readonly recover: (saved: RecoverableSnapshot) => ReconciliationHandle<QualificationResult>;
  /**
   * Every call returns the identical Promise, which settles to one shared outcome object.
   * Cache and return the Promise directly; an `async` wrapper creates a different Promise per call.
   * Closes the event stream and increments `transportCloses` exactly once per connection.
   * Does not release reservations or complete accepted native work.
   */
  readonly close: () => Promise<Outcome<void, AdapterError>>;
}

/** `release()` must eventually settle `completed` for accepted work. Close does not release this gate. */
export interface CompletionGate {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly completed: Promise<void>;
}

export interface QualificationCounts {
  readonly dispatchAttempts: number;
  readonly acceptedEffects: number;
  readonly lookupCalls: number;
  readonly transportCloses: number;
}

export interface QualificationFixture {
  /**
   * Immutable samples. Sessions `a` and `b` share the same binding and differ only in `opaque`.
   * Both `approval.target.session` and `tool.target.session` equal `a`.
   * Approval choices are nonempty.
   */
  readonly samples: {
    readonly a: SessionReference;
    readonly b: SessionReference;
    readonly approval: PendingApproval;
    readonly tool: Extract<PendingInteraction, { readonly kind: 'tool' }>;
  };
  readonly connect: (recordIntent: RecordIntent) => QualificationConnection;
  readonly controls: {
    readonly loseNextAcknowledgement: () => void;
    readonly holdNextCompletion: () => CompletionGate;
    readonly lookupVisibility: (mode: 'unknown' | 'authoritative') => void;
    readonly pending: (value: Exclude<PendingInteraction, { readonly kind: 'delegation' }>) => void;
    readonly emit: (sequence: number) => void;
    /**
     * A fresh plain object with exactly `dispatchAttempts`, `acceptedEffects`, `lookupCalls`,
     * and `transportCloses`, initially zero and shared across connections.
     * Counts native sends, accepted fixture commands, native lookups, and connection closes respectively.
     * Acknowledgement loss does not undo acceptance. A lookup on a closed connection does not increment counts.
     */
    readonly counts: () => QualificationCounts;
  };
  /** Idempotent cleanup that releases completion gates, closes every connection, and settles after fixture work exits. */
  readonly dispose: () => Promise<void>;
}

/**
 * Acquires one fixture per scenario, synchronously or asynchronously, and must settle independently.
 * Acquisition receives no cancellation signal. Cleanup waits for acquisition, callback exits,
 * gate completion after release, and fixture disposal; none of these cleanup waits is bounded by the signal.
 */
export type QualificationFactory = () => QualificationFixture | PromiseLike<QualificationFixture>;
export type QualificationContract = (factory: QualificationFactory, signal: AbortSignal) => Promise<void>;
export type QualificationContracts = Readonly<Record<'uncertainty' | 'sessions' | 'interaction' | 'events', QualificationContract>>;
