import type { Context, SpanContext, Tracer } from '@opentelemetry/api';
import type { Outcome } from '../core/contracts.js';

export interface TextPart {
  readonly type: 'text';
  readonly content: string;
}
export interface InputMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly parts: readonly TextPart[];
}
export interface OutputMessage {
  readonly role: 'assistant';
  readonly parts: readonly TextPart[];
  readonly finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_call' | 'error';
}
export type ContentObservation =
  | { readonly kind: 'input'; readonly messages: readonly InputMessage[] }
  | { readonly kind: 'output'; readonly messages: readonly OutputMessage[] };
export type ContentPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'sanitized'; readonly sanitize: (content: ContentObservation) => ContentObservation };
export interface AgentOperation {
  readonly kind: 'agent';
  readonly provider: string;
  readonly name?: string;
}
export interface ModelOperation {
  readonly kind: 'model';
  readonly provider: string;
  readonly operation: 'chat' | 'generate_content' | 'text_completion';
  readonly requestModel?: string;
  readonly inputMessages?: readonly InputMessage[];
}
export interface ToolOperation {
  readonly kind: 'tool';
  readonly name: string;
  readonly callId?: string;
}
export type GenAiOperation = AgentOperation | ModelOperation | ToolOperation;
export interface Correlation {
  readonly runId?: string;
  readonly requestId?: string;
  readonly conversationId?: string;
}
export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}
export interface ModelUpdate {
  readonly responseModel?: string;
  readonly usage?: ModelUsage;
  readonly outputMessages?: readonly OutputMessage[];
}
export type TerminalOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly category: 'provider-error' | 'rate-limit' | 'timeout' | 'authentication' | 'tool-error' | 'unknown-error' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'outcome-unknown' };
export type ObservationErrorCode = 'invalid-input' | 'capacity' | 'closed' | 'finished' | 'telemetry-failure';
export type ObservationResult<T = void> = Outcome<T, { readonly code: ObservationErrorCode }>;
interface Handle {
  readonly spanContext: SpanContext;
  readonly context: Context;
  readonly finish: (outcome: TerminalOutcome) => ObservationResult;
}
export interface AgentHandle extends Handle { readonly kind: 'agent' }
export interface ToolHandle extends Handle { readonly kind: 'tool' }
export interface ModelHandle extends Handle {
  readonly kind: 'model';
  readonly update: (observation: ModelUpdate) => ObservationResult;
}
export type GenAiHandle = AgentHandle | ModelHandle | ToolHandle;
export interface ObserverDiagnostics {
  readonly activeSpans: number;
  readonly started: number;
  readonly finished: number;
  readonly invalidInputs: number;
  readonly capacityRejected: number;
  readonly closedRejected: number;
  readonly finishedRejected: number;
  readonly telemetryFailures: number;
  readonly contentDropped: number;
}
export interface GenAiObserver {
  start(operation: AgentOperation, parent: Context, correlation?: Correlation): ObservationResult<AgentHandle>;
  start(operation: ModelOperation, parent: Context, correlation?: Correlation): ObservationResult<ModelHandle>;
  start(operation: ToolOperation, parent: Context, correlation?: Correlation): ObservationResult<ToolHandle>;
  start(operation: GenAiOperation, parent: Context, correlation?: Correlation): ObservationResult<GenAiHandle>;
  readonly diagnostics: () => ObserverDiagnostics;
  readonly close: () => void;
}
export interface ObserverOptions {
  readonly tracer: Tracer;
  readonly contentPolicy: ContentPolicy;
  readonly bounds?: {
    readonly maxActiveSpans?: number;
    readonly maxIdentifierLength?: number;
    readonly maxContentBytes?: number;
  };
  readonly allowedToolNames: readonly string[];
  /** `true` records a tool name that passes the identifier check even when `allowedToolNames` omits it. */
  readonly admitObservedToolNames?: boolean;
  readonly includeConversationId?: boolean;
}
export const instrumentationScope = Object.freeze({ name: '@operatorworks/switchboard', version: '0.0.0' });
