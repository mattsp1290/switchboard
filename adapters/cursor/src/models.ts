import { addAbortListener } from 'node:events';
import { callerModelId } from './config.js';
import type { HostAdapterError, Outcome } from '#switchboard';

export interface CursorModel {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
}
export interface CursorModelsApi {
  readonly list: (signal: AbortSignal) => Promise<Outcome<readonly CursorModel[], HostAdapterError>>;
}
const text = (value: unknown, bytes: number): value is string => typeof value === 'string' && Buffer.byteLength(value) <= bytes;
function catalog(value: unknown): readonly CursorModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const count = value.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) return undefined;
  const entries: unknown[] = Array.from({ length: count }, (_, index) => value[index]);
  if (value.length !== count) return undefined;
  const models: CursorModel[] = [];
  for (const model of entries) {
    if (typeof model !== 'object' || model === null) return undefined;
    if (!('id' in model) || !('displayName' in model)) return undefined;
    const { id, displayName } = model;
    const description: unknown = 'description' in model ? model.description : undefined;
    const aliases: unknown = 'aliases' in model ? model.aliases : undefined;
    if (!text(id, 256) || !callerModelId(id) || !text(displayName, 1024)
      || (description !== undefined && !text(description, 4096))
      || (aliases !== undefined && !Array.isArray(aliases))) return undefined;
    const aliasCount = aliases === undefined ? 0 : aliases.length;
    if (!Number.isSafeInteger(aliasCount) || aliasCount < 0 || aliasCount > 64) return undefined;
    const copiedAliases: unknown[] | undefined = aliases === undefined ? undefined
      : Array.from({ length: aliasCount }, (_, index) => aliases[index]);
    if (aliases !== undefined && aliases.length !== aliasCount) return undefined;
    if (copiedAliases !== undefined && !copiedAliases.every((alias): alias is string => text(alias, 256))) return undefined;
    models.push(Object.freeze({ id, displayName,
      ...(description === undefined ? {} : { description: description }),
      ...(copiedAliases === undefined ? {} : { aliases: Object.freeze(copiedAliases) }) }));
  }
  return Object.freeze(models);
}
/** The SDK cannot cancel catalog IO. Keep its lease until it settles, independently of the public waiter. */
export function createCursorModels(request: () => Promise<unknown>): { readonly api: CursorModelsApi; readonly close: () => void } {
  const lifetime = new AbortController();
  let pending = false;
  const fail = (error: HostAdapterError) => ({ kind: 'error' as const, error });
  return {
    close: () => lifetime.abort(),
    api: { list(signal) {
      let caller: AbortSignal;
      try { caller = AbortSignal.any([signal]); }
      catch { return Promise.resolve(fail({ code: 'invalid-input', message: 'Model listing requires a signal.' })); }
      if (caller.aborted || lifetime.signal.aborted) return Promise.resolve(fail({ code: 'closed', message: 'Model listing was closed.' }));
      if (pending) return Promise.resolve(fail({ code: 'busy', message: 'A catalog request is still unresolved.' }));
      pending = true;
      const expiresAt = performance.now() + 30000;
      const nativeFailure = (message: string) => fail(caller.aborted || lifetime.signal.aborted
        ? { code: 'closed', message: 'Model listing was closed.' }
        : performance.now() >= expiresAt
          ? { code: 'unavailable', feature: 'models', message: 'Cursor model listing exceeded its deadline.' }
          : { code: 'native-failure', message });
      let upstream: Promise<unknown>;
      try { upstream = Promise.resolve(request()); }
      catch { pending = false; return Promise.resolve(nativeFailure('Cursor model listing failed.')); }
      void upstream.then(() => { pending = false; }, () => { pending = false; });
      return new Promise((resolve) => {
        let done = false;
        let callerAbort: ReturnType<typeof addAbortListener> | undefined;
        const finish = (result: Outcome<readonly CursorModel[], HostAdapterError>) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          callerAbort?.[Symbol.dispose]();
          lifetime.signal.removeEventListener('abort', closed);
          resolve(result);
        };
        const closed = () => finish(fail({ code: 'closed', message: 'Model listing was closed.' }));
        const expired = () => finish(fail({ code: 'unavailable', feature: 'models', message: 'Cursor model listing exceeded its deadline.' }));
        const timer = setTimeout(expired, 30000);
        callerAbort = addAbortListener(caller, closed);
        lifetime.signal.addEventListener('abort', closed, { once: true });
        if (caller.aborted || lifetime.signal.aborted) closed();
        void upstream.then((value) => {
          if (done) return;
          if (caller.aborted || lifetime.signal.aborted) { closed(); return; }
          if (performance.now() >= expiresAt) { expired(); return; }
          try {
            const models = catalog(value);
            if (performance.now() >= expiresAt) { expired(); return; }
            finish(models ? { kind: 'ok', value: models } : fail({ code: 'native-failure', message: 'Cursor returned an invalid catalog.' }));
          } catch { finish(nativeFailure('Cursor returned an invalid catalog.')); }
        }, () => finish(nativeFailure('Cursor model listing failed.')));
      });
    } },
  };
}
