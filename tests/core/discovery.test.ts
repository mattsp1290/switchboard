import { discoverFiles, fileDiscoveryLimits } from '@mattsp1290/switchboard';
import type { FileDecode, FileDiscoveryBounds, FileDiscoveryError, FileDiscoveryPage, FileDiscoveryScope, Outcome } from '@mattsp1290/switchboard';
import { sessionBinding } from './sessions.test.js';
export const fileScope: FileDiscoveryScope = { binding: sessionBinding, root: '/explicit-fixture-root', namespace: 'host-stable' };
export const fileBounds: FileDiscoveryBounds = { maxResults: 2, maxExamined: 10, maxDurationMs: 100, maxDepth: 2, maxFileBytes: 1024, maxTotalBytes: 4096 };
export const decodedFile: FileDecode<string> = { kind: 'found', value: 'fixture' };
export declare const filePage: FileDiscoveryPage<string>;
export const fileOptions = {
  scope: fileScope, expected: sessionBinding, bounds: fileBounds, signal: new AbortController().signal,
  selectFile: (name: string) => name.endsWith('.fixture'),
  decode: ({ bytes }: { readonly bytes: Uint8Array }): FileDecode<string> => ({ kind: 'found', value: bytes.toString() }),
};
const found: Promise<Outcome<FileDiscoveryPage<string>, FileDiscoveryError>> = discoverFiles(fileOptions);
export function fileState(page: FileDiscoveryPage<string>): string {
  switch (page.kind) {
    case 'complete': return page.values.join(',');
    case 'cancelled': return `${page.bytesRead}`;
    case 'truncated': return page.reason;
    default: { const exhaustive: never = page; return exhaustive; }
  }
}
export function decodeState(decoded: FileDecode<string>): string {
  switch (decoded.kind) {
    case 'found': return decoded.value;
    case 'skip': return 'skip';
    case 'corrupt': return 'corrupt';
    default: { const exhaustive: never = decoded; return exhaustive; }
  }
}
void found;
void fileDiscoveryLimits.maxDepth;
