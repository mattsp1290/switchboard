import type { Outcome } from '../../core/contracts.js';
import type { HostAdapterError, HostModel } from '../../core/host-adapter.js';
import type { CodexTransport } from './transport.js';

const inputModalities = ['text', 'image', 'audio'];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function model(value: unknown): HostModel | undefined {
  if (!record(value) || typeof value.model !== 'string' || typeof value.displayName !== 'string'
    || typeof value.hidden !== 'boolean' || typeof value.isDefault !== 'boolean' || !Array.isArray(value.inputModalities)
    || !value.inputModalities.every((entry): entry is string => typeof entry === 'string' && inputModalities.includes(entry))) return undefined;
  return Object.freeze({ model: value.model, displayName: value.displayName, hidden: value.hidden,
    isDefault: value.isDefault, inputModalities: Object.freeze([...value.inputModalities]) });
}
/** One bounded, uncached read of the native catalog; never creates a thread or returns a partial list. */
export async function listCodexModels(request: CodexTransport['request'], signal: AbortSignal):
Promise<Outcome<readonly HostModel[], HostAdapterError>> {
  const deadline = new AbortController();
  const expiresAt = performance.now() + 5000;
  const timer = setTimeout(() => deadline.abort(), 5000);
  const wait = AbortSignal.any([signal, deadline.signal]);
  const fail = (error: HostAdapterError) => ({ kind: 'error' as const, error });
  const cancelled = () => signal.aborted ? fail({ code: 'closed', message: 'Model listing was closed.' })
    : fail({ code: 'unavailable', feature: 'models', message: 'Model listing exceeded its deadline.' });
  const malformed = () => fail({ code: 'native-failure', message: 'The native model catalog was invalid or incomplete.' });
  const models: HostModel[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 8; page++) {
      if (wait.aborted || performance.now() >= expiresAt) return cancelled();
      const exchange = await request({ method: 'model/list', params: { includeHidden: true,
        ...(cursor === undefined ? {} : { cursor }) } }, wait);
      if (wait.aborted || performance.now() >= expiresAt) return cancelled();
      if (exchange.kind !== 'reply' || exchange.envelope.reply.kind !== 'result') return malformed();
      const value = exchange.envelope.reply.value;
      if (!record(value) || !Array.isArray(value.data) || (value.nextCursor !== null && typeof value.nextCursor !== 'string')
        || value.data.length + models.length > 1000) return malformed();
      for (const entry of value.data) {
        const checked = model(entry);
        if (!checked) return malformed();
        models.push(checked);
      }
      if (wait.aborted || performance.now() >= expiresAt) return cancelled();
      if (value.nextCursor === null) return { kind: 'ok', value: Object.freeze(models) };
      if (cursors.has(value.nextCursor)) return malformed();
      cursors.add(value.nextCursor);
      cursor = value.nextCursor;
    }
    return malformed();
  } catch { return wait.aborted || performance.now() >= expiresAt ? cancelled() : malformed(); }
  finally { clearTimeout(timer); }
}
