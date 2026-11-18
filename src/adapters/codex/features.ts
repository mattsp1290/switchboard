import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Capability } from '../../core/capabilities.js';
import type { Outcome } from '../../core/contracts.js';

/*
 * Typed, host-controlled Codex native settings. Every type below mirrors the bindings that the pinned 0.169.0 binary
 * emits with `codex app-server generate-ts --experimental` (paths relative to that output; never committed):
 * v2/ThreadStartParams.ts, v2/ThreadResumeParams.ts, v2/TurnStartParams.ts, v2/AskForApproval.ts,
 * v2/ApprovalsReviewer.ts, v2/SandboxMode.ts, v2/SandboxPolicy.ts, v2/NetworkAccess.ts, v2/DynamicToolSpec.ts,
 * v2/DynamicToolFunctionSpec.ts, v2/DynamicToolNamespaceSpec.ts, ReasoningEffort.ts and InitializeCapabilities.ts.
 *
 * The adapter adds no setting: an omitted field keeps Codex's own default, and nothing forces an approval policy,
 * sandbox or tool allowlist. Raw passthrough keys the host also supplies are preserved unchanged.
 * With no `features` the raw params pass exactly as before; with `features`, the protocol's combination rules and the
 * dynamicTools gate apply to the merged request. A typed field that
 * contradicts a raw key, or a combination the protocol forbids, fails with `invalid-input` and nothing is sent.
 */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never' | { readonly granular: {
  readonly sandbox_approval: boolean; readonly rules: boolean; readonly skill_approval: boolean;
  readonly request_permissions: boolean; readonly mcp_elicitations: boolean } };
export type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexSandboxPolicy = { readonly type: 'dangerFullAccess' }
  | { readonly type: 'readOnly'; readonly networkAccess: boolean }
  | { readonly type: 'externalSandbox'; readonly networkAccess: 'restricted' | 'enabled' }
  | { readonly type: 'workspaceWrite'; readonly writableRoots: readonly string[]; readonly networkAccess: boolean;
    readonly excludeTmpdirEnvVar: boolean; readonly excludeSlashTmp: boolean };
export interface CodexDynamicFunction {
  readonly type: 'function'; readonly name: string; readonly description: string; readonly inputSchema: unknown;
  readonly deferLoading?: boolean;
}
export type CodexDynamicTool = CodexDynamicFunction | { readonly type: 'namespace'; readonly name: string;
  readonly description: string; readonly tools: readonly CodexDynamicFunction[] };
/** Settings shared by `thread/start` and `thread/resume`. `cwd` must be absolute: no ambient working directory. */
export interface CodexThreadFeatures {
  readonly model?: string;
  readonly cwd?: string;
  readonly approvalPolicy?: CodexApprovalPolicy;
  readonly approvalsReviewer?: CodexApprovalsReviewer;
  /** Cannot be combined with `permissions` (protocol rule). */
  readonly sandbox?: CodexSandboxMode;
  /** Named native permissions profile id. */
  readonly permissions?: string;
}
/** `thread/start` only. `dynamicTools` is experimental: it requires `initialize.capabilities.experimentalApi === true`. */
export interface CodexStartFeatures extends CodexThreadFeatures {
  readonly dynamicTools?: readonly CodexDynamicTool[];
}
/** `turn/start` overrides; natively they apply to this turn and subsequent turns. */
export interface CodexTurnFeatures {
  readonly model?: string;
  readonly cwd?: string;
  readonly approvalPolicy?: CodexApprovalPolicy;
  readonly approvalsReviewer?: CodexApprovalsReviewer;
  /** Cannot be combined with `permissions` (protocol rule). */
  readonly sandboxPolicy?: CodexSandboxPolicy;
  readonly permissions?: string;
  /** Native `ReasoningEffort` is an open string. */
  readonly effort?: string;
}
export type CodexFeatureTarget = 'thread/start' | 'thread/resume' | 'turn/start';

/**
 * `qualified`: a pinned native run proved it (codex-native-api.md). `fixture-only`: seen only in a diagnostic fixture.
 * `typed-unqualified`: validated and delivered exactly, native effect unproven. `passthrough-unqualified`: delivered
 * unchanged as raw params or opaque events, with no adapter meaning.
 */
export type CodexFeatureQualification = 'qualified' | 'fixture-only' | 'typed-unqualified' | 'passthrough-unqualified';
export interface CodexFeatureSupport {
  readonly qualification: CodexFeatureQualification;
  readonly carriers: readonly string[];
  readonly note: string;
}
const supported = (qualification: CodexFeatureQualification, carriers: readonly string[], note: string):
Capability<CodexFeatureSupport> => Object.freeze({ kind: 'supported',
  api: Object.freeze({ qualification, carriers: Object.freeze([...carriers]), note }) });
export const codexFeatureCapabilities = Object.freeze({
  'command-approval-decline': supported('qualified', ['onServerRequest'],
    'A native command approval request declined by the host leaves the item declined and the command unrun.'),
  'approval-policy': supported('typed-unqualified', ['approvalPolicy', 'approvalsReviewer'],
    'Delivered exactly; approval acceptance, file-change and permission journeys are unqualified.'),
  'sandbox': supported('typed-unqualified', ['sandbox', 'sandboxPolicy', 'permissions'],
    'Delivered exactly; native enforcement is unqualified.'),
  'model': supported('typed-unqualified', ['model', 'effort'],
    'Selects a native model name only; routing and model mapping are not decided here.'),
  'cwd': supported('typed-unqualified', ['cwd'], 'Absolute paths only.'),
  'dynamic-tools': supported('fixture-only', ['dynamicTools'],
    'Experimental thread/start.dynamicTools; requires initialize capabilities.experimentalApi. A warm tool call reply was observed in a diagnostic fixture only.'),
  'config-overrides': supported('passthrough-unqualified', ['config'],
    'Native config overrides, including MCP servers and features, pass through unchanged.'),
  'plugins-and-capability-roots': supported('passthrough-unqualified', ['disabledPluginIds', 'selectedCapabilityRoots'],
    'Passed through unchanged; nothing is disabled by the adapter.'),
  'environments': supported('passthrough-unqualified', ['environments', 'runtimeWorkspaceRoots'], 'Passed through unchanged.'),
  'opaque-events': supported('passthrough-unqualified', ['native'],
    'Undecoded notifications are kept as native events labeled unqualified.'),
} as const);

const approvals = ['untrusted', 'on-request', 'never'];
const granularKeys = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'];
const reviewers = ['user', 'auto_review', 'guardian_subagent'];
const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'];
const typedKeys: Record<CodexFeatureTarget, readonly string[]> = {
  'thread/start': ['model', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions', 'dynamicTools'],
  'thread/resume': ['model', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions'],
  'turn/start': ['model', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'effort'],
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const bool = (value: unknown) => typeof value === 'boolean';

function approvalPolicy(value: unknown): boolean {
  if (typeof value === 'string') return approvals.includes(value);
  return record(value) && exactKeys(value, ['granular']) && record(value.granular)
    && exactKeys(value.granular, granularKeys) && granularKeys.every((key) => bool((value.granular as Record<string, unknown>)[key]));
}
function sandboxPolicy(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.type) {
    case 'dangerFullAccess': return exactKeys(value, ['type']);
    case 'readOnly': return exactKeys(value, ['type', 'networkAccess']) && bool(value.networkAccess);
    case 'externalSandbox': return exactKeys(value, ['type', 'networkAccess'])
      && (value.networkAccess === 'restricted' || value.networkAccess === 'enabled');
    case 'workspaceWrite': return exactKeys(value, ['type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'])
      && Array.isArray(value.writableRoots) && value.writableRoots.every((root) => nonEmpty(root) && isAbsolute(root))
      && bool(value.networkAccess) && bool(value.excludeTmpdirEnvVar) && bool(value.excludeSlashTmp);
    default: return false;
  }
}
const checks: Record<string, (value: unknown) => boolean> = {
  model: nonEmpty, permissions: nonEmpty, effort: nonEmpty,
  cwd: (value) => nonEmpty(value) && isAbsolute(value),
  approvalPolicy, sandboxPolicy,
  approvalsReviewer: (value) => typeof value === 'string' && reviewers.includes(value),
  sandbox: (value) => typeof value === 'string' && sandboxModes.includes(value),
  dynamicTools: Array.isArray,
};

/**
 * Rules from the 0.169.0 binary's own dynamic-tool error strings (not in the generated types), checked before sending
 * so a host sees which tool is wrong.
 */
function dynamicToolsProblem(tools: readonly unknown[]): string | undefined {
  const named = (spec: unknown, where: string): string | undefined => {
    if (!record(spec) || !nonEmpty(spec.name)) return `${where} needs a non-empty name`;
    if (spec.name.trim() !== spec.name) return `${where} name "${spec.name}" has leading or trailing whitespace`;
    if (typeof spec.description !== 'string') return `${where} "${spec.name}" needs a description`;
    return undefined;
  };
  const fn = (spec: unknown, where: string, namespaced: boolean): string | undefined => {
    const problem = named(spec, where);
    if (problem || !record(spec)) return problem;
    if (spec.type !== 'function' || !Object.hasOwn(spec, 'inputSchema')) return `${where} "${spec.name}" must be a function with inputSchema`;
    if (spec.deferLoading !== undefined && !bool(spec.deferLoading)) return `${where} "${spec.name}" deferLoading must be boolean`;
    if (spec.deferLoading === true && !namespaced) return `${where} "${spec.name}" defers loading outside a namespace`;
    return undefined;
  };
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  for (const spec of tools) {
    if (record(spec) && spec.type === 'namespace') {
      const problem = named(spec, 'dynamic tool namespace');
      if (problem) return problem;
      if (namespaces.has(spec.name as string)) return `duplicate dynamic tool namespace "${spec.name as string}"`;
      namespaces.add(spec.name as string);
      if (!Array.isArray(spec.tools) || spec.tools.length === 0) return `dynamic tool namespace "${spec.name as string}" has no tools`;
      const inner = new Set<string>();
      for (const tool of spec.tools) {
        const issue = fn(tool, `dynamic tool in namespace "${spec.name as string}"`, true);
        if (issue) return issue;
        const name = (tool as { name: string }).name;
        if (inner.has(name)) return `duplicate dynamic tool name "${name}" in namespace "${spec.name as string}"`;
        inner.add(name);
      }
    } else {
      const problem = fn(spec, 'dynamic tool', false);
      if (problem) return problem;
      const name = (spec as { name: string }).name;
      if (functions.has(name)) return `duplicate dynamic tool name "${name}"`;
      functions.add(name);
    }
  }
  return undefined;
}

/** The `invalid-input` member of core `AdapterError`, always with a message naming the rejected setting. */
export type CodexFeatureError = { readonly code: 'invalid-input'; readonly message: string };
const invalid = (message: string): Outcome<never, CodexFeatureError> => ({ kind: 'error', error: Object.freeze({ code: 'invalid-input', message }) });

/**
 * Merges typed `features` into the raw passthrough `params` for one native request. Raw keys survive unchanged; a typed
 * field equal to its raw key is accepted, a different one is a visible conflict. `initialize` is the native
 * `InitializeParams` this connection sent. Pure: it never sends, defaults or removes anything.
 */
export function resolveCodexFeatures(target: CodexFeatureTarget, features: unknown, params: Readonly<Record<string, unknown>>,
  initialize: Readonly<Record<string, unknown>>): Outcome<Record<string, unknown>, CodexFeatureError> {
  // Without `features` the raw params are untouched passthrough, exactly as before this module existed.
  if (features === undefined) return { kind: 'ok', value: { ...params } };
  const merged: Record<string, unknown> = { ...params };
  if (!record(features)) return invalid(`${target} features must be an object`);
  for (const [key, value] of Object.entries(features)) {
    if (value === undefined) continue;
    if (!typedKeys[target].includes(key)) return invalid(`${target} has no typed feature "${key}"`);
    if (!checks[key]!(value)) return invalid(`${target} feature "${key}" is not an allowed native value`);
    // A raw null is natively "unset", so only a raw value is a competing setting.
    if (params[key] != null && !isDeepStrictEqual(params[key], value)) {
      return invalid(`${target} feature "${key}" conflicts with the raw params value`);
    }
    // A copy, so a host mutating its object after validation cannot change what is sent.
    merged[key] = structuredClone(value);
  }
  const sandboxKey = target === 'turn/start' ? 'sandboxPolicy' : 'sandbox';
  if (merged[sandboxKey] != null && merged.permissions != null) {
    return invalid(`${target} cannot combine "${sandboxKey}" with "permissions"`);
  }
  // Only thread/start carries dynamicTools natively; elsewhere a raw key stays untouched passthrough.
  if (target === 'thread/start' && merged.dynamicTools != null) {
    const capabilities = initialize.capabilities;
    if (!record(capabilities) || capabilities.experimentalApi !== true) {
      return invalid('dynamicTools requires initialize capabilities.experimentalApi === true');
    }
    if (!Array.isArray(merged.dynamicTools)) return invalid('dynamicTools must be an array');
    const problem = dynamicToolsProblem(merged.dynamicTools);
    if (problem) return invalid(problem);
  }
  return { kind: 'ok', value: merged };
}
