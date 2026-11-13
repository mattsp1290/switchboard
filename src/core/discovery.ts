import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type Dir, type Dirent, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Outcome } from './contracts.js';
import { sessionLimits, validateSessionDiscoveryBounds, type SessionBinding, type SessionDiscoveryBounds } from './sessions.js';

export interface FileDiscoveryScope {
  readonly binding: SessionBinding;
  readonly root: string;
  readonly namespace: 'host-stable';
}
export interface FileDiscoveryBounds extends SessionDiscoveryBounds {
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}
export type FileDecode<T> = { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'skip' } | { readonly kind: 'corrupt' };
type Terminal = { readonly kind: 'complete' } | { readonly kind: 'cancelled' }
  | { readonly kind: 'truncated'; readonly reason: 'results' | 'examined' | 'duration' | 'depth' | 'bytes' };
export type FileDiscoveryPage<T> = Terminal & {
  readonly values: readonly T[];
  readonly examined: number;
  readonly bytesRead: number;
  readonly skipped: Readonly<Record<'corrupt' | 'inaccessible' | 'absent' | 'rejected' | 'oversized', number>>;
};
export interface FileDiscoveryError {
  readonly code: 'invalid-input' | 'binding-mismatch' | 'inaccessible-root' | 'callback-failure' | 'io-failure';
}
export const fileDiscoveryLimits = Object.freeze({
  ...sessionLimits, maxDepth: 64, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
});
const bindingFields = ['engine', 'nativeVersion', 'account', 'authorizedScope', 'nativeFormat'] as const;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validBinding(value: unknown): value is SessionBinding {
  return record(value) && bindingFields.every((key) => {
    const text = value[key];
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > sessionLimits.identifierLength) return false;
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) return false;
    }
    return true;
  });
}
function copyBinding(value: unknown): SessionBinding | undefined {
  if (!record(value)) return undefined;
  const binding = { engine: value.engine, nativeVersion: value.nativeVersion, account: value.account,
    authorizedScope: value.authorizedScope, nativeFormat: value.nativeFormat };
  return validBinding(binding) ? binding : undefined;
}
function integer(value: unknown, minimum: number, ceiling: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= ceiling;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function ioCode(error: unknown): string | undefined {
  return record(error) && typeof error.code === 'string' ? error.code : undefined;
}
class Failure extends Error {
  constructor(readonly code: FileDiscoveryError['code']) { super(code); }
}

/** The host authorizes the root and guarantees stable ancestors and mount topology for the entire call. */
export async function discoverFiles<T>(options: {
  readonly scope: FileDiscoveryScope;
  readonly expected: SessionBinding;
  readonly bounds: FileDiscoveryBounds;
  readonly signal: AbortSignal;
  readonly selectFile: (relativeName: string) => boolean;
  readonly decode: (input: { readonly relativeName: string; readonly bytes: Uint8Array }) => FileDecode<T>;
}): Promise<Outcome<FileDiscoveryPage<T>, FileDiscoveryError>> {
  const fail = (code: FileDiscoveryError['code']): Outcome<never, FileDiscoveryError> => ({ kind: 'error', error: { code } });
  let captured: typeof options;
  try {
    if (!record(options)) return fail('invalid-input');
    const { scope, expected: rawExpected, bounds: rawBounds, signal, selectFile, decode } = options;
    if (!record(scope) || !record(rawBounds)) return fail('invalid-input');
    const { root, namespace, binding: rawBinding } = scope;
    const binding = copyBinding(rawBinding);
    const expected = copyBinding(rawExpected);
    const bounds = { maxResults: rawBounds.maxResults, maxExamined: rawBounds.maxExamined,
      maxDurationMs: rawBounds.maxDurationMs, maxDepth: rawBounds.maxDepth,
      maxFileBytes: rawBounds.maxFileBytes, maxTotalBytes: rawBounds.maxTotalBytes };
    if (!binding || !expected || namespace !== 'host-stable' || typeof root !== 'string' || !isAbsolute(root)
      || root.includes('\0') || root.split(sep).some((part) => part === '..' || part === '.')
      || validateSessionDiscoveryBounds(bounds).kind === 'error'
      || !integer(bounds.maxDepth, 0, fileDiscoveryLimits.maxDepth)
      || !integer(bounds.maxFileBytes, 1, fileDiscoveryLimits.maxFileBytes)
      || !integer(bounds.maxTotalBytes, 1, fileDiscoveryLimits.maxTotalBytes)
      || !(signal instanceof AbortSignal) || typeof selectFile !== 'function' || typeof decode !== 'function') {
      return fail('invalid-input');
    }
    if (!bindingFields.every((key) => binding[key] === expected[key])) return fail('binding-mismatch');
    captured = { scope: { root, namespace, binding }, expected, bounds, signal, selectFile, decode };
  } catch { return fail('invalid-input'); }
  const { scope: { root: rootInput }, bounds, signal, selectFile, decode } = captured;
  const started = performance.now();
  const halt = Symbol('discovery-stop');
  let terminal: Terminal = { kind: 'complete' };
  let depthLimited = false;
  const values: T[] = [];
  let examined = 0;
  let bytesRead = 0;
  const skipped = { corrupt: 0, inaccessible: 0, absent: 0, rejected: 0, oversized: 0 };
  const stack: { path: string; depth: number; dir: Dir; identity: BigIntStats }[] = [];
  function stop(next: Terminal): never { terminal = next; throw halt; }
  function check(): void {
    if (signal.aborted) stop({ kind: 'cancelled' });
    if (performance.now() - started >= bounds.maxDurationMs) stop({ kind: 'truncated', reason: 'duration' });
  }
  async function checked<R>(operation: () => Promise<R>): Promise<R> {
    check();
    try { return await operation(); } finally { check(); }
  }
  function callback<R>(operation: () => R): R {
    check();
    let value: R;
    try { value = operation(); } catch { throw new Failure('callback-failure'); }
    check();
    return value;
  }
  function skipError(error: unknown): void {
    if (error === halt || error instanceof Failure) throw error;
    check();
    switch (ioCode(error)) {
      case 'ENOENT': skipped.absent += 1; break;
      case 'EACCES': case 'EPERM': skipped.inaccessible += 1; break;
      case 'ELOOP': case 'ENOTDIR': skipped.rejected += 1; break;
      default: throw new Failure('io-failure');
    }
  }
  async function directory(path: string, depth: number, identity: BigIntStats): Promise<void> {
    check();
    const dir = await fs.opendir(path, { bufferSize: 1 });
    stack.push({ path, depth, dir, identity });
    check();
  }
  async function readFile(path: string, relativeName: string, before: BigIntStats): Promise<void> {
    if (before.size > bounds.maxFileBytes) { skipped.oversized += 1; return; }
    let file: FileHandle | undefined;
    try {
      check();
      file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      check();
      const handle = file;
      const opened = await checked(() => handle.stat({ bigint: true }));
      if (!opened.isFile() || !sameFile(before, opened)) { skipped.rejected += 1; return; }
      const buffer = Buffer.alloc(Math.min(bounds.maxFileBytes + 1, bounds.maxTotalBytes - bytesRead));
      let size = 0;
      while (true) {
        check();
        if (bytesRead === bounds.maxTotalBytes) stop({ kind: 'truncated', reason: 'bytes' });
        const length = Math.min(65536, buffer.length - size, bounds.maxTotalBytes - bytesRead);
        const read = await file.read(buffer, size, length, size);
        size += read.bytesRead;
        bytesRead += read.bytesRead;
        check();
        if (size > bounds.maxFileBytes) { skipped.oversized += 1; return; }
        if (read.bytesRead === 0) break;
      }
      const decoded = callback((): FileDecode<T> => {
        const value = decode({ relativeName, bytes: buffer.subarray(0, size) });
        if (!record(value)) throw new Failure('callback-failure');
        const kind = value.kind;
        switch (kind) {
          case 'found': return { kind, value: value.value };
          case 'skip': case 'corrupt': return { kind };
          default: throw new Failure('callback-failure');
        }
      });
      if (decoded.kind === 'found') values.push(decoded.value);
      if (decoded.kind === 'corrupt') skipped.corrupt += 1;
    } finally {
      if (file) await file.close();
    }
    check();
  }
  let failure: FileDiscoveryError['code'] | undefined;
  try {
    let root: string;
    try {
      root = await checked(() => fs.realpath(rootInput));
      const identity = await checked(() => fs.lstat(root, { bigint: true }));
      if (!identity.isDirectory()) throw new Failure('inaccessible-root');
      await directory(root, 0, identity);
    } catch (error) {
      if (error === halt || error instanceof Failure) throw error;
      check();
      if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(ioCode(error) ?? '')) {
        throw new Failure('inaccessible-root');
      }
      throw error;
    }
    while (stack.length > 0) {
      check();
      if (values.length >= bounds.maxResults) stop({ kind: 'truncated', reason: 'results' });
      if (examined >= bounds.maxExamined) stop({ kind: 'truncated', reason: 'examined' });
      if (bytesRead >= bounds.maxTotalBytes) stop({ kind: 'truncated', reason: 'bytes' });
      const frame = stack.at(-1);
      if (!frame) break;
      let entry: Dirent | null;
      try {
        const current = await checked(() => fs.lstat(frame.path, { bigint: true }));
        if (!current.isDirectory() || !sameFile(current, frame.identity)) {
          skipped.rejected += 1;
          entry = null;
        } else {
          check();
          entry = await frame.dir.read();
          if (entry) examined += 1;
          check();
        }
      } catch (error) { skipError(error); entry = null; }
      if (!entry) {
        stack.pop();
        await frame.dir.close();
        check();
        continue;
      }
      const path = join(frame.path, entry.name);
      const name = relative(root, path);
      if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) { skipped.rejected += 1; continue; }
      try {
        const before = await checked(() => fs.lstat(path, { bigint: true }));
        if (before.isDirectory()) {
          if (frame.depth >= bounds.maxDepth) { depthLimited = true; continue; }
          await directory(path, frame.depth + 1, before);
        } else if (before.isFile()) {
          const selected = callback(() => selectFile(name));
          if (typeof selected !== 'boolean') throw new Failure('callback-failure');
          if (selected) await readFile(path, name, before);
        } else { skipped.rejected += 1; }
      } catch (error) { skipError(error); }
    }
    check();
    if (depthLimited) terminal = { kind: 'truncated', reason: 'depth' };
  } catch (error) {
    if (error !== halt) failure = error instanceof Failure ? error.code : 'io-failure';
  } finally {
    for (const frame of stack.reverse()) {
      try { await frame.dir.close(); } catch { failure = 'io-failure'; }
    }
  }
  if (failure) return fail(failure);
  return { kind: 'ok', value: Object.freeze({ ...terminal, values: Object.freeze(values), examined, bytesRead, skipped: Object.freeze(skipped) }) };
}
