// In-child preload and node:test reporter for one guarded run. The same URL is passed to --import and
// --test-reporter, so both roles share this module instance and its private refusal counter.
import { writeSync } from 'node:fs';
import { createRequire, isBuiltin, registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { REPO, runSpec } from './plan.mjs';

// Captured before any guest code runs; fs itself is never patched because the ESM loader reads sources through it.
const write = writeSync;
const installHooks = registerHooks;
const params = new URL(import.meta.url).searchParams;
const nonce = params.get('nonce');
const spec = runSpec(params.get('run') ?? '');
const self = fileURLToPath(import.meta.url);
const MARK = Symbol.for('switchboard.codex-guard.refuser');
let refusals = 0;

/** Write one channel record. A lost write is caught by the launcher's exit-refusal-count check. */
function emit(record) {
  try { write(3, `${JSON.stringify({ n: nonce, ...record })}\n`); } catch { /* reported through the exit counter */ }
}

/** Count, record, then throw. The record is written before the throw, so a guest catch can't hide it. */
function refuse(what, detail) {
  refusals += 1;
  const label = `${what} ${String(detail).slice(0, 300)}`;
  emit({ k: 'refusal', label });
  throw Object.assign(new Error(`codex guard refused ${label}`), { code: 'ERR_SWITCHBOARD_CODEX_GUARD' });
}

/** @type {Map<string, { read: () => unknown, value: unknown }>} label -> independent re-read path */
const installed = new Map();
function install(label, target, key, value, read) {
  target[key] = value;
  installed.set(label, { read, value });
}
function patch(label, target, key, read) {
  const refuser = function refused() { refuse('call', label); };
  Object.defineProperty(refuser, MARK, { value: true });
  install(label, target, key, refuser, read);
}

// Lazily created stdio streams construct net sockets, so create them before net is patched.
void process.stdout;
void process.stderr;
const require = createRequire(import.meta.url);
const builtin = (name) => process.getBuiltinModule(name);
const DENIED = {
  child_process: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
  net: ['connect', 'createConnection', 'createServer'],
  tls: ['connect', 'createServer'],
  http: ['request', 'get', 'createServer'],
  https: ['request', 'get', 'createServer'],
  http2: ['connect', 'createServer', 'createSecureServer'],
  dgram: ['createSocket'],
  dns: ['lookup', 'lookupService', 'resolve'],
  worker_threads: ['Worker'],
  cluster: ['fork'],
  inspector: ['open'],
  module: ['register'],
};
for (const [name, keys] of Object.entries(DENIED)) {
  for (const key of keys) patch(`${name}.${key}`, require(`node:${name}`), key, () => builtin(name)[key]);
}
const PROTOTYPES = [['child_process', 'ChildProcess', 'spawn'], ['net', 'Socket', 'connect'], ['net', 'Server', 'listen'],
  ['dgram', 'Socket', 'bind'], ['dgram', 'Socket', 'send']];
for (const [name, type, key] of PROTOTYPES) {
  patch(`${name}.${type}#${key}`, require(`node:${name}`)[type].prototype, key, () => builtin(name)[type].prototype[key]);
}
for (const key of ['dlopen', 'binding', '_linkedBinding', 'execve']) {
  if (key in process) patch(`process.${key}`, process, key, () => Reflect.get(globalThis.process, key));
}
for (const key of ['fetch', 'WebSocket', 'EventSource']) {
  patch(`globalThis.${key}`, globalThis, key, () => Object.getOwnPropertyDescriptor(globalThis, key)?.value);
}
// A guest load hook would run before ours and could short-circuit past final load admission.
install('module.registerHooks', require('node:module'), 'registerHooks', function guardedRegisterHooks(hooks) {
  if (hooks?.load) refuse('hooks', 'load');
  return installHooks(hooks);
}, () => builtin('module').registerHooks);
syncBuiltinESMExports();

// Identity only: a canary never invokes the slot it checks.
const failed = [...installed].filter(([, slot]) => slot.read() !== slot.value).map(([label]) => label);
if (failed.length) {
  emit({ k: 'canary-failed', labels: failed });
  throw new Error(`codex guard canary failed: ${failed.join(', ')}`);
}

const allowed = new Set([...spec.files, self]);
const relative = (path) => path.startsWith(`${REPO}/`) ? path.slice(REPO.length + 1) : path;
const stripQuery = (url) => url.replace(/[?#].*$/, '');

/** Admit a final URL or refuse. Query re-imports pass because only the path is compared. */
function admit(url) {
  if (url.startsWith('node:')) {
    if (!spec.builtins.includes(url)) refuse('builtin', url);
    return;
  }
  if (!url.startsWith('file:')) refuse('scheme', url.slice(0, 100));
  const path = fileURLToPath(stripQuery(url));
  if (!allowed.has(path)) refuse('file', relative(path));
}

const bare = (specifier) => !/^(\.{0,2}\/|file:|node:|data:)/.test(specifier) && !isBuiltin(specifier);
const loaded = new Set();
installHooks({
  resolve(specifier, context, next) {
    if (bare(specifier)) refuse('bare', specifier);
    const result = next(specifier, context);
    admit(result.url);
    return result;
  },
  load(url, context, next) {
    admit(url);
    const file = stripQuery(url);
    if (file.startsWith('file:') && !loaded.has(file)) {
      loaded.add(file);
      emit({ k: 'load', file: fileURLToPath(file) });
    }
    return next(url, context);
  },
});
emit({ k: 'armed', run: spec.name, pid: process.pid, node: process.version });
process.on('exit', (code) => emit({ k: 'exit', code, refusals }));

const PHASES = { 'test:start': 'start', 'test:pass': 'pass', 'test:fail': 'fail' };
const flag = (value) => value !== undefined && value !== false;

/**
 * node:test reporter. Forwards only start/pass/fail/summary with bounded text and yields nothing,
 * so guest stdout carries no acceptance evidence.
 * @param {AsyncIterable<{ type: string, data: any }>} source
 */
// node:test needs a generator here; it yields nothing on purpose.
// oxlint-disable-next-line require-yield
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type === 'test:summary') emit({ k: 'summary', counts: data.counts });
    if (!Object.hasOwn(PHASES, type)) continue;
    emit({ k: 'test', phase: PHASES[type], name: String(data.name).slice(0, 500), nesting: data.nesting,
      file: data.file ?? '', skip: flag(data.skip), todo: flag(data.todo),
      error: String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? '').slice(0, 500) });
  }
}
