import type { NativeExtension } from '../../core/contracts.js';

export const codexActivityMethods = Object.freeze(['item/started', 'item/completed',
  'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated']);
export function codexActivityItem(method: string, params: unknown): NativeExtension | undefined {
  if (!codexActivityMethods.includes(method) || typeof params !== 'object' || params === null) return undefined;
  if (method === 'item/started' || method === 'item/completed') {
    if (!('item' in params) || typeof params.item !== 'object' || params.item === null || !('type' in params.item)
      || (params.item.type !== 'commandExecution' && params.item.type !== 'fileChange')) return undefined;
  } else if (!('itemId' in params) || typeof params.itemId !== 'string') return undefined;
  return Object.freeze({ namespace: 'codex-app-server/item', schemaVersion: 1, data: { method, params } });
}
