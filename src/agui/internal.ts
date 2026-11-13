export type Json = null | boolean | number | string | readonly Json[]
  | { readonly [key: string]: Json };

export interface ProjectionBounds {
  readonly maxEntities: number;
  readonly maxPayloadBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
}

export interface ProjectionError {
  readonly code: 'invalid-input' | 'invalid-order' | 'bounds-exceeded' | 'closed';
}

const faultCodes: readonly ProjectionError['code'][] = ['invalid-input', 'invalid-order', 'bounds-exceeded', 'closed'];
const faults = new Map(faultCodes.map(code => [code, Symbol(code)]));

export function reject(code: ProjectionError['code'] = 'invalid-input'): never {
  throw faults.get(code);
}

export function failure(error: unknown): { readonly kind: 'error'; readonly error: ProjectionError } {
  return errorResult(faultCodes.find(code => faults.get(code) === error) ?? 'invalid-input');
}

export function errorResult(code: ProjectionError['code']): { readonly kind: 'error'; readonly error: ProjectionError } {
  return Object.freeze({
    kind: 'error',
    error: Object.freeze({ code }),
  });
}

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) reject();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) reject();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject();
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}

export function readBounds(value: unknown): ProjectionBounds {
  const fields = record(value, ['maxEntities', 'maxPayloadBytes', 'maxJsonDepth', 'maxJsonNodes']);
  const positive = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) reject();
    return value;
  };
  const bounds = {
    maxEntities: positive(fields.maxEntities),
    maxPayloadBytes: positive(fields.maxPayloadBytes),
    maxJsonDepth: positive(fields.maxJsonDepth),
    maxJsonNodes: positive(fields.maxJsonNodes),
  };
  if (bounds.maxJsonDepth > 128) reject();
  return Object.freeze(bounds);
}

export function capture(value: unknown, bounds: ProjectionBounds): Json {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > bounds.maxPayloadBytes) reject('bounds-exceeded');
  };
  const string = (value: string) => {
    if (value.length > bounds.maxPayloadBytes) reject('bounds-exceeded');
    charge(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  };
  const visit = (value: unknown, depth: number): Json => {
    if (++nodes > bounds.maxJsonNodes || depth > bounds.maxJsonDepth) reject('bounds-exceeded');
    if (typeof value === 'string') {
      string(value);
      return value;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) reject();
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) reject();
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) reject();
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > bounds.maxJsonNodes - nodes + (array ? 1 : 0)) reject('bounds-exceeded');
    charge(2);
    const result: Json[] | Record<string, Json> = array ? [] : {};
    let members = 0;
    let length: unknown;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) reject();
      if (array && key === 'length') {
        length = descriptor.value;
        continue;
      }
      if (typeof key !== 'string' || !descriptor.enumerable) reject();
      if (members++ > 0) charge(1);
      if (array) {
        if (key !== String(members - 1)) reject();
      } else {
        if (++nodes > bounds.maxJsonNodes) reject('bounds-exceeded');
        string(key);
        charge(1);
      }
      const child: unknown = descriptor.value;
      Object.defineProperty(result, key, { value: visit(child, depth + 1), enumerable: true });
    }
    if (array && length !== members) reject();
    ancestors.delete(value);
    return Object.freeze(result);
  };
  return visit(value, 0);
}
