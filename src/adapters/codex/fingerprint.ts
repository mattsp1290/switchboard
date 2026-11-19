import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { CheckpointReference, SessionReference } from '../../core/sessions.js';

/** A3 tuple: rollout byte size, SHA-256, and the newest `task_complete` turn id. Valid at segment end. */
export interface CodexHistoryFingerprint {
  readonly bytes: number;
  readonly sha256: string;
  readonly turnId: string;
}
const limitBytes = 8 * 1024 * 1024;
const maxFiles = 200;

function inside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

async function rollouts(root: string, dir: string, found: string[], depth: number): Promise<void> {
  if (depth > 6 || found.length >= maxFiles) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (found.length >= maxFiles) return;
    const path = join(dir, entry.name);
    let stat;
    try { stat = await lstat(path); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    const real = resolve(path);
    if (!inside(real, root)) continue;
    if (stat.isDirectory()) await rollouts(root, path, found, depth + 1);
    else if (stat.isFile() && entry.name.endsWith('.jsonl') && stat.size <= limitBytes) found.push(path);
  }
}

function taskTurn(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value !== 'object' || value === null) return undefined;
    const payload = 'payload' in value ? value.payload : undefined;
    if (typeof payload !== 'object' || payload === null) return undefined;
    const record = payload as { type?: unknown; turn_id?: unknown };
    return record.type === 'task_complete' && typeof record.turn_id === 'string' ? record.turn_id : undefined;
  } catch { return undefined; }
}

/** Reads the rollout under `home/sessions` that contains `threadId`. Missing or oversized history is `undefined`. */
export async function readCodexHistoryFingerprint(home: string, threadId: string): Promise<CodexHistoryFingerprint | undefined> {
  const root = resolve(home);
  const found: string[] = [];
  await rollouts(root, join(root, 'sessions'), found, 0);
  for (const path of found) {
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch { continue; }
    if (bytes.length > limitBytes || !bytes.includes(threadId)) continue;
    let turnId: string | undefined;
    for (const line of bytes.toString('utf8').split('\n')) {
      const turn = taskTurn(line);
      if (turn) turnId = turn;
    }
    if (!turnId) continue;
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), turnId };
  }
  return undefined;
}

export function codexCheckpoint(session: SessionReference, fingerprint: CodexHistoryFingerprint): CheckpointReference {
  return Object.freeze({ kind: 'checkpoint', formatVersion: 1, binding: session.binding, sessionOpaque: session.opaque,
    opaque: JSON.stringify([1, fingerprint.bytes, fingerprint.sha256, fingerprint.turnId]) });
}
