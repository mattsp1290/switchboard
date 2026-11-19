import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeListedSession, ClaudeSessionRead } from './sessions.js';

/** Reads one directory. Worktree sessions stay out. The declared result names no SDK type. */
export async function readClaudeHostSessions(dir: string, limit: number, signal: AbortSignal): Promise<ClaudeSessionRead> {
  void signal;
  try {
    const listed = await listSessions({ dir, includeWorktrees: false, limit });
    const sessions: ClaudeListedSession[] = [];
    for (const item of listed) sessions.push({ sessionId: item.sessionId, summary: item.summary, lastModified: item.lastModified });
    return { kind: 'ok', sessions };
  } catch {
    return { kind: 'error', code: 'native-failure' };
  }
}
