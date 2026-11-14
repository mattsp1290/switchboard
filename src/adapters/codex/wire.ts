import { constants } from 'node:buffer';
import { TextDecoder } from 'node:util';
import type { RequestId } from './protocol/RequestId.js';

export type RawEnvelope = Readonly<Record<string, unknown>>;
export type RpcError = { readonly code: number; readonly message: string; readonly data: unknown };
export type RpcReply =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'error'; readonly error: RpcError };
export type IncomingCall = {
  readonly id: RequestId;
  readonly method: string;
  readonly params: unknown;
  readonly raw: RawEnvelope;
};
export type Notification = { readonly method: string; readonly params: unknown; readonly raw: RawEnvelope };
export type ReplyEnvelope = { readonly id: RequestId; readonly reply: RpcReply; readonly raw: RawEnvelope };
export type Envelope =
  | { readonly kind: 'request'; readonly request: IncomingCall }
  | { readonly kind: 'notification'; readonly notification: Notification }
  | { readonly kind: 'reply'; readonly envelope: ReplyEnvelope };
export type WireFault = 'malformed-frame' | 'oversized-frame' | 'input-overflow' | 'invalid-envelope';
export interface WireReader {
  readonly push: (bytes: Uint8Array) => void;
  readonly end: () => void;
  readonly close: () => void;
}

function isObject(value: unknown): value is RawEnvelope {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isId(value: unknown): value is RequestId {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value));
}
function parseEnvelope(value: unknown): Envelope | undefined {
  if (!isObject(value)) return undefined;
  const has = (key: string) => Object.hasOwn(value, key);
  if (has('jsonrpc') && value.jsonrpc !== '2.0') return undefined;
  if (has('id') && !isId(value.id)) return undefined;
  if (has('method')) {
    if (typeof value.method !== 'string' || !value.method || has('result') || has('error')) return undefined;
    const call = { method: value.method, params: value.params, raw: value };
    return has('id') && isId(value.id)
      ? { kind: 'request', request: { ...call, id: value.id } }
      : { kind: 'notification', notification: call };
  }
  if (!has('id') || !isId(value.id) || has('params') || has('result') === has('error')) return undefined;
  let reply: RpcReply;
  if (has('result')) {
    if (value.result === undefined) return undefined;
    reply = { kind: 'result', value: value.result };
  } else {
    const error = value.error;
    if (!isObject(error) || typeof error.code !== 'number' || !Number.isSafeInteger(error.code)
      || typeof error.message !== 'string') return undefined;
    reply = { kind: 'error', error: { code: error.code, message: error.message, data: error.data } };
  }
  return { kind: 'reply', envelope: { id: value.id, reply, raw: value } };
}
function validateBytes(value: number, terminator = 0): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > constants.MAX_LENGTH - terminator) {
    throw new RangeError('Invalid wire byte bounds');
  }
}
function routingFacts(envelope: Envelope): readonly unknown[] {
  switch (envelope.kind) {
    case 'request': return [envelope.kind, envelope.request.id, envelope.request.method];
    case 'notification': return [envelope.kind, envelope.notification.method];
    case 'reply': return [envelope.kind, envelope.envelope.id, envelope.envelope.reply.kind];
  }
}
export function encodeEnvelope(value: RawEnvelope, maxFrameBytes: number): Uint8Array | undefined {
  validateBytes(maxFrameBytes, 1);
  try {
    const original = parseEnvelope(value);
    if (!original) return undefined;
    const expected = routingFacts(original);
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > maxFrameBytes) return undefined;
    const encoded = parseEnvelope(JSON.parse(json));
    if (!encoded) return undefined;
    const actual = routingFacts(encoded);
    if (expected.length !== actual.length || expected.some((fact, index) => !Object.is(fact, actual[index]))) return undefined;
    return Buffer.from(`${json}\n`, 'utf8');
  } catch { return undefined; }
}

export function createWireReader(options: {
  readonly maxFrameBytes: number;
  readonly maxChunkBytes: number;
  readonly onEnvelope: (envelope: Envelope) => void;
  readonly onFault: (fault: WireFault) => void;
}): WireReader {
  const { maxFrameBytes, maxChunkBytes, onEnvelope, onFault } = options;
  validateBytes(maxFrameBytes, 1);
  validateBytes(maxChunkBytes);
  let frame: Uint8Array | undefined = Buffer.allocUnsafe(maxFrameBytes);
  let length = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const close = () => { frame = undefined; length = 0; };
  const fault = (reason: WireFault) => {
    close();
    onFault(reason);
  };
  return {
    close,
    end: () => {
      if (!frame) return;
      if (length) fault('malformed-frame');
      else close();
    },
    push: (bytes) => {
      if (!frame) return;
      if (bytes.length > maxChunkBytes) { fault('input-overflow'); return; }
      let offset = 0;
      while (offset < bytes.length && frame) {
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        const size = end - offset;
        if (length + size > maxFrameBytes) { fault('oversized-frame'); return; }
        frame.set(bytes.subarray(offset, end), length);
        length += size;
        offset = end + 1;
        if (newline < 0) return;
        let envelope: Envelope | undefined;
        try { envelope = parseEnvelope(JSON.parse(decoder.decode(frame.subarray(0, length)))); }
        catch { fault('malformed-frame'); return; }
        length = 0;
        if (!envelope) { fault('invalid-envelope'); return; }
        onEnvelope(envelope);
      }
    },
  };
}
