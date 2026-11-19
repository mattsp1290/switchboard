import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Capability } from '../../core/capabilities.js';
import type { Outcome } from '../../core/contracts.js';

/*
 * Typed, host-controlled Codex native settings. Every type below mirrors the bindings that the pinned 0.169.0 binary
 * emits with `codex app-server generate-ts --experimental` (paths relative to that output; never committed):
 * v2/ThreadStartParams.ts, v2/ThreadResumeParams.ts, v2/TurnStartParams.ts, v2/AskForApproval.ts,
 * v2/ApprovalsReviewer.ts, v2/SandboxMode.ts, v2/SandboxPolicy.ts, v2/NetworkAccess.ts, v2/DynamicToolSpec.ts,
 * v2/DynamicToolFunctionSpec.ts, v2/DynamicToolNamespaceSpec.ts and ReasoningEffort.ts. Optional object fields follow
 * the `generate-json-schema --experimental` required lists: a defaulted field may be omitted and Codex applies its own
 * default.
 *
 * The adapter adds no setting: an omitted field keeps Codex's own default, and nothing forces an approval policy,
 * sandbox or tool allowlist, except under a proxy route (execution.ts routeOverride, approvals-under-route). A host
 * route does not take that pin: refuseHostRedirect refuses only modelProvider and config. unconfined still rejects an
 * unconfined reply for both kinds. A host route's multi-agent feature args live in index.ts and are not
 * codexProxyConfig or proxyConfined. Raw
 * passthrough keys the host also supplies are preserved unchanged and never re-validated.
 * With no `features` the raw params pass exactly as before; with `features`, the protocol's combination rules and the
 * experimentalApi gates apply to the merged request. A typed field that contradicts a raw key, or a combination the
 * protocol forbids, fails with `invalid-input` and nothing is sent. Every typed field also accepts `null`, which means
 * unset as natively: nothing is added, and a non-null raw value for the same key is a conflict.
 */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never' | { readonly granular: {
  readonly sandbox_approval: boolean; readonly rules: boolean; readonly skill_approval?: boolean;
  readonly request_permissions?: boolean; readonly mcp_elicitations: boolean } };
export type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexSandboxPolicy = { readonly type: 'dangerFullAccess' }
  | { readonly type: 'readOnly'; readonly networkAccess?: boolean }
  | { readonly type: 'externalSandbox'; readonly networkAccess?: 'restricted' | 'enabled' }
  | { readonly type: 'workspaceWrite'; readonly writableRoots?: readonly string[]; readonly networkAccess?: boolean;
    readonly excludeTmpdirEnvVar?: boolean; readonly excludeSlashTmp?: boolean };
export interface CodexDynamicFunction {
  readonly type: 'function'; readonly name: string; readonly description: string; readonly inputSchema: unknown;
  readonly deferLoading?: boolean;
}
export type CodexDynamicTool = CodexDynamicFunction | { readonly type: 'namespace'; readonly name: string;
  readonly description: string; readonly tools: readonly CodexDynamicFunction[] };
/**
 * Settings shared by `thread/start` and `thread/resume`. `cwd` must be absolute: no ambient working directory.
 * `permissions` and a granular `approvalPolicy` require `initialize.capabilities.experimentalApi === true`.
 */
export interface CodexThreadFeatures {
  readonly model?: string | null;
  readonly cwd?: string | null;
  readonly approvalPolicy?: CodexApprovalPolicy | null;
  readonly approvalsReviewer?: CodexApprovalsReviewer | null;
  /** Cannot be combined with `permissions` (protocol rule). */
  readonly sandbox?: CodexSandboxMode | null;
  /** Named native permissions profile id. */
  readonly permissions?: string | null;
}
/**
 * `thread/start` only. `dynamicTools` is experimental: it requires `initialize.capabilities.experimentalApi === true`,
 * and a resumed thread or a turn cannot change it.
 */
export interface CodexStartFeatures extends CodexThreadFeatures {
  readonly dynamicTools?: readonly CodexDynamicTool[] | null;
}
/** `turn/start` overrides; natively they apply to this turn and subsequent turns. Gates as for thread features. */
export interface CodexTurnFeatures {
  readonly model?: string | null;
  readonly cwd?: string | null;
  readonly approvalPolicy?: CodexApprovalPolicy | null;
  readonly approvalsReviewer?: CodexApprovalsReviewer | null;
  /** Cannot be combined with `permissions` (protocol rule). */
  readonly sandboxPolicy?: CodexSandboxPolicy | null;
  readonly permissions?: string | null;
  /** Native `ReasoningEffort` is an open string. */
  readonly effort?: string | null;
}
export type CodexFeatureTarget = 'thread/start' | 'thread/resume' | 'turn/start';

/**
 * `qualified`: a pinned native run proved it (codex-native-api.md). `fixture-only`: seen only in a diagnostic fixture.
 * `typed-unqualified`: validated and delivered exactly, native effect unproven. `passthrough-unqualified`: delivered
 * unchanged as raw params or opaque events, with no adapter meaning.
 */
export type CodexFeatureQualification = 'qualified' | 'fixture-only' | 'typed-unqualified' | 'passthrough-unqualified';
/** Native fields carrying the feature, per request or channel; a target that is absent has no such field. */
export type CodexFeatureCarriers = Readonly<Partial<Record<CodexFeatureTarget | 'onServerRequest' | 'notifications' | 'options' | 'app-server',
  readonly string[]>>>;
export interface CodexFeatureSupport {
  readonly qualification: CodexFeatureQualification;
  readonly carriers: CodexFeatureCarriers;
  readonly note: string;
}
const supported = (qualification: CodexFeatureQualification, carriers: CodexFeatureCarriers, note: string):
Capability<CodexFeatureSupport> => Object.freeze({ kind: 'supported', api: Object.freeze({ qualification, note,
  carriers: Object.freeze(Object.fromEntries(Object.entries(carriers).map(([at, keys]) => [at, Object.freeze([...keys])]))) }) });
const unsupported = (reason: string): Capability<CodexFeatureSupport> => Object.freeze({ kind: 'unsupported', reason });
const unavailable = (reason: string): Capability<CodexFeatureSupport> => Object.freeze({ kind: 'unavailable', reason });
const everyTarget = (start: readonly string[], resume = start, turn = start): CodexFeatureCarriers =>
  ({ 'thread/start': start, 'thread/resume': resume, 'turn/start': turn });
const gate = 'initialize capabilities.experimentalApi === true';
export const codexFeatureCapabilities = Object.freeze({
  'command-approval-decline': supported('qualified', { onServerRequest: ['item/commandExecution/requestApproval'] },
    'A native command approval request declined by the host leaves the item declined and the command unrun. Under a '
    + 'proxy route native sends none: approvals are pinned off (approvals-under-route).'),
  'approval-policy': supported('typed-unqualified', everyTarget(['approvalPolicy', 'approvalsReviewer']),
    `Delivered exactly; a granular approvalPolicy requires ${gate}. Approval acceptance, file-change and permission `
    + 'journeys are unqualified. Under a proxy route only "never" is accepted and an absent approvalPolicy is sent as "never" (approvals-under-route).'),
  'sandbox': supported('typed-unqualified', everyTarget(['sandbox', 'permissions'], ['sandbox', 'permissions'], ['sandboxPolicy', 'permissions']),
    `Delivered exactly; permissions requires ${gate}. Native enforcement is unqualified. Under a proxy route a networked `
    + 'shell is refused (networked-shell-under-route) and routed config pins a read-only sandbox without network.'),
  'model': supported('typed-unqualified', everyTarget(['model'], ['model'], ['model', 'effort']),
    'Selects a native model name only. Under a LiteLLM proxy route only route.model is accepted (execution.ts routeOverride); others are invalid-input, unsent.'),
  'cwd': supported('typed-unqualified', everyTarget(['cwd']), 'Absolute paths only.'),
  'dynamic-tools': supported('typed-unqualified', { 'thread/start': ['dynamicTools'] },
    `Experimental thread/start.dynamicTools; requires ${gate}. The host adapter sends the host's declarations here and `
    + 'refuses item/tool/call for any tool that was not declared. thread/resume ignores dynamicTools (host-tool-probes A2). '
    + 'The wire was probed; a production native proof is still typed-unqualified until the host-adapter job records it.'),
  'dynamic-tools-after-start': unsupported('thread/resume and turn/start have no dynamicTools field in the 0.169.0 protocol; tools are fixed at thread/start.'),
  'routing': supported('fixture-only', { options: ['route'], 'app-server': ['codexProxyConfig'] },
    'LiteLLM Responses route with host-resolved command auth (proxy.ts): synthetic loopback only (codex-native-api.md, '
    + 'LiteLLM route). The route fixes the model: another model or collaborationMode is invalid-input, unsent. A thread that '
    + 'starts or resumes on another model is native-failure: resume it with params.model = route.model. Routed config '
    + 'disables multi-agent (multi-agent-under-route), networked shells (networked-shell-under-route) and approvals '
    + '(approvals-under-route). Live LiteLLM qualification is owned by switchboard-ov4y.'),
  'host-route': supported('typed-unqualified', { options: ['route'], 'app-server': ['codexHostRouteConfig'],
    'thread/start': ['modelProvider', 'config'] },
    'Host provider route. refuseHostRedirect refuses only modelProvider and config. '
    + 'Model, sandbox, and approvals are not pinned in codexHostRouteConfig. '
    + 'Multi-agent feature args live in index.ts. unconfined rejects an unconfined reply for both route kinds. '
    + 'Off-model failure is litellm-proxy only.'),
  'multi-agent-under-route': unavailable('Under a proxy route, codexProxyConfig sets features.multi_agent and '
    + 'features.multi_agent_v2 to false: a sub-agent spawn_agent model argument would send requests on a model the model '
    + 'chose, bypassing the route model. The host cannot re-enable it: routed thread config is refused. Direct mode keeps '
    + 'native multi-agent.'),
  'networked-shell-under-route': unavailable('Under a proxy route, a shell with network could run the credential helper '
    + 'against the broker socket for a fresh route token and send requests on any model. Always refused, with no opt-in: '
    + 'sandbox danger-full-access, a sandboxPolicy other than readOnly or workspaceWrite without networkAccess, and any '
    + 'permissions profile are invalid-input, unsent; codexProxyConfig pins sandbox_mode read-only with '
    + 'network_access false, and approvals are off (approvals-under-route).'),
  'approvals-under-route': unavailable('Under a proxy route, an approved escalated command (exec_command sandbox_permissions '
    + 'require_escalated) runs outside the sandbox, where it could run the credential helper for a fresh route token and '
    + 'send requests on any model. Always off, with no opt-in: codexProxyConfig pins approval_policy never, the bind '
    + 'requires config/read to report it, an approvalPolicy other than "never" is invalid-input, unsent, and an absent '
    + 'one is sent as "never" since a resumed thread keeps its persisted policy. Native rejects the escalation without '
    + 'asking the host or any approvalsReviewer, which is therefore accepted unchanged.'),
  'config-overrides': supported('passthrough-unqualified', { 'thread/start': ['config'], 'thread/resume': ['config'] },
    'Native config overrides, including MCP servers and features, pass through unchanged in direct mode. A proxy route '
    + 'and a host route refuse config and modelProvider as invalid-input, unsent, on thread/start, thread/resume and '
    + 'turn/start (execution.ts). A host route does not pin model, sandbox or approvals.'),
  'plugins-and-capability-roots': supported('passthrough-unqualified',
    { 'thread/start': ['selectedCapabilityRoots'], 'turn/start': ['disabledPluginIds'] },
    'Passed through unchanged; nothing is disabled by the adapter.'),
  'environments': supported('passthrough-unqualified', everyTarget(['environments', 'runtimeWorkspaceRoots'],
    ['runtimeWorkspaceRoots']), 'Passed through unchanged.'),
  'opaque-events': supported('passthrough-unqualified', { notifications: ['native'] },
    'Undecoded notifications are kept as native events labeled unqualified.'),
} as const);

const typedKeys: Record<CodexFeatureTarget, readonly string[]> = {
  'thread/start': ['model', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions', 'dynamicTools'],
  'thread/resume': ['model', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions'],
  'turn/start': ['model', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'effort'],
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** A checker returns the problem, naming the path, or undefined. */
type Check = (value: unknown, path: string) => string | undefined;
const must = (ok: boolean, path: string, what: string) => (ok ? undefined : `${path} must be ${what}`);
const boolean: Check = (value, path) => must(typeof value === 'boolean', path, 'a boolean');
const text: Check = (value, path) => must(nonEmpty(value), path, 'a non-empty string');
const absolute: Check = (value, path) => must(nonEmpty(value) && isAbsolute(value), path, 'an absolute path');
const oneOf = (allowed: readonly string[]): Check => (value, path) =>
  must(typeof value === 'string' && allowed.includes(value), path, `one of ${allowed.join(', ')}`);
const list = (each: Check): Check => (value, path) => (Array.isArray(value)
  ? value.map((item, index) => each(item, `${path}[${index}]`)).find(Boolean) : `${path} must be an array`);
/** Unknown keys are refused; an absent (or undefined) optional field is not checked. */
function fields(value: unknown, path: string, spec: Readonly<Record<string, readonly [required: boolean, check: Check]>>) {
  if (!record(value)) return `${path} must be an object`;
  const unknown = Object.keys(value).find((key) => !Object.hasOwn(spec, key));
  if (unknown !== undefined) return `${path}.${unknown} is not a native field`;
  for (const [key, [required, check]] of Object.entries(spec)) {
    if (value[key] === undefined) {
      if (required) return `${path}.${key} is required`;
    } else {
      const problem = check(value[key], `${path}.${key}`);
      if (problem) return problem;
    }
  }
  return undefined;
}
const approvals = ['untrusted', 'on-request', 'never'];
const approvalPolicy: Check = (value, path) => {
  if (typeof value === 'string' || !record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'granular')) {
    return must(typeof value === 'string' && approvals.includes(value), path, `one of ${approvals.join(', ')} or { granular }`);
  }
  return fields(value.granular, `${path}.granular`, { sandbox_approval: [true, boolean], rules: [true, boolean],
    skill_approval: [false, boolean], request_permissions: [false, boolean], mcp_elicitations: [true, boolean] });
};
const policies: Readonly<Record<string, Readonly<Record<string, readonly [boolean, Check]>>>> = {
  dangerFullAccess: {},
  readOnly: { networkAccess: [false, boolean] },
  externalSandbox: { networkAccess: [false, oneOf(['restricted', 'enabled'])] },
  workspaceWrite: { writableRoots: [false, list(absolute)], networkAccess: [false, boolean],
    excludeTmpdirEnvVar: [false, boolean], excludeSlashTmp: [false, boolean] },
};
const sandboxPolicy: Check = (value, path) => {
  const type = record(value) ? value.type : undefined;
  if (typeof type !== 'string' || !Object.hasOwn(policies, type)) return `${path}.type must be one of ${Object.keys(policies).join(', ')}`;
  return fields(value, `${path}.${type}`, { type: [true, () => undefined], ...policies[type] });
};
const checks: Record<string, Check> = {
  model: text, permissions: text, effort: text, cwd: absolute, approvalPolicy, sandboxPolicy,
  approvalsReviewer: oneOf(['user', 'auto_review', 'guardian_subagent']),
  sandbox: oneOf(['read-only', 'workspace-write', 'danger-full-access']),
  dynamicTools: (value, path) => (Array.isArray(value) ? dynamicToolsProblem(value) : `${path} must be an array`),
};

/**
 * Rules from the 0.169.0 binary's own dynamic-tool error strings (not in the generated types), checked before sending
 * so a host sees which tool is wrong. Only typed `features.dynamicTools` is checked: raw dynamicTools, including the
 * legacy form without `type`, pass unchanged to the native side.
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
    if (spec.deferLoading !== undefined && typeof spec.deferLoading !== 'boolean') return `${where} "${spec.name}" deferLoading must be boolean`;
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
 * field equal to its raw key is accepted, a different one is a visible conflict. `experimentalApi` is whether the
 * connection's `initialize.capabilities.experimentalApi` was `true`, read once when it opened. Pure: it never sends,
 * defaults or removes anything.
 */
export function resolveCodexFeatures(target: CodexFeatureTarget, features: unknown, params: Readonly<Record<string, unknown>>,
  experimentalApi: boolean): Outcome<Record<string, unknown>, CodexFeatureError> {
  // Without `features` the raw params are untouched passthrough, exactly as before this module existed.
  if (features === undefined) return { kind: 'ok', value: { ...params } };
  if (!record(features)) return invalid(`${target} features must be an object`);
  const merged: Record<string, unknown> = { ...params };
  try {
    for (const [key, value] of Object.entries(features)) {
      if (value === undefined) continue;
      if (!typedKeys[target].includes(key)) return invalid(`${target} has no typed feature "${key}"`);
      const problem = value === null ? undefined : checks[key]!(value, key);
      if (problem) return invalid(`${target} feature ${problem}`);
      // A null on either side is natively "unset", so only two different set values compete.
      if (params[key] != null && !isDeepStrictEqual(params[key], value)) {
        return invalid(`${target} feature "${key}" conflicts with raw params.${key}; remove it from raw params or make the values equal`);
      }
      if (value === null) continue;
      // A copy, so a host mutating its object after validation cannot change what is sent.
      try { merged[key] = structuredClone(value); } catch { return invalid(`${target} feature ${key} is not cloneable`); }
    }
  } catch { return invalid(`${target} features could not be read`); }
  const sandboxKey = target === 'turn/start' ? 'sandboxPolicy' : 'sandbox';
  if (merged[sandboxKey] != null && merged.permissions != null) {
    return invalid(`${target} cannot combine "${sandboxKey}" with "permissions"`);
  }
  // Experimental-only fields of the merged request: 0.169.0 refuses each without the capability (codex-native-api.md).
  const gated = [merged.permissions != null ? 'permissions' : '', record(merged.approvalPolicy) ? 'approvalPolicy.granular' : '',
    target === 'thread/start' && merged.dynamicTools != null ? 'dynamicTools' : ''].filter(Boolean);
  if (gated.length > 0 && !experimentalApi) {
    return invalid(`${target} ${gated.join(', ')} requires initialize capabilities.experimentalApi === true`);
  }
  return { kind: 'ok', value: merged };
}
