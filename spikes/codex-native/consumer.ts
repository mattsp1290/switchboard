import type { ClientRequest } from './generated/ClientRequest.js';
import type { ServerRequest } from './generated/ServerRequest.js';
import type { ServerNotification } from './generated/ServerNotification.js';
import type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse.js';

export const requests = [
  { id: 1, method: 'initialize', params: { clientInfo: { name: 'fixture', title: null, version: '0' }, capabilities: null } },
  { id: 2, method: 'thread/list', params: { limit: 10 } },
  { id: 3, method: 'thread/resume', params: { threadId: 'native-owned-id' } },
  { id: 4, method: 'turn/start', params: { threadId: 'native-owned-id', input: [{ type: 'text', text: 'fixture', text_elements: [] }] } },
  { id: 5, method: 'turn/interrupt', params: { threadId: 'native-owned-id', turnId: 'native-turn-id' } },
  { id: 7, method: 'getConversationSummary', params: { rolloutPath: '/authorized/sessions/inventoried-file' } },
  { id: 8, method: 'account/read', params: { refreshToken: false } },
  { id: 9, method: 'thread/turns/list', params: { threadId: 'native-owned-id', limit: 1, sortDirection: 'asc', itemsView: 'summary' } },
  { id: 10, method: 'thread/items/list', params: { threadId: 'native-owned-id', limit: 1, sortDirection: 'asc' } },
  { id: 11, method: 'thread/read', params: { threadId: 'native-owned-id', includeTurns: false } },
  { id: 6, method: 'thread/read', params: { threadId: 'native-owned-id', includeTurns: true } },
] satisfies ClientRequest[];
export const decline = { decision: 'decline' } satisfies CommandExecutionRequestApprovalResponse;
export function notificationMethod(value: ServerNotification): ServerNotification['method'] { return value.method; }
export function requestMethod(value: ServerRequest): ServerRequest['method'] { return value.method; }
