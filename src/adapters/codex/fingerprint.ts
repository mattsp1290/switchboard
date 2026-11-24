import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { CheckpointReference, SessionReference } from '../../core/sessions.js';

/** A3 tuple: rollout byte size, SHA-256, and the newest `task_complete` turn id. Valid at segment end. */
export interface CodexHistoryFingerprint {
  readonly bytes: number;
  readonly sha256: string;
  readonly turnId: string;
}
const limitBytes = 256 * 1024 * 1024;
const lineLimitBytes = 8 * 1024 * 1024;

function inside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

type Rollout = Readonly<Pick<BigIntStats, 'dev' | 'ino'> & { path: string }>;

async function rollouts(root: string, dir: string, suffix: string, found: Rollout[], depth: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || depth > 6 || found.length > 1) return false;
  try {
    const stat = await lstat(dir, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(await realpath(dir), root)) return false;
  } catch { return false; }
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (signal?.aborted || found.length > 1) return false;
    const path = join(dir, entry.name);
    let stat;
    try { stat = await lstat(path, { bigint: true }); } catch { return false; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { if (!(await rollouts(root, path, suffix, found, depth + 1, signal))) return false; }
    else if (stat.isFile() && entry.name.endsWith(suffix)) found.push({ path, dev: stat.dev, ino: stat.ino });
  }
  return !signal?.aborted;
}

function taskTurn(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'event_msg') {
      return undefined;
    }
    const payload = 'payload' in value ? value.payload : undefined;
    if (typeof payload !== 'object' || payload === null) return undefined;
    const record = payload as { type?: unknown; turn_id?: unknown };
    return record.type === 'task_complete' && typeof record.turn_id === 'string' ? record.turn_id : undefined;
  } catch { return undefined; }
}

async function readRollout(candidate: Rollout, stable: boolean, signal?: AbortSignal): Promise<CodexHistoryFingerprint | undefined> {
  const { path } = candidate;
  let file;
  try {
    if (signal?.aborted || await realpath(path) !== path) return undefined;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.dev !== candidate.dev || stat.ino !== candidate.ino || (stat.size < 0n || stat.size > BigInt(limitBytes))) return undefined;
    const openingBytes = Number(stat.size);
    // Validate the opened descriptor against an authorized named inode before reading any bytes.
    if (signal?.aborted || await realpath(path) !== path) return undefined;
    const openedName = await lstat(path, { bigint: true });
    if (openedName.isSymbolicLink() || openedName.dev !== stat.dev || openedName.ino !== stat.ino) return undefined;
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let parts: Buffer[] = [];
    let lineBytes = 0;
    let turnId: string | undefined;
    const finishLine = () => {
      const turn = taskTurn(Buffer.concat(parts, lineBytes).toString('utf8'));
      if (turn) turnId = turn;
      parts = [];
      lineBytes = 0;
    };
    while (position < openingBytes) {
      if (signal?.aborted) return undefined;
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, openingBytes - position), position);
      if (bytesRead === 0) return undefined;
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      let start = 0;
      while (start < bytesRead) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytesRead : newline;
        lineBytes += end - start;
        if (lineBytes > lineLimitBytes) return undefined;
        parts.push(Buffer.from(bytes.subarray(start, end)));
        if (newline === -1) break;
        finishLine();
        start = end + 1;
      }
      position += bytesRead;
    }
    if (lineBytes > 0) finishLine();
    if (signal?.aborted || await realpath(path) !== path) return undefined;
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino
      || (stable && (after.size !== stat.size || named.size !== stat.size))
      || after.size < stat.size || named.size < stat.size
      || [after, named].some((sample) => sample.size === stat.size
        && (sample.mtimeNs !== stat.mtimeNs || sample.ctimeNs !== stat.ctimeNs))) return undefined;
    const digest = hash.digest('hex');
    if (!stable && (after.size > stat.size || named.size > stat.size)) {
      // Growth must not mask an in-place rewrite: verify the same opening-length bytes twice.
      const verification = createHash('sha256');
      let offset = 0;
      while (offset < openingBytes) {
        if (signal?.aborted) return undefined;
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, openingBytes - offset), offset);
        if (bytesRead === 0) return undefined;
        verification.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (verification.digest('hex') !== digest || await realpath(path) !== path) return undefined;
      const verified = await file.stat({ bigint: true }); const current = await lstat(path, { bigint: true });
      if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino
        || verified.size !== named.size || current.size !== named.size
        || [[verified, named], [current, named]].some(([final, before]) => final !== undefined && before !== undefined
          && (final.mtimeNs !== before.mtimeNs || final.ctimeNs !== before.ctimeNs))) return undefined;
    }
    return signal?.aborted || turnId === undefined ? undefined : { bytes: openingBytes, sha256: digest, turnId };
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

/** Reads the one rollout under `home/sessions` named for `threadId`. Missing, ambiguous, symlinked, oversized, replaced, mutated or short-read history is `undefined`.
 * `prefix` assumes append-only native writes (the host excludes concurrent rewrites) and tolerates initial append growth, then requires a stable verification pass; `stable` refuses growth during the read, for expected-history resume. */
export async function readCodexHistoryFingerprint(home: string, threadId: string, mode: 'prefix' | 'stable' = 'prefix', signal?: AbortSignal): Promise<CodexHistoryFingerprint | undefined> {
  if (signal?.aborted || threadId.length === 0 || threadId.includes('/') || threadId.includes('\\') || threadId.includes('\0')) {
    return undefined;
  }
  let root: string;
  try { root = await realpath(resolve(home)); } catch { return undefined; }
  const found: Rollout[] = [];
  if (!(await rollouts(root, join(root, 'sessions'), `-${threadId}.jsonl`, found, 0, signal))) return undefined;
  const path = found.length === 1 ? found[0] : undefined;
  if (path === undefined) return undefined;
  return readRollout(path, mode === 'stable', signal);
}

export function codexCheckpoint(session: SessionReference, fingerprint: CodexHistoryFingerprint): CheckpointReference {
  return Object.freeze({ kind: 'checkpoint', formatVersion: 1, binding: session.binding, sessionOpaque: session.opaque,
    opaque: JSON.stringify([1, fingerprint.bytes, fingerprint.sha256, fingerprint.turnId]) });
}
