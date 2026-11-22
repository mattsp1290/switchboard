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
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const models: CursorModel[] = [];
  for (const model of value) {
    if (typeof model !== 'object' || model === null || !text(model.id, 256) || !text(model.displayName, 1024)
      || (model.description !== undefined && !text(model.description, 4096))
      || (model.aliases !== undefined && (!Array.isArray(model.aliases) || model.aliases.length > 64
        || !model.aliases.every((alias: unknown) => text(alias, 256))))) return undefined;
    models.push(Object.freeze({ id: model.id, displayName: model.displayName,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.aliases === undefined ? {} : { aliases: Object.freeze([...model.aliases]) }) }));
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
      if (!(signal instanceof AbortSignal)) return Promise.resolve(fail({ code: 'invalid-input', message: 'Model listing requires a signal.' }));
      if (signal.aborted || lifetime.signal.aborted) return Promise.resolve(fail({ code: 'closed', message: 'Model listing was closed.' }));
      if (pending) return Promise.resolve(fail({ code: 'busy', message: 'A catalog request is still unresolved.' }));
      pending = true;
      let upstream: Promise<unknown>;
      try { upstream = Promise.resolve(request()); }
      catch { pending = false; return Promise.resolve(fail({ code: 'native-failure', message: 'Cursor model listing failed.' })); }
      void upstream.then(() => { pending = false; }, () => { pending = false; });
      return new Promise((resolve) => {
        let done = false;
        const finish = (result: Outcome<readonly CursorModel[], HostAdapterError>) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', closed);
          lifetime.signal.removeEventListener('abort', closed);
          resolve(result);
        };
        const closed = () => finish(fail({ code: 'closed', message: 'Model listing was closed.' }));
        const timer = setTimeout(() => finish(fail({ code: 'unavailable', feature: 'models', message: 'Cursor model listing exceeded its deadline.' })), 30000);
        signal.addEventListener('abort', closed, { once: true });
        lifetime.signal.addEventListener('abort', closed, { once: true });
        if (signal.aborted || lifetime.signal.aborted) closed();
        void upstream.then((value) => {
          if (done) return;
          try {
            const models = catalog(value);
            finish(models ? { kind: 'ok', value: models } : fail({ code: 'native-failure', message: 'Cursor returned an invalid catalog.' }));
          } catch { finish(fail({ code: 'native-failure', message: 'Cursor returned an invalid catalog.' })); }
        }, () => finish(fail({ code: 'native-failure', message: 'Cursor model listing failed.' })));
      });
    } },
  };
}
