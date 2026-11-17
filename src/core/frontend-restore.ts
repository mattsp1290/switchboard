import { createHash } from 'node:crypto';
import type { Capability } from './capabilities.js';
import type { Outcome } from './contracts.js';
import type { ToolTarget } from './interaction.js';
import { parseSessionReference, sessionLimits } from './sessions.js';
import type { SessionBinding, SessionReference } from './sessions.js';

export type RestoreAdapter = 'codex' | 'claude' | 'pi';
export type RestoreMechanism = 'defer' | 'deliver-original' | 'settle-interrupted'
  | 'paired-repair' | 'continue-new-turn' | 'redispatch';
export type DeliveryClass = 'original-call' | 'paired-by-id' | 'unpaired-input' | 'not-delivered';
export type RestoreSituationKind = 'warm' | 'rejoinable' | 'original-lost' | 'already-settled' | 'indeterminate';
export type RestoreQualification = 'native-free' | 'qualified' | 'fixture-only';
export type RestoreAdmission = 'production' | 'fixture';
export type IndeterminateReason = 'epoch-conflict' | 'partial-native-output'
  | 'lookup-failed' | 'session-missing' | 'unsupported';

export interface PendingFrontendCall {
  readonly target: ToolTarget;
  readonly publicToolCallId: string;
  readonly argumentsDigest: string;
  readonly definitionDigest: string;
}
export interface PendingFrontendBatch {
  readonly formatVersion: 1;
  readonly adapter: RestoreAdapter;
  readonly session: SessionReference;
  readonly nativeTurnId: string;
  readonly epoch: string;
  readonly sourceRunId: string;
  readonly calls: readonly [PendingFrontendCall, ...PendingFrontendCall[]];
}

export type RestoreObservation =
  | { readonly kind: 'live-original'; readonly epoch: string }
  | { readonly kind: 'rejoined-original'; readonly epoch: string }
  | { readonly kind: 'native-ended'; readonly settledToolCallIds: readonly string[] }
  | { readonly kind: 'unobservable'; readonly reason: 'lookup-failed' | 'session-missing' | 'unsupported' };

export interface RestoreMechanismSupport {
  readonly qualification: RestoreQualification;
  readonly situations: readonly RestoreSituationKind[];
  readonly evidence: string;
}
export type FrontendRestoreCapabilities = {
  readonly [M in RestoreMechanism]: Capability<RestoreMechanismSupport>;
};

export const frontendRestoreDelivery = Object.freeze({
  'defer': 'not-delivered',
  'deliver-original': 'original-call',
  'settle-interrupted': 'not-delivered',
  'paired-repair': 'paired-by-id',
  'continue-new-turn': 'unpaired-input',
  'redispatch': 'not-delivered',
} as const satisfies { readonly [M in RestoreMechanism]: DeliveryClass });
type DeliveryOf = typeof frontendRestoreDelivery;

export type RestoreOption = { readonly [M in RestoreMechanism]: {
  readonly mechanism: M;
  readonly delivery: DeliveryOf[M];
  readonly qualification: RestoreQualification;
} }[RestoreMechanism];
type DeferOption = Extract<RestoreOption, { readonly mechanism: 'defer' }>;
interface SituationBase {
  readonly formatVersion: 1;
  readonly key: string;
  readonly batch: PendingFrontendBatch;
  readonly admission: RestoreAdmission;
  readonly options: readonly [DeferOption, ...RestoreOption[]];
}
type Classified =
  | { readonly kind: 'warm' }
  | { readonly kind: 'rejoinable'; readonly epoch: string }
  | { readonly kind: 'original-lost' }
  | { readonly kind: 'already-settled' }
  | { readonly kind: 'indeterminate'; readonly reason: IndeterminateReason };
export type RestoreSituation = SituationBase & Classified;

export type RestoreChoice =
  | { readonly kind: 'defer' }
  | { readonly kind: 'deliver-original' }
  | { readonly kind: 'settle-interrupted'; readonly reason: 'endpoint-lost' | 'app-cancelled' | 'expired' }
  | { readonly kind: 'paired-repair' }
  | { readonly kind: 'continue-new-turn'; readonly successorRunId: string }
  | { readonly kind: 'redispatch'; readonly executionGeneration: string;
      readonly replay: 'not-begun' | 'idempotent' | 'duplicate-risk-accepted' };
export type RestoreDecision = {
  readonly formatVersion: 1;
  readonly situationKey: string;
  readonly policyRevision: string;
} & RestoreChoice;

export interface FrontendRestorePolicy {
  readonly revision: string;
  readonly decide: (situation: RestoreSituation) => RestoreChoice | PromiseLike<RestoreChoice>;
}
export type RestoreDecisionComparison = { readonly decision: RestoreDecision } & (
  | { readonly effect: 'write' }
  | { readonly effect: 'replace-defer' }
  | { readonly effect: 'replay' }
  | { readonly effect: 'defer-ignored' }
);

export interface FrontendRestoreError {
  readonly code: 'invalid-input' | 'unsupported-version' | 'adapter-mismatch' | 'binding-mismatch'
    | 'session-mismatch' | 'stale-situation' | 'mechanism-unavailable' | 'decision-conflict';
}

type SituationPayload =
  | { readonly kind: Exclude<RestoreSituationKind, 'indeterminate'>; readonly key: string }
  | { readonly kind: 'indeterminate'; readonly key: string; readonly reason: IndeterminateReason };
type OptionPayload = { readonly [M in RestoreMechanism]: {
  readonly mechanism: M;
  readonly deliveryClass: DeliveryOf[M];
  readonly qualification: RestoreQualification;
} }[RestoreMechanism];
export type FrontendRestorePayload = {
  readonly sourceRunId: string;
  readonly toolCallIds: readonly string[];
  readonly situation: SituationPayload;
} & (
  | { readonly phase: 'required'; readonly options: readonly OptionPayload[] }
  | ({ readonly phase: 'decided'; readonly policyRevision: string } & OptionPayload)
);
export type FrontendRestoreFact = {
  readonly kind: 'custom';
  readonly namespace: 'switchboard.frontend-restore';
  readonly schemaVersion: '1';
  readonly name: 'frontend-restore';
  readonly publicPayload: FrontendRestorePayload;
};
export type FrontendRestoreFactInput =
  | { readonly phase: 'required'; readonly situation: RestoreSituation }
  | { readonly phase: 'decided'; readonly situation: RestoreSituation; readonly decision: unknown };

export const frontendRestoreLimits = Object.freeze({ maxCalls: 1000 });
export const frontendRestoreDefaultRevision = 'switchboard.default-defer';

const mechanisms = Object.freeze(Object.keys(frontendRestoreDelivery) as RestoreMechanism[]);
const situationKinds: readonly RestoreSituationKind[] = ['warm', 'rejoinable', 'original-lost', 'already-settled', 'indeterminate'];
const indeterminateReasons: readonly IndeterminateReason[] = ['epoch-conflict', 'partial-native-output',
  'lookup-failed', 'session-missing', 'unsupported'];
const legal: { readonly [K in RestoreSituationKind]: readonly RestoreMechanism[] } = {
  'warm': ['defer', 'deliver-original', 'settle-interrupted'],
  'rejoinable': ['defer', 'deliver-original', 'settle-interrupted'],
  'original-lost': ['defer', 'settle-interrupted', 'paired-repair', 'continue-new-turn', 'redispatch'],
  'already-settled': ['defer'],
  'indeterminate': ['defer'],
};

function supported(qualification: RestoreQualification, situations: readonly RestoreSituationKind[],
  evidence: string): Capability<RestoreMechanismSupport> {
  return Object.freeze({ kind: 'supported', api: Object.freeze({ qualification,
    situations: Object.freeze([...situations]), evidence }) });
}
function unavailable(reason: string): Capability<RestoreMechanismSupport> {
  return Object.freeze({ kind: 'unavailable', reason });
}
function table(adapter: RestoreAdapter): FrontendRestoreCapabilities {
  const pairing = {
    codex: 'thread/inject_items and turn/start.toolOutput pairing is unqualified.',
    claude: 'Resume with a tool_result for the original tool_use is unqualified.',
    pi: 'appendMessage of a toolResult followed by continue() is unqualified.',
  }[adapter];
  return Object.freeze({
    'defer': supported('native-free', situationKinds,
      'Defer performs no native call and leaves native state untouched.'),
    'settle-interrupted': supported('native-free', ['warm', 'rejoinable', 'original-lost'],
      'Settlement is an app ledger disposition and performs no native call.'),
    'deliver-original': adapter === 'codex'
      ? supported('fixture-only', ['warm'],
        'A warm item/tool/call reply under experimental thread/start.dynamicTools was observed in a diagnostic fixture only.')
      : unavailable('The adapter implements no frontend tool callback.'),
    'paired-repair': unavailable(pairing),
    'continue-new-turn': unavailable('New-turn continuation semantics are unqualified.'),
    'redispatch': unavailable('Redispatch execution is not implemented.'),
  });
}
export const frontendRestoreCapabilities: { readonly [A in RestoreAdapter]: FrontendRestoreCapabilities } = Object.freeze({
  codex: table('codex'),
  claude: table('claude'),
  pi: table('pi'),
});

const failures = new WeakMap<object, FrontendRestoreError['code']>();
class RestoreFailure extends Error {
  constructor(code: FrontendRestoreError['code'] = 'invalid-input') {
    super(code);
    failures.set(this, code);
  }
}
function fail(error: unknown): { readonly kind: 'error'; readonly error: FrontendRestoreError } {
  const code = typeof error === 'object' && error !== null ? failures.get(error) ?? 'invalid-input' : 'invalid-input';
  return Object.freeze({ kind: 'error', error: Object.freeze({ code }) });
}
function ok<T>(value: T): { readonly kind: 'ok'; readonly value: T } {
  return Object.freeze({ kind: 'ok', value });
}
function fields(value: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RestoreFailure();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new RestoreFailure();
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new RestoreFailure();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) throw new RestoreFailure();
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}
function exact(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RestoreFailure();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > sessionLimits.identifierLength) {
    throw new RestoreFailure();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) throw new RestoreFailure();
  }
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new RestoreFailure();
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new RestoreFailure();
  return value as T;
}
function version(value: unknown): 1 {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RestoreFailure();
  if (value !== 1) throw new RestoreFailure('unsupported-version');
  return 1;
}
function list(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new RestoreFailure();
  const { length } = value;
  if (length < minimum || length > maximum) throw new RestoreFailure();
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !('value' in descriptor)) throw new RestoreFailure();
    return descriptor.value as unknown;
  });
}
function binding(value: unknown): SessionBinding {
  const raw = fields(value, ['engine', 'nativeVersion', 'account', 'authorizedScope', 'nativeFormat']);
  return { engine: text(raw.engine), nativeVersion: text(raw.nativeVersion), account: text(raw.account),
    authorizedScope: text(raw.authorizedScope), nativeFormat: text(raw.nativeFormat) };
}
function session(value: unknown): SessionReference {
  const raw = fields(value, ['kind', 'formatVersion', 'binding', 'opaque']);
  const expected = binding(raw.binding);
  const parsed = parseSessionReference({ value: { ...raw, binding: expected }, expected });
  if (parsed.kind === 'error') {
    throw new RestoreFailure(parsed.error.code === 'unsupported-version' ? 'unsupported-version' : 'invalid-input');
  }
  return parsed.value;
}
function call(value: unknown, owner: SessionReference): PendingFrontendCall {
  const raw = fields(value, ['target', 'publicToolCallId', 'argumentsDigest', 'definitionDigest']);
  const target = fields(raw.target, ['kind', 'session', 'nativeToolCallId']);
  if (target.kind !== 'tool') throw new RestoreFailure();
  if (JSON.stringify(session(target.session)) !== JSON.stringify(owner)) throw new RestoreFailure('session-mismatch');
  return Object.freeze({
    target: Object.freeze({ kind: 'tool', session: owner, nativeToolCallId: text(target.nativeToolCallId) }),
    publicToolCallId: text(raw.publicToolCallId),
    argumentsDigest: digest(raw.argumentsDigest),
    definitionDigest: digest(raw.definitionDigest),
  });
}
function batch(value: unknown): PendingFrontendBatch {
  const raw = fields(value, ['formatVersion', 'adapter', 'session', 'nativeTurnId', 'epoch', 'sourceRunId', 'calls']);
  const formatVersion = version(raw.formatVersion);
  const owner = session(raw.session);
  const calls = list(raw.calls, 1, frontendRestoreLimits.maxCalls).map((item) => call(item, owner));
  const [first, ...rest] = calls;
  if (!first) throw new RestoreFailure();
  for (const ids of [calls.map((item) => item.target.nativeToolCallId), calls.map((item) => item.publicToolCallId)]) {
    if (new Set(ids).size !== ids.length) throw new RestoreFailure();
  }
  return Object.freeze({
    formatVersion,
    adapter: oneOf(raw.adapter, ['codex', 'claude', 'pi'] as const),
    session: owner,
    nativeTurnId: text(raw.nativeTurnId),
    epoch: text(raw.epoch),
    sourceRunId: text(raw.sourceRunId),
    calls: Object.freeze([first, ...rest] as const),
  });
}

export function parsePendingFrontendBatch(options: {
  readonly value: unknown;
  readonly expected: { readonly adapter: RestoreAdapter; readonly session: SessionReference };
}): Outcome<PendingFrontendBatch, FrontendRestoreError> {
  try {
    const { value, expected: rawExpected } = fields(options, ['value', 'expected']);
    const expected = fields(rawExpected, ['adapter', 'session']);
    const adapter = oneOf(expected.adapter, ['codex', 'claude', 'pi'] as const);
    const owner = session(expected.session);
    const parsed = batch(value);
    if (parsed.adapter !== adapter) throw new RestoreFailure('adapter-mismatch');
    if (JSON.stringify(parsed.session.binding) !== JSON.stringify(owner.binding)) throw new RestoreFailure('binding-mismatch');
    if (parsed.session.opaque !== owner.opaque) throw new RestoreFailure('session-mismatch');
    return ok(parsed);
  } catch (error) {
    return fail(error);
  }
}

function classify(pending: PendingFrontendBatch, value: unknown): Classified {
  const raw = fields(value, ['kind', 'epoch', 'settledToolCallIds', 'reason']);
  switch (raw.kind) {
    case 'live-original': {
      exact(raw, ['kind', 'epoch']);
      return text(raw.epoch) === pending.epoch ? { kind: 'warm' } : { kind: 'indeterminate', reason: 'epoch-conflict' };
    }
    case 'rejoined-original': {
      exact(raw, ['kind', 'epoch']);
      const epoch = text(raw.epoch);
      return epoch === pending.epoch ? { kind: 'indeterminate', reason: 'epoch-conflict' } : { kind: 'rejoinable', epoch };
    }
    case 'native-ended': {
      exact(raw, ['kind', 'settledToolCallIds']);
      const settled = list(raw.settledToolCallIds, 0, frontendRestoreLimits.maxCalls).map(text);
      const known = new Set(pending.calls.map((item) => item.target.nativeToolCallId));
      if (new Set(settled).size !== settled.length || settled.some((id) => !known.has(id))) throw new RestoreFailure();
      if (settled.length === 0) return { kind: 'original-lost' };
      return settled.length === known.size ? { kind: 'already-settled' } : { kind: 'indeterminate', reason: 'partial-native-output' };
    }
    case 'unobservable':
      exact(raw, ['kind', 'reason']);
      return { kind: 'indeterminate', reason: oneOf(raw.reason, ['lookup-failed', 'session-missing', 'unsupported'] as const) };
    default:
      throw new RestoreFailure();
  }
}

function situationOf(pending: PendingFrontendBatch, admission: RestoreAdmission, classified: Classified): RestoreSituation {
  const capabilities = frontendRestoreCapabilities[pending.adapter];
  const options = legal[classified.kind].flatMap((mechanism): RestoreOption[] => {
    const capability = capabilities[mechanism];
    if (capability.kind !== 'supported' || !capability.api.situations.includes(classified.kind)) return [];
    if (admission === 'production' && capability.api.qualification === 'fixture-only') return [];
    return [Object.freeze({ mechanism, delivery: frontendRestoreDelivery[mechanism],
      qualification: capability.api.qualification }) as RestoreOption];
  });
  const [first, ...rest] = options;
  if (first?.mechanism !== 'defer') throw new RestoreFailure();
  const frozenOptions = Object.freeze([first, ...rest] as const);
  const key = 'sha256:' + createHash('sha256').update(JSON.stringify(
    [1, pending, admission, classified, frozenOptions])).digest('hex');
  return Object.freeze({ formatVersion: 1, key, batch: pending, admission, options: frozenOptions, ...classified });
}

function verified(value: unknown): RestoreSituation {
  const raw = fields(value, ['formatVersion', 'key', 'batch', 'admission', 'options', 'kind', 'epoch', 'reason']);
  version(raw.formatVersion);
  const key = digest(raw.key);
  const kind = oneOf(raw.kind, situationKinds);
  exact(raw, ['formatVersion', 'key', 'batch', 'admission', 'options', 'kind',
    ...(kind === 'rejoinable' ? ['epoch'] : kind === 'indeterminate' ? ['reason'] : [])]);
  const classified: Classified = kind === 'rejoinable' ? { kind, epoch: text(raw.epoch) }
    : kind === 'indeterminate' ? { kind, reason: oneOf(raw.reason, indeterminateReasons) } : { kind };
  const pending = batch(raw.batch);
  if (kind === 'rejoinable' && classified.kind === 'rejoinable' && classified.epoch === pending.epoch) throw new RestoreFailure();
  const rebuilt = situationOf(pending, oneOf(raw.admission, ['production', 'fixture'] as const), classified);
  if (rebuilt.key !== key || JSON.stringify(rebuilt.options) !== JSON.stringify(raw.options)) throw new RestoreFailure('stale-situation');
  return rebuilt;
}

export function assessFrontendRestore(input: {
  readonly batch: PendingFrontendBatch;
  readonly observation: RestoreObservation;
  readonly admission: RestoreAdmission;
}): Outcome<RestoreSituation, FrontendRestoreError> {
  try {
    const raw = fields(input, ['batch', 'observation', 'admission']);
    const pending = batch(raw.batch);
    const admission = oneOf(raw.admission, ['production', 'fixture'] as const);
    return ok(situationOf(pending, admission, classify(pending, raw.observation)));
  } catch (error) {
    return fail(error);
  }
}

function choice(raw: Readonly<Record<string, unknown>>): RestoreChoice {
  const kind = oneOf(raw.kind, mechanisms);
  switch (kind) {
    case 'settle-interrupted':
      exact(raw, ['kind', 'reason']);
      return { kind, reason: oneOf(raw.reason, ['endpoint-lost', 'app-cancelled', 'expired'] as const) };
    case 'continue-new-turn':
      exact(raw, ['kind', 'successorRunId']);
      return { kind, successorRunId: text(raw.successorRunId) };
    case 'redispatch':
      exact(raw, ['kind', 'executionGeneration', 'replay']);
      return { kind, executionGeneration: text(raw.executionGeneration),
        replay: oneOf(raw.replay, ['not-begun', 'idempotent', 'duplicate-risk-accepted'] as const) };
    default:
      exact(raw, ['kind']);
      return { kind };
  }
}
function decision(value: unknown): RestoreDecision {
  const { formatVersion, situationKey, policyRevision, ...rest } = fields(value, ['formatVersion', 'situationKey',
    'policyRevision', 'kind', 'reason', 'successorRunId', 'executionGeneration', 'replay']);
  return Object.freeze({ formatVersion: version(formatVersion), situationKey: digest(situationKey),
    policyRevision: text(policyRevision), ...choice(rest) });
}
function admitted(situation: RestoreSituation, value: unknown): RestoreDecision {
  const checked = decision(value);
  if (checked.situationKey !== situation.key) throw new RestoreFailure('stale-situation');
  if (!situation.options.some((option) => option.mechanism === checked.kind)) throw new RestoreFailure('mechanism-unavailable');
  return checked;
}

export function validateRestoreDecision(input: {
  readonly situation: RestoreSituation;
  readonly decision: unknown;
}): Outcome<RestoreDecision, FrontendRestoreError> {
  try {
    const raw = fields(input, ['situation', 'decision']);
    return ok(admitted(verified(raw.situation), raw.decision));
  } catch (error) {
    return fail(error);
  }
}

export async function decideFrontendRestore(input: {
  readonly situation: RestoreSituation;
  readonly policy: FrontendRestorePolicy | null;
}): Promise<Outcome<RestoreDecision, FrontendRestoreError>> {
  try {
    const raw = fields(input, ['situation', 'policy']);
    const situation = verified(raw.situation);
    const deferred = Object.freeze({ formatVersion: 1, situationKey: situation.key,
      policyRevision: frontendRestoreDefaultRevision, kind: 'defer' } as const);
    if (raw.policy === null) return ok(deferred);
    const policy = fields(raw.policy, ['revision', 'decide']);
    const revision = text(policy.revision);
    const decide = policy.decide;
    if (typeof decide !== 'function') throw new RestoreFailure();
    let chosen: unknown;
    try {
      chosen = await Reflect.apply(decide, undefined, [situation]);
    } catch {
      return ok(deferred);
    }
    const choiceFields = fields(chosen, ['kind', 'reason', 'successorRunId', 'executionGeneration', 'replay']);
    return ok(admitted(situation, { ...choiceFields, formatVersion: 1, situationKey: situation.key, policyRevision: revision }));
  } catch (error) {
    return fail(error);
  }
}

function sameChoice(left: RestoreDecision, right: RestoreDecision): boolean {
  const canonical = ({ formatVersion: _a, situationKey: _b, policyRevision: _c, ...rest }: RestoreDecision) =>
    JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return canonical(left) === canonical(right);
}

export function compareRestoreDecisions(input: {
  readonly situation: RestoreSituation;
  readonly stored: unknown;
  readonly proposed: unknown;
}): Outcome<RestoreDecisionComparison, FrontendRestoreError> {
  try {
    const raw = fields(input, ['situation', 'stored', 'proposed']);
    const situation = verified(raw.situation);
    const proposed = admitted(situation, raw.proposed);
    if (!Object.hasOwn(raw, 'stored')) throw new RestoreFailure();
    if (raw.stored === null) return ok(Object.freeze({ effect: 'write', decision: proposed }));
    const stored = admitted(situation, raw.stored);
    if (sameChoice(stored, proposed)) return ok(Object.freeze({ effect: 'replay', decision: stored }));
    if (stored.kind === 'defer') return ok(Object.freeze({ effect: 'replace-defer', decision: proposed }));
    if (proposed.kind === 'defer') return ok(Object.freeze({ effect: 'defer-ignored', decision: stored }));
    throw new RestoreFailure('decision-conflict');
  } catch (error) {
    return fail(error);
  }
}

function optionPayload(mechanism: RestoreMechanism, qualification: RestoreQualification): OptionPayload {
  return Object.freeze({ mechanism, deliveryClass: frontendRestoreDelivery[mechanism], qualification }) as OptionPayload;
}

export function frontendRestoreFact(input: FrontendRestoreFactInput): Outcome<FrontendRestoreFact, FrontendRestoreError> {
  try {
    const raw = fields(input, ['phase', 'situation', 'decision']);
    const situation = verified(raw.situation);
    const summary: SituationPayload = situation.kind === 'indeterminate'
      ? Object.freeze({ kind: situation.kind, key: situation.key, reason: situation.reason })
      : Object.freeze({ kind: situation.kind, key: situation.key });
    const common = { sourceRunId: situation.batch.sourceRunId,
      toolCallIds: Object.freeze(situation.batch.calls.map((item) => item.publicToolCallId)), situation: summary };
    let publicPayload: FrontendRestorePayload;
    if (raw.phase === 'required') {
      exact(raw, ['phase', 'situation']);
      publicPayload = Object.freeze({ ...common, phase: 'required', options: Object.freeze(situation.options.map((option) =>
        optionPayload(option.mechanism, option.qualification))) });
    } else if (raw.phase === 'decided') {
      const checked = admitted(situation, raw.decision);
      const option = situation.options.find((item) => item.mechanism === checked.kind);
      if (!option) throw new RestoreFailure('mechanism-unavailable');
      publicPayload = Object.freeze({ ...common, phase: 'decided', policyRevision: checked.policyRevision,
        ...optionPayload(option.mechanism, option.qualification) });
    } else throw new RestoreFailure();
    return ok(Object.freeze({ kind: 'custom', namespace: 'switchboard.frontend-restore', schemaVersion: '1',
      name: 'frontend-restore', publicPayload }));
  } catch (error) {
    return fail(error);
  }
}
