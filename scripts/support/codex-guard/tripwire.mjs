// Independent bare-package tripwire for guarded Codex runs. It imports nothing from the repo and registers
// before the guard, so it is the innermost resolve hook: if the guard is missing, it still refuses every bare
// specifier before next(), so no package is resolved or loaded.
import { writeSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';

const write = writeSync;
const nonce = new URL(import.meta.url).searchParams.get('nonce');
// Duplicated from the guard on purpose: independence beats sharing here.
const bare = (specifier) => !/^(\.{0,2}\/|file:|node:|data:)/.test(specifier) && !isBuiltin(specifier);

registerHooks({
  resolve(specifier, context, next) {
    if (!bare(specifier)) return next(specifier, context);
    const label = `tripwire ${specifier.slice(0, 300)}`;
    try { write(3, `${JSON.stringify({ n: nonce, k: 'tripwire', label })}\n`); } catch { /* the refusal still throws */ }
    throw Object.assign(new Error(`codex tripwire refused ${label}`), { code: 'ERR_SWITCHBOARD_CODEX_TRIPWIRE' });
  },
});
