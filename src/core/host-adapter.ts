import type { AuthConfiguration, AuthScope } from './auth.js';
import type { Capability } from './capabilities.js';
import type { AdapterError, AdapterIdentity, AdapterInstance, NativeExtension, Outcome } from './contracts.js';
import type { DispatchObservation, FreshDispatchOptions } from './dispatch.js';
import type { EventObserver } from './events.js';
import type { InteractionContinuation, NativeDelivery, PendingInteraction, ToolTarget } from './interaction.js';
import type { RunObservationListener } from './run-observation.js';
import type { CheckpointReference, SessionReference } from './sessions.js';

/**
 * Present, this declares that the host owns every native process: the adapter launches only through it and never
 * signals a host-owned process. Absent, the SDK's native launch applies.
 */
export type HostLaunch<Spawn = unknown, Channel = unknown> =
  | { readonly kind: 'spawn'; readonly spawn: Spawn }
  | { readonly kind: 'channel'; readonly channel: Channel; readonly processExit: PromiseLike<unknown> }
  | { readonly kind: 'in-process' };

/** Complete when present: the adapter reads no ambient variable, home directory or configuration file. */
export interface HostEnvironment<NativeConfig = unknown> {
  readonly variables: Readonly<Record<string, string>>;
  readonly nativeConfig: NativeConfig;
}

export interface HostToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, passed to the engine unchanged. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface HostResume {
  readonly session: SessionReference;
  /** A history fingerprint from `HostFingerprintApi.read`; a different native history refuses with `history-mismatch`. */
  readonly expectedHistory?: CheckpointReference;
}

/** Every omitted option keeps native behaviour. Tool declarations are fixed for the life of the native session. */
export interface HostOpenOptions<Launch = HostLaunch, NativeConfig = unknown, DirectMaterial = unknown> {
  readonly launch?: Launch;
  readonly environment?: HostEnvironment<NativeConfig>;
  readonly instructions?: string;
  readonly tools?: readonly HostToolDeclaration[];
  readonly route?: { readonly config: AuthConfiguration<DirectMaterial>; readonly scope: AuthScope };
  readonly subagents?: 'off';
  /** Engine built-in tools left on; every other built-in is off. */
  readonly builtInTools?: readonly string[];
  readonly resume?: HostResume;
}

export interface HostSegmentRequest {
  readonly hostOperationId: string;
  /** Runs before native dispatch, as in `createDispatchOperation`. */
  readonly recordIntent: FreshDispatchOptions<unknown>['recordIntent'];
  readonly signal: AbortSignal;
  /**
   * Receives this segment's `RunObservation` values. One segment is one baseline: a continuation passes its own
   * listener. A listener exception never changes the segment result.
   */
  readonly onObservation?: RunObservationListener;
}
export interface HostRunInput extends HostSegmentRequest {
  readonly prompt: string;
}
export interface HostContinueInput extends HostSegmentRequest {
  /** One tool continuation per pending call, covering the whole pending set exactly, in any order. */
  readonly answers: readonly InteractionContinuation[];
}

export interface HostToolCall {
  readonly pending: Extract<PendingInteraction, { readonly kind: 'tool' }>;
  readonly name: string;
  /** The JSON value the engine produced, neither re-parsed nor defaulted. */
  readonly arguments: unknown;
}

/** Raw native counters, never summed by the adapter. */
export interface HostUsage {
  readonly scope: 'segment' | 'cumulative';
  readonly native: NativeExtension;
}

/**
 * `not-attempted`: refused before `createDispatchOperation` ran, so nothing was sent.
 * `not-dispatched`: that helper's not-sent observation. `outcome-unknown`: its result after entry is unknown.
 * `accepted`: native acceptance was observed and the segment still failed. No failed status authorizes a retry.
 */
export type HostWriteStatus =
  | { readonly kind: 'not-attempted' }
  | Extract<DispatchObservation<never>, { readonly kind: 'not-dispatched' | 'outcome-unknown' | 'accepted' }>;

/**
 * `history-mismatch`: resume refused a different native history.
 * `pending-limit`: one assistant message produced more host calls than `maxPendingPerMessage`.
 * `unavailable`: a denial first seen at this operation, including a host launcher that refused to start.
 */
export type HostAdapterError = AdapterError
  | { readonly code: 'history-mismatch'; readonly message: string }
  | { readonly code: 'pending-limit'; readonly message: string }
  | { readonly code: 'unavailable'; readonly feature: string; readonly message: string };

export type HostSegmentResult =
  | { readonly kind: 'complete'; readonly session: SessionReference; readonly text: string; readonly usage: HostUsage }
  | {
      readonly kind: 'pending';
      readonly session: SessionReference;
      readonly calls: readonly HostToolCall[];
      readonly usage: HostUsage;
    }
  | {
      readonly kind: 'failed';
      readonly error: Exclude<HostAdapterError, { readonly code: 'pending-limit' }>;
      readonly write: HostWriteStatus;
    }
  | {
      readonly kind: 'failed';
      readonly error: { readonly code: 'pending-limit'; readonly message: string };
      readonly write: Extract<HostWriteStatus, { readonly kind: 'accepted' }>;
    };

export type HostAdapterEvent =
  | { readonly kind: 'text-delta'; readonly nativeItemId: string; readonly text: string }
  | { readonly kind: 'tool-call-start'; readonly target: ToolTarget; readonly name: string }
  | { readonly kind: 'tool-call-arguments-delta'; readonly target: ToolTarget; readonly delta: string }
  | { readonly kind: 'tool-call-end'; readonly target: ToolTarget; readonly arguments: unknown }
  | { readonly kind: 'tool-delivery'; readonly target: ToolTarget; readonly delivery: NativeDelivery }
  | { readonly kind: 'usage'; readonly usage: HostUsage }
  | { readonly kind: 'native-item'; readonly item: NativeExtension };

/**
 * `terminal-observed`: the segment's native terminal fact arrived within the bound, or no segment was active.
 * `interrupted`: native acknowledged the interrupt within the bound; its terminal fact has not arrived.
 * No kind claims that a process stopped.
 */
export type HostInterruptResult =
  | { readonly kind: 'terminal-observed' }
  | { readonly kind: 'interrupted'; readonly evidence: NativeExtension }
  | { readonly kind: 'unconfirmed-within-bound' };

/** Reads unanswered host calls from native state without a model call. */
export interface HostInspectApi {
  readonly pending: (signal: AbortSignal) => Promise<Outcome<readonly HostToolCall[], HostAdapterError>>;
}
export interface HostFingerprintApi {
  readonly validity: 'segment-end' | 'after-process-exit';
  readonly read: (signal: AbortSignal) => Promise<Outcome<CheckpointReference, HostAdapterError>>;
}

export interface HostAdapterCapabilities {
  /** A further host call in the same assistant message is a `pending-limit` failure, never a silent loss. */
  readonly maxPendingPerMessage: number;
  /** `fresh-process`: a continuation may be delivered to a session reopened in another process. */
  readonly continuation: 'same-process' | 'fresh-process';
  readonly inspect: Capability<HostInspectApi>;
  readonly fingerprint: Capability<HostFingerprintApi>;
  readonly usage: HostUsage['scope'];
  readonly toolDeclarations: 'fixed-at-creation';
}

/** One segment at a time. The adapter keeps no store, retries nothing and applies no approval policy. */
export interface HostAdapter<Engine extends string = string> extends AdapterInstance<Engine> {
  readonly capabilities: HostAdapterCapabilities;
  readonly events: EventObserver<HostAdapterEvent>;
  readonly run: (input: HostRunInput) => Promise<HostSegmentResult>;
  readonly continue: (input: HostContinueInput) => Promise<HostSegmentResult>;
  readonly interrupt: (options: { readonly timeoutMs: number }) => Promise<HostInterruptResult>;
}

export interface HostAdapterRegistration<Options = HostOpenOptions, Engine extends string = string> {
  readonly identity: AdapterIdentity<Engine>;
  readonly open: (options: Options, signal: AbortSignal) => Promise<Outcome<HostAdapter<Engine>, HostAdapterError>>;
}
