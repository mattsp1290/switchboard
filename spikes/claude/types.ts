import type { CanUseTool, Options, Query, SDKMessage, SDKResultMessage,
  SessionMessage, SessionStoreEntry, Settings } from '@anthropic-ai/claude-agent-sdk';
import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';

export const permission: CanUseTool = async (_tool, _input, context) => {
  const request: string = context.requestId;
  const toolUse: string = context.toolUseID;
  return { behavior: 'deny', message: `Denied ${request}`, toolUseID: toolUse };
};
export const settings = { apiKeyHelper: '/host/resolve-proxy-credential' } satisfies Settings;
export const options = {
  resume: '11111111-1111-4111-8111-111111111111',
  resumeSessionAt: '22222222-2222-4222-8222-222222222222',
  resumeDropsTurn: '33333333-3333-4333-8333-333333333333',
  enableFileCheckpointing: true,
  canUseTool: permission,
  permissionMode: 'default',
  settings,
  settingSources: ['user', 'project', 'local'],
  plugins: [{ type: 'local', path: '/host/plugin' }],
  includePartialMessages: true,
  forwardSubagentText: true,
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '1000' },
} satisfies Options;
export const opaqueEntry = { type: 'future', nested: { preserved: true } } satisfies SessionStoreEntry;
export const sessionAPIs: {
  list: typeof listSessions;
  info: typeof getSessionInfo;
  messages: typeof getSessionMessages;
} = { list: listSessions, info: getSessionInfo, messages: getSessionMessages };
export type NativeCheckpoint = Pick<Options, 'resume' | 'resumeSessionAt' | 'resumeDropsTurn'>;
export type NativeEvidence = Pick<SDKResultMessage,
  'session_id' | 'uuid' | 'user_message_uuid' | 'user_message_uuids' | 'result_index'>;
export type NativeControl = Pick<Query, 'interrupt' | 'close' | 'reinitialize' | 'rewindFiles'
  | 'streamInput' | 'applyFlagSettings' | 'reloadPlugins' | 'setMcpServers'>;
export type NativePayload = SDKMessage | SessionMessage;
