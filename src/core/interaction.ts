import type { NativeExtension, Outcome } from './contracts.js';
import { parseSessionReference, sessionLimits } from './sessions.js';
import type { SessionReference } from './sessions.js';

export interface ApprovalTarget {
  readonly kind: 'approval';
  readonly session: SessionReference;
  readonly nativeApprovalId: string;
  readonly tool: { readonly nativeToolCallId: string } | null;
}
export interface ToolTarget {
  readonly kind: 'tool';
  readonly session: SessionReference;
  readonly nativeToolCallId: string;
}
export interface DelegationTarget {
  readonly kind: 'delegation';
  readonly session: SessionReference;
  readonly nativeDelegationId: string;
}
export type InteractionTarget = ApprovalTarget | ToolTarget | DelegationTarget;
export type ToolEffect =
  | { readonly kind: 'known'; readonly effect: 'none' | 'occurred'; readonly evidence: NativeExtension }
  | { readonly kind: 'unknown' };
export type NativeDelivery =
  | { readonly kind: 'confirmed'; readonly evidence: NativeExtension }
  | { readonly kind: 'unknown' };
export interface ToolOutcome {
  readonly target: ToolTarget;
  readonly result: Outcome<NativeExtension, NativeExtension>;
  readonly effect: ToolEffect;
  readonly delivery: NativeDelivery;
}
export type DelegatedOutcome = {
  readonly target: DelegationTarget;
  readonly delivery: NativeDelivery;
} & (
  | { readonly kind: 'completed'; readonly result: Outcome<NativeExtension, NativeExtension> }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unknown' }
);
export interface PendingApproval {
  readonly kind: 'approval';
  readonly target: ApprovalTarget;
  readonly nativePolicy: NativeExtension;
  readonly request: NativeExtension;
  readonly choices: readonly { readonly nativeChoiceId: string; readonly label: string }[];
}
export type PendingInteraction = PendingApproval
  | { readonly kind: 'tool'; readonly target: ToolTarget }
  | { readonly kind: 'delegation'; readonly targets: readonly DelegationTarget[] };
export type HostApprovalIntent =
  | { readonly kind: 'choose-native-choice'; readonly nativeChoiceId: string }
  | { readonly kind: 'withhold' };
export type HostApprovalPolicy = (pending: PendingApproval) => HostApprovalIntent | Promise<HostApprovalIntent>;
export type InteractionContinuation = { readonly formatVersion: 1 } & (
  | { readonly kind: 'approval'; readonly target: ApprovalTarget; readonly nativeChoiceId: string }
  | { readonly kind: 'tool'; readonly outcome: ToolOutcome }
  | { readonly kind: 'delegation'; readonly outcomes: readonly DelegatedOutcome[] }
);
export interface InteractionError {
  readonly code: 'invalid-input' | 'unsupported-version' | 'binding-mismatch'
    | 'session-mismatch' | 'target-mismatch' | 'choice-mismatch';
}
export const interactionLimits = Object.freeze({ maxChoices: 1000, maxDelegations: 1000 });

const internalCodes = new WeakMap<object, InteractionError['code']>();
class InvalidInteraction extends Error {
  constructor(code: InteractionError['code'] = 'invalid-input') {
    super(code);
    internalCodes.set(this, code);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidInteraction();
  return value;
}
function isText(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > sessionLimits.identifierLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function text(value: unknown): string {
  if (!isText(value)) throw new InvalidInteraction();
  return value;
}
function session(value: unknown): SessionReference {
  const { kind, formatVersion, binding: rawBinding, opaque } = requireRecord(value);
  const { engine, nativeVersion, account, authorizedScope, nativeFormat } = requireRecord(rawBinding);
  if (!isText(engine) || !isText(nativeVersion) || !isText(account)
    || !isText(authorizedScope) || !isText(nativeFormat)) throw new InvalidInteraction();
  const binding = { engine, nativeVersion, account, authorizedScope, nativeFormat };
  const parsed = parseSessionReference({ value: { kind, formatVersion, binding, opaque }, expected: binding });
  if (parsed.kind === 'error') {
    throw new InvalidInteraction(parsed.error.code === 'unsupported-version' ? 'unsupported-version' : 'invalid-input');
  }
  return parsed.value;
}
function target(value: unknown): InteractionTarget {
  const raw = requireRecord(value);
  const { kind, session: rawSession } = raw;
  const reference = session(rawSession);
  switch (kind) {
    case 'approval': {
      const { nativeApprovalId, tool } = raw;
      return Object.freeze({ kind: 'approval', session: reference, nativeApprovalId: text(nativeApprovalId),
        tool: tool === null ? null : Object.freeze({ nativeToolCallId: text(requireRecord(tool).nativeToolCallId) }) });
    }
    case 'tool': return Object.freeze({ kind: 'tool', session: reference, nativeToolCallId: text(raw.nativeToolCallId) });
    case 'delegation': return Object.freeze({ kind: 'delegation', session: reference, nativeDelegationId: text(raw.nativeDelegationId) });
    default: throw new InvalidInteraction();
  }
}
function extension(value: unknown): NativeExtension {
  const raw = requireRecord(value);
  const { namespace, schemaVersion, data } = raw;
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion)
    || schemaVersion < 1 || !Object.hasOwn(raw, 'data')) throw new InvalidInteraction();
  return Object.freeze({ namespace: text(namespace), schemaVersion, data });
}
function result(value: unknown): Outcome<NativeExtension, NativeExtension> {
  const raw = requireRecord(value);
  const { kind } = raw;
  if (kind === 'ok') return Object.freeze({ kind: 'ok', value: extension(raw.value) });
  if (kind === 'error') return Object.freeze({ kind: 'error', error: extension(raw.error) });
  throw new InvalidInteraction();
}
function delivery(value: unknown): NativeDelivery {
  const raw = requireRecord(value);
  const { kind } = raw;
  if (kind === 'unknown') return Object.freeze({ kind: 'unknown' });
  if (kind === 'confirmed') return Object.freeze({ kind: 'confirmed', evidence: extension(raw.evidence) });
  throw new InvalidInteraction();
}
function effect(value: unknown): ToolEffect {
  const raw = requireRecord(value);
  const { kind } = raw;
  if (kind === 'unknown') return Object.freeze({ kind: 'unknown' });
  if (kind === 'known') {
    const { effect, evidence } = raw;
    if (effect === 'none' || effect === 'occurred') return Object.freeze({ kind: 'known', effect, evidence: extension(evidence) });
  }
  throw new InvalidInteraction();
}
function list(value: unknown, ceiling: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new InvalidInteraction();
  const { length } = value;
  if (!Number.isSafeInteger(length) || length < 1 || length > ceiling) throw new InvalidInteraction();
  return Array.from({ length }, (_, index) => value[index]);
}
function targetKey(value: InteractionTarget): string {
  return JSON.stringify(value);
}
function uniqueTargets(values: readonly InteractionTarget[]): void {
  if (new Set(values.map(targetKey)).size !== values.length) throw new InvalidInteraction();
}
function pending(value: unknown): PendingInteraction {
  const raw = requireRecord(value);
  const { kind } = raw;
  if (kind === 'delegation') {
    const targets = list(raw.targets, interactionLimits.maxDelegations).map((value) => {
      const child = target(value);
      if (child.kind !== 'delegation') throw new InvalidInteraction();
      return child;
    });
    uniqueTargets(targets);
    return Object.freeze({ kind: 'delegation', targets: Object.freeze(targets) });
  }
  const checked = target(raw.target);
  if (kind === 'tool' && checked.kind === 'tool') return Object.freeze({ kind: 'tool', target: checked });
  if (kind !== 'approval' || checked.kind !== 'approval') throw new InvalidInteraction();
  const choices = list(raw.choices, interactionLimits.maxChoices).map((value) => {
    const choice = requireRecord(value);
    return Object.freeze({ nativeChoiceId: text(choice.nativeChoiceId), label: text(choice.label) });
  });
  if (new Set(choices.map((choice) => choice.nativeChoiceId)).size !== choices.length) throw new InvalidInteraction();
  return Object.freeze({ kind: 'approval', target: checked, nativePolicy: extension(raw.nativePolicy),
    request: extension(raw.request), choices: Object.freeze(choices) });
}
function continuation(value: unknown): InteractionContinuation {
  const raw = requireRecord(value);
  const { kind, formatVersion } = raw;
  if (typeof formatVersion !== 'number' || !Number.isSafeInteger(formatVersion)
    || formatVersion < 1) throw new InvalidInteraction();
  if (formatVersion !== 1) throw new InvalidInteraction('unsupported-version');
  if (kind === 'delegation') {
    const outcomes = list(raw.outcomes, interactionLimits.maxDelegations).map((value): DelegatedOutcome => {
      const child = requireRecord(value);
      const { kind } = child;
      const checked = target(child.target);
      if (checked.kind !== 'delegation') throw new InvalidInteraction();
      const received = delivery(child.delivery);
      if (kind === 'completed') return Object.freeze({ kind: 'completed', target: checked, delivery: received, result: result(child.result) });
      if (kind === 'cancelled' || kind === 'unknown') return Object.freeze({ kind, target: checked, delivery: received });
      throw new InvalidInteraction();
    });
    uniqueTargets(outcomes.map((outcome) => outcome.target));
    return Object.freeze({ formatVersion: 1, kind: 'delegation', outcomes: Object.freeze(outcomes) });
  }
  if (kind === 'approval') {
    const checked = target(raw.target);
    if (checked.kind !== 'approval') throw new InvalidInteraction();
    return Object.freeze({ formatVersion: 1, kind: 'approval', target: checked, nativeChoiceId: text(raw.nativeChoiceId) });
  }
  if (kind === 'tool') {
    const outcome = requireRecord(raw.outcome);
    const checked = target(outcome.target);
    if (checked.kind !== 'tool') throw new InvalidInteraction();
    return Object.freeze({ formatVersion: 1, kind: 'tool', outcome: Object.freeze({ target: checked,
      result: result(outcome.result), effect: effect(outcome.effect), delivery: delivery(outcome.delivery) }) });
  }
  throw new InvalidInteraction();
}
function compareTarget(actual: InteractionTarget, expected: InteractionTarget): void {
  if (actual.kind !== expected.kind) throw new InvalidInteraction('target-mismatch');
  for (const key of ['engine', 'nativeVersion', 'account', 'authorizedScope', 'nativeFormat'] as const) {
    if (actual.session.binding[key] !== expected.session.binding[key]) throw new InvalidInteraction('binding-mismatch');
  }
  if (actual.session.opaque !== expected.session.opaque) throw new InvalidInteraction('session-mismatch');
  if (targetKey(actual) !== targetKey(expected)) throw new InvalidInteraction('target-mismatch');
}
export function parseInteractionContinuation(options: {
  readonly value: unknown;
  readonly expected: PendingInteraction;
}): Outcome<InteractionContinuation, InteractionError> {
  try {
    const expected = pending(options.expected);
    const checked = continuation(options.value);
    if (checked.kind === 'approval' && expected.kind === 'approval') {
      compareTarget(checked.target, expected.target);
      if (!expected.choices.some((choice) => choice.nativeChoiceId === checked.nativeChoiceId)) throw new InvalidInteraction('choice-mismatch');
    } else if (checked.kind === 'tool' && expected.kind === 'tool') {
      compareTarget(checked.outcome.target, expected.target);
    } else if (checked.kind === 'delegation' && expected.kind === 'delegation') {
      if (checked.outcomes.length !== expected.targets.length) throw new InvalidInteraction('target-mismatch');
      const expectedByKey = new Map(expected.targets.map((child) => [targetKey(child), child]));
      for (const outcome of checked.outcomes) {
        if (expectedByKey.has(targetKey(outcome.target))) continue;
        const candidate = expected.targets.find((child) => child.nativeDelegationId === outcome.target.nativeDelegationId);
        if (candidate) compareTarget(outcome.target, candidate);
        throw new InvalidInteraction('target-mismatch');
      }
    } else throw new InvalidInteraction('target-mismatch');
    return Object.freeze({ kind: 'ok', value: checked });
  } catch (error) {
    const code = typeof error === 'object' && error !== null
      ? internalCodes.get(error) ?? 'invalid-input' : 'invalid-input';
    return Object.freeze({ kind: 'error', error: Object.freeze({ code }) });
  }
}
