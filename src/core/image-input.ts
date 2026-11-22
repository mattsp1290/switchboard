import type { Outcome } from './contracts.js';
import type { HostImageInput, HostImageInputApi } from './host-adapter.js';

export const hostImageLimits: HostImageInputApi = Object.freeze({
  maxBytes: 4194304, maxImages: 16, mediaTypes: Object.freeze(['image/png', 'image/jpeg']),
});
export interface ValidatedHostImage extends HostImageInput {
  readonly base64: string;
  readonly bytes: number;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Validate canonical encoding and aggregate size without allocating decoded attachments. */
export function parseHostImages(value: unknown, limits: HostImageInputApi = hostImageLimits):
Outcome<readonly ValidatedHostImage[], { readonly code: 'invalid-input'; readonly message: string }> {
  const invalid = () => ({ kind: 'error' as const, error: { code: 'invalid-input' as const, message: 'Invalid image input.' } });
  try {
    if (!Array.isArray(value) || value.length > limits.maxImages) return invalid();
    const images: ValidatedHostImage[] = [];
    let total = 0;
    for (const image of value) {
      if (typeof image !== 'object' || image === null) return invalid();
      const { mediaType, dataUrl } = image;
      if (typeof mediaType !== 'string' || typeof dataUrl !== 'string' || !limits.mediaTypes.includes(mediaType)) return invalid();
      const prefix = `data:${mediaType};base64,`;
      if (!dataUrl.startsWith(prefix)) return invalid();
      const base64 = dataUrl.slice(prefix.length);
      if (base64.length === 0 || base64.length % 4 !== 0 || base64.length > Math.ceil(limits.maxBytes / 3) * 4) return invalid();
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      const bytes = base64.length / 4 * 3 - padding;
      total += bytes;
      if (bytes <= 0 || total > limits.maxBytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return invalid();
      const last = alphabet.indexOf(base64[base64.length - padding - 1] ?? '');
      if ((padding === 2 && last % 16 !== 0) || (padding === 1 && last % 4 !== 0)) return invalid();
      images.push(Object.freeze({ mediaType, dataUrl, base64, bytes }));
    }
    return { kind: 'ok', value: Object.freeze(images) };
  } catch { return invalid(); }
}
