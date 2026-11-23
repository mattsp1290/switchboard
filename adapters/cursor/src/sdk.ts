import * as native from '@cursor/sdk';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CursorTextPolicyUnsupportedError, cursorLocalOptions, type CursorRuntimeOptions } from './config.js';

type CreateOptions = Parameters<typeof native.Agent.create>[0];
type ResumeOptions = NonNullable<Parameters<typeof native.Agent.resume>[1]>;
type Local = NonNullable<CreateOptions['local']>;
type NativeAgent = Awaited<ReturnType<typeof native.Agent.create>>;
type NativeRun = Awaited<ReturnType<NativeAgent['send']>>;
export type CursorMessage = Parameters<NativeAgent['send']>[0];
type Handle = Pick<NativeAgent, 'agentId' | typeof Symbol.asyncDispose> & {
  send(message: CursorMessage): Promise<Pick<NativeRun, 'supports' | 'stream' | 'wait' | 'cancel'>>;
};
type Bindings = {
  create: (options: CreateOptions) => Promise<Handle>;
  resume: (agentId: string, options: ResumeOptions) => Promise<Handle>;
  Store: typeof native.JsonlLocalAgentStore;
  emptyFs: typeof native.emptyFs;
  listModels: typeof native.Cursor.models.list;
};
const overrides: Partial<Bindings> = {};

/** Lazy access avoids dereferencing malformed optional peer exports during import. */
export const sdk = {
  get create(): Bindings['create'] {
    const method = native.Agent?.create;
    return 'create' in overrides ? overrides.create! : typeof method === 'function' ? method.bind(native.Agent) : method;
  },
  set create(value: Bindings['create']) { overrides.create = value; },
  get resume(): Bindings['resume'] {
    const method = native.Agent?.resume;
    return 'resume' in overrides ? overrides.resume! : typeof method === 'function' ? method.bind(native.Agent) : method;
  },
  set resume(value: Bindings['resume']) { overrides.resume = value; },
  get Store(): Bindings['Store'] { return 'Store' in overrides ? overrides.Store! : native.JsonlLocalAgentStore; },
  set Store(value: Bindings['Store']) { overrides.Store = value; },
  get emptyFs(): Bindings['emptyFs'] { return 'emptyFs' in overrides ? overrides.emptyFs! : native.emptyFs; },
  set emptyFs(value: Bindings['emptyFs']) { overrides.emptyFs = value; },
  get listModels(): Bindings['listModels'] {
    const method = native.Cursor?.models?.list;
    return 'listModels' in overrides ? overrides.listModels! : typeof method === 'function' ? method.bind(native.Cursor.models) : method;
  },
  set listModels(value: Bindings['listModels']) { overrides.listModels = value; },
  resolveEntry: (): string => import.meta.resolve('@cursor/sdk'),
  canonicalPath: (path: string): string => realpathSync(path),
  readManifest: (path: string): string => readFileSync(path, 'utf8'),
  nodeVersion: (): string => process.versions.node,
};

function unsupported(): never { throw new CursorTextPolicyUnsupportedError(); }

/** Bounded owning-manifest walk; named intervening packages cannot masquerade as the peer. */
function owningSdk(): Readonly<{ root: string; version: '1.4.2' }> {
  const entry = sdk.canonicalPath(fileURLToPath(sdk.resolveEntry()));
  let directory = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    let source: string;
    try { source = sdk.readManifest(join(directory, 'package.json')); }
    catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        directory = dirname(directory);
        continue;
      }
      return unsupported();
    }
    const data: unknown = JSON.parse(source);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return unsupported();
    if (!('name' in data)) { directory = dirname(directory); continue; }
    if (data.name !== '@cursor/sdk' || !('version' in data) || data.version !== '1.4.2') return unsupported();
    const root = sdk.canonicalPath(directory);
    const within = relative(root, entry);
    if (within === '' || within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) return unsupported();
    return Object.freeze({ root, version: '1.4.2' });
  }
  return unsupported();
}

export function assertCursorTextNode(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return unsupported();
  const parts = version.split('.').map(Number);
  const [major, minor, patch] = parts;
  if (!parts.every(Number.isSafeInteger) || major !== 24 || minor === undefined || patch === undefined
    || minor < 22 || (minor === 22 && patch < 3)) return unsupported();
}

type TextSupport = Readonly<Bindings & {
  identity: ReturnType<typeof owningSdk>;
  nodeVersion: () => string;
  contract: 'cursor-text-v1';
}>;
export type CursorPolicy = { readonly kind: 'generic' } | {
  readonly kind: 'text'; readonly support: TextSupport; readonly tree: ReturnType<typeof native.emptyFs>;
};

export function assertCursorTextSupport(): TextSupport {
  try {
    const nodeVersion = sdk.nodeVersion;
    assertCursorTextNode(nodeVersion());
    const identity = owningSdk();
    const bindings = { create: sdk.create, resume: sdk.resume, Store: sdk.Store, emptyFs: sdk.emptyFs, listModels: sdk.listModels };
    if (Object.values(bindings).some(value => typeof value !== 'function')) return unsupported();
    // Check constructability without invoking Store or a native constructor.
    Reflect.construct(Object, [], bindings.Store);
    return Object.freeze({ ...bindings, identity, nodeVersion, contract: 'cursor-text-v1' });
  } catch { return unsupported(); }
}

export function cursorTextPolicy(): CursorPolicy {
  const support = assertCursorTextSupport();
  try {
    const tree = support.emptyFs();
    if (tree === null || typeof tree !== 'object' || ['read', 'list', 'write', 'delete'].some(key => typeof Reflect.get(tree, key) !== 'function')) return unsupported();
    return Object.freeze({ kind: 'text', support, tree });
  } catch { return unsupported(); }
}

// Pick requires each control name to exist in the actual locked SDK declarations.
type TextLocal = Required<Pick<Local, 'cwd' | 'store' | 'settingSources' | 'sandboxOptions' | 'enableAgentRetries'
  | 'fs' | 'reportedWorkspacePath' | 'customTools' | 'hostMcpBridgeUrls' | 'dirs' | 'autoReview'>>;
type TextLaunch = Required<Pick<CreateOptions, 'apiKey' | 'model' | 'tools' | 'mcpServers' | 'agents'>> & { local: TextLocal };

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function emptyArray(value: unknown): boolean { return Array.isArray(value) && Reflect.ownKeys(value).length === 1 && value.length === 0; }
function emptyMap(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === 0;
}

export function assertCursorTextLaunch(value: unknown, options: CursorRuntimeOptions,
  tree: ReturnType<typeof native.emptyFs>, store: InstanceType<typeof native.JsonlLocalAgentStore>): void {
  try {
    if (!exactKeys(value, ['apiKey', 'model', 'tools', 'mcpServers', 'agents', 'local']) || value.apiKey !== options.apiKey
      || !exactKeys(value.model, ['id']) || value.model.id !== options.model || !emptyArray(value.tools)
      || !emptyMap(value.mcpServers) || !emptyMap(value.agents)) return unsupported();
    const local = value.local;
    if (!exactKeys(local, ['cwd', 'store', 'settingSources', 'sandboxOptions', 'enableAgentRetries', 'fs',
      'reportedWorkspacePath', 'customTools', 'hostMcpBridgeUrls', 'dirs', 'autoReview'])
      || local.cwd !== options.cwd || local.store !== store || local.fs !== tree || local.reportedWorkspacePath !== '/'
      || !emptyArray(local.settingSources) || !emptyArray(local.hostMcpBridgeUrls) || !emptyArray(local.dirs)
      || !emptyMap(local.customTools) || local.enableAgentRetries !== false || local.autoReview !== false
      || !exactKeys(local.sandboxOptions, ['enabled']) || local.sandboxOptions.enabled !== false) return unsupported();
  } catch { return unsupported(); }
}

export function buildCursorLaunchOptions(options: CursorRuntimeOptions, policy: CursorPolicy): CreateOptions & ResumeOptions {
  if (policy.kind === 'generic') {
    const local = cursorLocalOptions(options.cwd, options.sessionDirectory);
    return { apiKey: options.apiKey, model: { id: options.model }, local: {
      cwd: local.cwd, settingSources: local.settingSources, sandboxOptions: local.sandboxOptions,
      enableAgentRetries: local.enableAgentRetries, store: new sdk.Store(local.storeDirectory),
    } };
  }
  const { support, tree } = policy;
  try {
    assertCursorTextNode(support.nodeVersion());
    if (support.contract !== 'cursor-text-v1' || support.identity.version !== '1.4.2'
      || !Object.isFrozen(support) || Object.values({ create: support.create, resume: support.resume,
        Store: support.Store, emptyFs: support.emptyFs, listModels: support.listModels }).some(value => typeof value !== 'function')) return unsupported();
    const store = new support.Store(options.sessionDirectory);
    const launch: TextLaunch = { apiKey: options.apiKey, model: { id: options.model }, tools: [], mcpServers: {}, agents: {}, local: {
      cwd: options.cwd, store, settingSources: [], sandboxOptions: { enabled: false }, enableAgentRetries: false,
      fs: tree, reportedWorkspacePath: '/', customTools: {}, hostMcpBridgeUrls: [], dirs: [], autoReview: false,
    } };
    assertCursorTextLaunch(launch, options, tree, store);
    return launch;
  } catch { return unsupported(); }
}
