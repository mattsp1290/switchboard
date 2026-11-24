import { types } from 'node:util';
import type { Outcome } from './contracts.js';
import type { HostImageInput, HostImageInputApi } from './host-adapter.js';

const mediaTypes = Object.freeze(['image/png', 'image/jpeg'] as const);
export const hostImageLimits: HostImageInputApi = Object.freeze({
  maxBytes: 4194304, maxImages: 16, mediaTypes,
});
export interface ValidatedHostImage extends HostImageInput {
  readonly mediaType: typeof mediaTypes[number];
  readonly base64: string;
  readonly bytes: number;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Unsupported adapters allow omission and ordinary empty arrays; malformed or proxy media is present. */
export function hostImagesRequested(value: unknown): boolean {
  return value !== undefined && (types.isProxy(value) || !Array.isArray(value) || value.length !== 0);
}
/** Validate canonical encoding and aggregate size without allocating decoded attachments. */
export function parseHostImages(value: unknown, limits: HostImageInputApi = hostImageLimits):
Outcome<readonly ValidatedHostImage[], { readonly code: 'invalid-input'; readonly message: string }> {
  const invalid = () => ({ kind: 'error' as const, error: { code: 'invalid-input' as const, message: 'Invalid image input.' } });
  try {
    const maxBytes = Math.min(limits.maxBytes, hostImageLimits.maxBytes);
    const maxImages = Math.min(limits.maxImages, hostImageLimits.maxImages);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxImages) || maxImages < 1 || !Array.isArray(value) || types.isProxy(value)) return invalid();
    const count = value.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > maxImages) return invalid();
    const entries: unknown[] = Array.from({ length: count }, (_, index) => value[index]);
    if (value.length !== count) return invalid();
    const images: ValidatedHostImage[] = [];
    let total = 0;
    for (const image of entries) {
      if (typeof image !== 'object' || image === null) return invalid();
      const rawType: unknown = 'mediaType' in image ? image.mediaType : undefined;
      const mediaType = mediaTypes.find((type) => type === rawType);
      const dataUrl: unknown = 'dataUrl' in image ? image.dataUrl : undefined;
      if (typeof mediaType !== 'string' || typeof dataUrl !== 'string' || !limits.mediaTypes.includes(mediaType)) return invalid();
      const prefix = `data:${mediaType};base64,`;
      if (!dataUrl.startsWith(prefix)) return invalid();
      const base64 = dataUrl.slice(prefix.length);
      if (base64.length === 0 || base64.length % 4 !== 0 || base64.length > Math.ceil(maxBytes / 3) * 4) return invalid();
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      const bytes = base64.length / 4 * 3 - padding;
      total += bytes;
      if (bytes <= 0 || total > maxBytes || !/^[A-Za-z0-9+/]+={0,2}(?![\s\S])/.test(base64)) return invalid();
      const last = alphabet.indexOf(base64[base64.length - padding - 1] ?? '');
      if ((padding === 2 && last % 16 !== 0) || (padding === 1 && last % 4 !== 0)) return invalid();
      images.push(Object.freeze({ mediaType, dataUrl, base64, bytes }));
    }
    if (value.length !== count) return invalid();
    return { kind: 'ok', value: Object.freeze(images) };
  } catch { return invalid(); }
}
