import type {
  AdapterIdentity, DispatchSnapshot, EventObserver, FreshDispatchOptions, InteractionContinuation,
  InteractionError, NativeDispatchObservation, Outcome, PendingApproval, PendingInteraction,
  ReconciliationHandle, SessionReference, SessionReferenceError, ToolTarget,
} from '@mattsp1290/switchboard';

export interface QualificationResult {
  readonly continuation: InteractionContinuation | undefined;
}

export interface QualificationRequest {
  readonly session: unknown;
  readonly hostOperationId: string;
  readonly continuation?: unknown;
}

export type RecordIntent = FreshDispatchOptions<QualificationResult>['recordIntent'];

export interface QualificationEvent {
  readonly kind: 'progress';
  readonly sequence: number;
}

export interface QualificationSubmitError {
  readonly code: SessionReferenceError['code'] | InteractionError['code']
    | 'missing-session' | 'stale-interaction' | 'busy' | 'closed';
}

export type RecoverableSnapshot = DispatchSnapshot<QualificationResult> & {
  readonly observation: NativeDispatchObservation<QualificationResult>;
};

export interface QualificationConnection {
  readonly identity: AdapterIdentity;
  /**
   * A fresh stream equivalent to createEventStream({ maxObservers: 2, capacity: 2 }).
   * Retiring callbacks retain observer slots. Capacity includes the active callback.
   * Fixtures must not consume observer slots themselves.
   */
  readonly events: EventObserver<QualificationEvent>;
  readonly submit: (request: QualificationRequest, signal: AbortSignal) => Promise<Outcome<
    DispatchSnapshot<QualificationResult>, QualificationSubmitError
  >>;
  readonly recover: (saved: RecoverableSnapshot) => ReconciliationHandle<QualificationResult>;
  readonly close: () => Promise<Outcome<void, { readonly code: string }>>;
}

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
  readonly samples: {
    readonly a: SessionReference;
    readonly b: SessionReference;
    readonly approval: PendingApproval;
    readonly tool: { readonly kind: 'tool'; readonly target: ToolTarget };
  };
  readonly connect: (recordIntent: RecordIntent) => QualificationConnection;
  readonly controls: {
    readonly loseNextAcknowledgement: () => void;
    readonly holdNextCompletion: () => CompletionGate;
    readonly lookupVisibility: (mode: 'unknown' | 'authoritative') => void;
    readonly pending: (value: Exclude<PendingInteraction, { readonly kind: 'delegation' }>) => void;
    readonly emit: (sequence: number) => void;
    readonly counts: () => QualificationCounts;
  };
  readonly dispose: () => Promise<void>;
}

export type QualificationFactory = () => QualificationFixture | PromiseLike<QualificationFixture>;
export type QualificationContract = (factory: QualificationFactory, signal: AbortSignal) => Promise<void>;
export type QualificationContracts = Readonly<Record<'uncertainty' | 'sessions' | 'interaction' | 'events', QualificationContract>>;
