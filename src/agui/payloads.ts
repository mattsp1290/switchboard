import type { ContentPart, PartSource, ToolCallResultEvent } from '@ag-ui/core';
import { identity, record, reject, string } from './internal.js';
import type { DeepReadonly, Json, NativeRef } from './internal.js';

type NativePart<P = ContentPart> = P extends ContentPart
  ? DeepReadonly<Omit<P, 'id' | 'metadata'>> & { readonly id?: NativeRef; readonly metadata?: Exclude<Json, null> }
  : never;
export type NativeContent = Exclude<ToolCallResultEvent['content'], ContentPart[]> | readonly NativePart[];

function source(value: unknown): PartSource {
  const fields = record(value, ['type', 'value', 'mimeType', 'provider']);
  const bytes = string(fields.value);
  const mimeType = fields.mimeType === undefined ? {} : { mimeType: string(fields.mimeType) };
  switch (fields.type) {
    case 'data':
      record(value, ['type', 'value', 'mimeType']);
      return { type: 'data', value: bytes, mimeType: string(fields.mimeType) };
    case 'url':
      record(value, ['type', 'value', 'mimeType']);
      return { type: 'url', value: bytes, ...mimeType };
    case 'file':
      return { type: 'file', value: bytes, ...mimeType,
        ...(fields.provider === undefined ? {} : { provider: string(fields.provider) }),
      };
    default:
      return reject();
  }
}

export function content(value: unknown, sourceKey: string): ToolCallResultEvent['content'] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) reject();
  return value.map((value: unknown): ContentPart => {
    const fields = record(value, ['type', 'id', 'text', 'source', 'metadata']);
    if (fields.metadata === null) reject();
    const common = {
      ...(fields.id === undefined ? {} : { id: identity(sourceKey, 'part', fields.id) }),
      ...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
    };
    if (fields.type === 'text') {
      record(value, ['type', 'id', 'text', 'metadata']);
      return { type: 'text', text: string(fields.text), ...common };
    }
    record(value, ['type', 'id', 'source', 'metadata']);
    if (fields.type !== 'image' && fields.type !== 'audio' && fields.type !== 'video' && fields.type !== 'document') reject();
    return { type: fields.type, source: source(fields.source), ...common };
  });
}
