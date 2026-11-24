import { hostImageLimits } from '../../core/image-input.js';
import type { ValidatedHostImage } from '../../core/image-input.js';
import type { Outcome } from '../../core/contracts.js';

export const codexImageLimits = hostImageLimits;
export const codexOrdinaryFrameBytes = 1048576;
export const codexImageFrameBytes = 8388608;
export type CodexImage = { readonly type: 'image'; readonly url: string };
export function codexTurnInput(prompt: string, images: readonly CodexImage[] = []) {
  return [{ type: 'text' as const, text: prompt, text_elements: [] }, ...images];
}
/** Mirrors execution.ts turn/start params, reserving the maximum transport sequence and UUID thread id. */
export function codexImages(value: readonly ValidatedHostImage[], prompt: string, effort?: string, routed = false):
Outcome<readonly CodexImage[], { readonly code: 'invalid-input'; readonly message: string }> {
  if (prompt.length > codexOrdinaryFrameBytes || (effort !== undefined && effort.length > codexOrdinaryFrameBytes)) {
    return { kind: 'error', error: { code: 'invalid-input', message: 'The text envelope exceeds its frame budget.' } };
  }
  const images = Object.freeze(value.map((image): CodexImage => Object.freeze({ type: 'image', url: image.dataUrl })));
  const frame = (input: readonly unknown[]) => ({ id: `${'x'.repeat(36)}:${Number.MAX_SAFE_INTEGER}`,
    method: 'turn/start', params: { ...(effort === undefined ? {} : { effort }), ...(routed ? { approvalPolicy: 'never' } : {}), threadId: 'x'.repeat(36), input } });
  if (Buffer.byteLength(JSON.stringify(frame(codexTurnInput(prompt)))) > codexOrdinaryFrameBytes
    || Buffer.byteLength(JSON.stringify(frame(codexTurnInput(prompt, images)))) > codexImageFrameBytes) {
    return { kind: 'error', error: { code: 'invalid-input', message: 'The complete image turn exceeds its frame budget.' } };
  }
  return { kind: 'ok', value: images };
}
