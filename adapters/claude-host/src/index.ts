import { discoverClaudeHostSessions } from './sessions.js';

/** SDK pin this project compiles against. The declaration names no SDK package. */
export const claudeHostSdkVersion = '0.3.323';
export { discoverClaudeHostSessions };
export type { ClaudeListedSession, ClaudeSessionRead } from './sessions.js';

export async function discoverClaudeHostDirectory(input: Omit<Parameters<typeof discoverClaudeHostSessions>[0], 'read'>) {
  const sdk = await import('./sdk.js');
  return discoverClaudeHostSessions({ ...input, read: sdk.readClaudeHostSessions });
}
