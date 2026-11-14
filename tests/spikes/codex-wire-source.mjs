export const clientWireSource = (specifier, context) =>
  specifier === '../../dist/adapters/codex/wire.js'
    && context.parentURL === new URL('../../spikes/codex-native/client.mjs', import.meta.url).href
    ? { url: new URL('../../src/adapters/codex/wire.ts', import.meta.url).href, shortCircuit: true }
    : undefined;
