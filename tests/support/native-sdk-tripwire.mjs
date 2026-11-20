// Preloaded by `npm test` into every test process. Native SDKs load only under `npm run test:native-isolated`;
// here any module loaded from a native SDK package fails the load and the process, even if the error is caught.
import { writeSync } from 'node:fs';
import { registerHooks } from 'node:module';

export const NATIVE_SDK_PACKAGES = Object.freeze(['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk',
  '@openai/codex-sdk', '@openai/codex', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core', '@modelcontextprotocol/sdk', '@cursor/sdk',
  '@cursor/sdk-darwin-arm64', '@cursor/sdk-darwin-x64', '@cursor/sdk-linux-arm64',
  '@cursor/sdk-linux-x64', '@cursor/sdk-win32-x64']);

const paths = NATIVE_SDK_PACKAGES.map((name) => `/node_modules/${name}/`);
const write = writeSync;
let tripped = false;
const failClosed = () => { if (tripped) process.exitCode = 1; };
process.on('beforeExit', failClosed);
process.on('exit', failClosed);

registerHooks({
  load(url, context, next) {
    const path = decodeURIComponent(url);
    const name = NATIVE_SDK_PACKAGES[paths.findIndex((prefix) => path.includes(prefix))];
    if (name === undefined) return next(url, context);
    tripped = true;
    process.exitCode = 1;
    try { write(2, `native SDK tripwire: ${name} loaded outside npm run test:native-isolated\n`); } catch { /* the throw still fails the load */ }
    throw Object.assign(new Error(`native SDK tripwire refused ${name}`), { code: 'ERR_SWITCHBOARD_NATIVE_SDK_TRIPWIRE' });
  },
});
