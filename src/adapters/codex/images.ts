import { hostImageLimits, parseHostImages } from '../../core/image-input.js';
import type { Outcome } from '../../core/contracts.js';

export const codexImageLimits = hostImageLimits;
export const codexImageFrameBytes = 8388608;
export type CodexImage = { readonly type: 'image'; readonly url: string };
/** Mirrors the turn envelope, reserving the maximum transport sequence and UUID thread id. */
export function codexImages(value: unknown, prompt: string, effort?: string):
Outcome<readonly CodexImage[], { readonly code: 'invalid-input'; readonly message: string }> {
  const parsed = parseHostImages(value, codexImageLimits);
  if (parsed.kind === 'error') return parsed;
  const images = Object.freeze(parsed.value.map((image): CodexImage => Object.freeze({ type: 'image', url: image.dataUrl })));
  if (images.length === 0) return { kind: 'ok', value: images };
  const text = { type: 'text', text: prompt, text_elements: [] };
  const frame = (input: readonly unknown[]) => ({ id: `${'x'.repeat(36)}:${Number.MAX_SAFE_INTEGER}`,
    method: 'turn/start', params: { ...(effort === undefined ? {} : { effort }), threadId: 'x'.repeat(36), input } });
  if (Buffer.byteLength(JSON.stringify(frame([text]))) > 1048576
    || Buffer.byteLength(JSON.stringify(frame([text, ...images]))) > codexImageFrameBytes) {
    return { kind: 'error', error: { code: 'invalid-input', message: 'The complete image turn exceeds its frame budget.' } };
  }
  return { kind: 'ok', value: images };
}
