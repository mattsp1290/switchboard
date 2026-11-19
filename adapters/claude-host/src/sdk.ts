import { listSessions, query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeListedSession, ClaudeSessionRead } from './sessions.js';

/** Loads the SDK inside this project. The boolean return keeps that package out of the emitted declaration. */
export function claudeHostSdkLoaded(): boolean {
  return typeof query === 'function';
}

/** Reads one directory. Worktree sessions stay out. The declared result names no SDK type. */
export async function readClaudeHostSessions(dir: string, limit: number, signal: AbortSignal): Promise<ClaudeSessionRead> {
  if (signal.aborted) return { kind: 'error', code: 'native-failure' };
  try {
    const listed = await listSessions({ dir, includeWorktrees: false, limit });
    const sessions: ClaudeListedSession[] = [];
    for (const item of listed) sessions.push({ sessionId: item.sessionId, summary: item.summary, lastModified: item.lastModified });
    return { kind: 'ok', sessions };
  } catch {
    return { kind: 'error', code: 'native-failure' };
  }
}
