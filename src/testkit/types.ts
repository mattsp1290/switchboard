import type {
  AdapterIdentity, DispatchIdentity, DispatchSnapshot, EventObserver, InteractionContinuation,
  Outcome, PendingApproval, PendingInteraction, ReconciliationHandle, SessionReference, ToolTarget,
} from '@mattsp1290/switchboard';

export interface QualificationResult {
  readonly continuation: InteractionContinuation | undefined;
}

export interface QualificationRequest {
  readonly session: unknown;
  readonly hostOperationId: string;
  readonly continuation?: unknown;
}

export type RecordIntent = (identity: DispatchIdentity, signal: AbortSignal) => void | PromiseLike<void>;

export interface QualificationConnection {
  readonly identity: AdapterIdentity;
  readonly events: EventObserver<{ readonly kind: 'progress'; readonly sequence: number }>;
  readonly submit: (request: QualificationRequest, signal: AbortSignal) => Promise<Outcome<
    DispatchSnapshot<QualificationResult>, { readonly code: string }
  >>;
  readonly recover: (saved: DispatchSnapshot<QualificationResult>) => ReconciliationHandle<QualificationResult>;
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
