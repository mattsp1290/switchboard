import { EventType } from '@ag-ui/core';
import type { ActivitySnapshotEvent, JsonPatch, JsonPatchOperation } from '@ag-ui/core';
import type { Outcome } from '../core/contracts.js';
import type { Encoding, ProjectionOptions } from './basic.js';
import { failure, identity, record, reject, string } from './internal.js';
import type { DeepReadonly, Json, NativeRef, ProjectionError } from './internal.js';

type NativeOperation<P = JsonPatchOperation> = P extends JsonPatchOperation
  ? DeepReadonly<Omit<P, 'value'>> & (P extends { value: unknown } ? { readonly value: Json } : {})
    & { readonly [key: string]: Json }
  : never;
export type NativeJsonPatch = readonly NativeOperation[];
type ActivityContent = DeepReadonly<ActivitySnapshotEvent['content']>;
export type ProjectionFamily = 'state' | 'activity' | 'raw' | 'custom';
export type NativeAvailability = 'supported' | 'unavailable' | 'unsupported' | 'undeclared';
export type NativeQualification = 'qualified' | 'unqualified' | 'undeclared';
export interface ProjectionEvidence {
  readonly availability?: NativeAvailability;
  readonly qualification?: NativeQualification;
}
export interface ProjectionDescription {
  readonly family: ProjectionFamily;
  readonly representability: 'represented';
  readonly availability: NativeAvailability;
  readonly qualification: NativeQualification;
}
export type AdvancedFact = { readonly timestamp?: number; readonly owner?: NativeRef } & (
  | { readonly kind: 'state-snapshot'; readonly snapshot: Json }
  | { readonly kind: 'state-delta'; readonly delta: NativeJsonPatch }
  | { readonly kind: 'activity-snapshot'; readonly message: NativeRef; readonly activityType: string;
      readonly content: ActivityContent; readonly replace?: boolean }
  | { readonly kind: 'activity-delta'; readonly message: NativeRef; readonly activityType: string; readonly patch: NativeJsonPatch }
  | { readonly kind: 'raw'; readonly namespace: string; readonly schemaVersion: string; readonly publicPayload: Json }
  | { readonly kind: 'custom'; readonly namespace: string; readonly schemaVersion: string; readonly name: string; readonly publicPayload: Json }
  | { readonly kind: 'not-observable'; readonly family: ProjectionFamily }
);

function family(value: unknown): ProjectionFamily {
  if (value !== 'state' && value !== 'activity' && value !== 'raw' && value !== 'custom') reject();
  return value;
}

export function describeProjection(
  selected: ProjectionFamily,
  evidence: ProjectionEvidence = {},
): Outcome<ProjectionDescription, ProjectionError> {
  try {
    const fields = record(evidence, ['availability', 'qualification']);
    const availability = fields.availability ?? 'undeclared';
    const qualification = fields.qualification ?? 'undeclared';
    if (availability !== 'supported' && availability !== 'unavailable' && availability !== 'unsupported' && availability !== 'undeclared') reject();
    if (qualification !== 'qualified' && qualification !== 'unqualified' && qualification !== 'undeclared') reject();
    if (fields.availability === null || fields.qualification === null) reject();
    return Object.freeze({ kind: 'ok', value: Object.freeze({
      family: family(selected), representability: 'represented', availability, qualification,
    }) });
  } catch (error) {
    return failure(error);
  }
}

function pointer(value: unknown): string {
  const path = string(value);
  if (path !== '' && !/^\/(?:[^~]|~[01])*$/.test(path)) reject();
  return path;
}

function jsonObject(value: Json): { readonly [key: string]: Json } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
  return value as { readonly [key: string]: Json };
}

function member(value: { readonly [key: string]: Json }, key: string): Json {
  const found = value[key];
  if (found === undefined) reject();
  return found;
}

function patch(value: Json): JsonPatch {
  if (!Array.isArray(value)) reject();
  return value.map((item: Json): JsonPatchOperation => {
    const fields = jsonObject(item);
    const path = pointer(fields.path);
    switch (fields.op) {
      case 'add':
      case 'replace':
      case 'test':
        return { ...fields, op: fields.op, path, value: member(fields, 'value') };
      case 'remove':
        return { ...fields, op: fields.op, path };
      case 'move':
      case 'copy':
        return { ...fields, op: fields.op, path, from: pointer(fields.from) };
      default:
        return reject();
    }
  });
}

function activityPatch(value: Json): JsonPatch {
  const operations = patch(value);
  const last = operations.at(-1);
  if (last?.path === '' && (last.op === 'add' || last.op === 'replace')) {
    if (last.value === null || typeof last.value !== 'object' || Array.isArray(last.value)) reject();
  }
  return operations;
}

export function encodeAdvanced(value: Json, options: ProjectionOptions): Encoding {
  const fields = jsonObject(value);
  const timestamp = fields.timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) reject();
  const owner = fields.owner === undefined ? undefined : identity(options.sourceKey, 'subagent', fields.owner);
  const common = { ...(timestamp === undefined ? {} : { timestamp }),
    ...(owner === undefined ? {} : { subagentRunId: owner }) };
  const allowed = (keys: readonly string[]) => record(value, ['kind', 'timestamp', 'owner', ...keys]);
  const transition = { kind: 'observe', owner } satisfies Encoding['transition'];
  switch (fields.kind) {
    case 'state-snapshot':
      allowed(['snapshot']);
      return { transition, events: [{ type: EventType.STATE_SNAPSHOT, ...common, snapshot: member(fields, 'snapshot') }] };
    case 'state-delta':
      allowed(['delta']);
      return { transition, events: [{ type: EventType.STATE_DELTA, ...common, delta: patch(member(fields, 'delta')) }] };
    case 'activity-snapshot':
    case 'activity-delta': {
      const snapshot = fields.kind === 'activity-snapshot';
      allowed(snapshot ? ['message', 'activityType', 'content', 'replace'] : ['message', 'activityType', 'patch']);
      const messageId = identity(options.sourceKey, 'message', fields.message);
      const activityType = string(fields.activityType);
      const replace = fields.replace;
      if (snapshot && replace !== undefined && typeof replace !== 'boolean') reject();
      return { transition: { kind: 'activity', id: messageId, owner, activityType,
        mode: snapshot ? replace === false ? 'preserve' : 'replace' : 'delta' }, events: [snapshot
        ? { type: EventType.ACTIVITY_SNAPSHOT, ...common, messageId, activityType,
          content: jsonObject(member(fields, 'content')), ...(replace === undefined ? {} : { replace: replace === true }) }
        : { type: EventType.ACTIVITY_DELTA, ...common, messageId, activityType, patch: activityPatch(member(fields, 'patch')) },
      ] };
    }
    case 'raw':
    case 'custom': {
      allowed(fields.kind === 'raw' ? ['namespace', 'schemaVersion', 'publicPayload'] : ['namespace', 'schemaVersion', 'name', 'publicPayload']);
      const namespace = string(fields.namespace);
      const schemaVersion = string(fields.schemaVersion);
      if (!namespace || !schemaVersion) reject();
      const envelope = { namespace, schemaVersion, publicPayload: member(fields, 'publicPayload') };
      return { transition, events: [fields.kind === 'raw'
        ? { type: EventType.RAW, ...common, source: namespace, event: envelope }
        : { type: EventType.CUSTOM, ...common, name: string(fields.name), value: envelope },
      ] };
    }
    case 'not-observable':
      allowed(['family']);
      family(fields.family);
      return { transition, events: [] };
    default:
      return reject();
  }
}
