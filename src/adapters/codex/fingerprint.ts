import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { CheckpointReference, SessionReference } from '../../core/sessions.js';

/** A3 tuple: rollout byte size, SHA-256, and the newest `task_complete` turn id. Valid at segment end. */
export interface CodexHistoryFingerprint {
  readonly bytes: number;
  readonly sha256: string;
  readonly turnId: string;
}
const limitBytes = 8 * 1024 * 1024;

function inside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

async function rollouts(root: string, dir: string, suffix: string, found: string[], depth: number): Promise<void> {
  if (depth > 6 || found.length > 1) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (found.length > 1) return;
    const path = join(dir, entry.name);
    let stat;
    try { stat = await lstat(path); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    const real = resolve(path);
    if (!inside(real, root)) continue;
    if (stat.isDirectory()) await rollouts(root, path, suffix, found, depth + 1);
    else if (stat.isFile() && entry.name.endsWith(suffix) && stat.size <= limitBytes) found.push(path);
  }
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

async function readRollout(path: string): Promise<Buffer | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limitBytes) return undefined;
    return await file.readFile();
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

/** Reads the one rollout under `home/sessions` named for `threadId`. Missing, ambiguous, or oversized history is `undefined`. */
export async function readCodexHistoryFingerprint(home: string, threadId: string): Promise<CodexHistoryFingerprint | undefined> {
  if (threadId.length === 0 || threadId.includes('/') || threadId.includes('\\') || threadId.includes('\0')) {
    return undefined;
  }
  const root = resolve(home);
  const found: string[] = [];
  await rollouts(root, join(root, 'sessions'), `-${threadId}.jsonl`, found, 0);
  const path = found.length === 1 ? found[0] : undefined;
  if (path === undefined) return undefined;
  const bytes = await readRollout(path);
  if (!bytes) return undefined;
  let turnId: string | undefined;
  for (const line of bytes.toString('utf8').split('\n')) {
    const turn = taskTurn(line);
    if (turn) turnId = turn;
  }
  return turnId === undefined ? undefined : { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), turnId };
}

export function codexCheckpoint(session: SessionReference, fingerprint: CodexHistoryFingerprint): CheckpointReference {
  return Object.freeze({ kind: 'checkpoint', formatVersion: 1, binding: session.binding, sessionOpaque: session.opaque,
    opaque: JSON.stringify([1, fingerprint.bytes, fingerprint.sha256, fingerprint.turnId]) });
}
