// Inert preload for the sabotaged control: child_process.spawn silently ignores writes, so the guard's
// identity canary must refuse to arm. Nothing is ever invoked.
import { createRequire } from 'node:module';

const childProcess = createRequire(import.meta.url)('node:child_process');
const original = childProcess.spawn;
Object.defineProperty(childProcess, 'spawn', { get: () => original, set() {}, configurable: false });
