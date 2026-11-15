import { registerHooks } from 'node:module';

const source = new URL('../../../adapters/codex/src/index.ts', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === source && specifier === './process.js') {
    return { url: new URL('../../../adapters/codex/src/process.ts', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
export const { createCodexRuntime } = await import(source);
hook.deregister();
