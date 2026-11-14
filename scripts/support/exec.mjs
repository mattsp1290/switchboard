import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function run(command, args, cwd = root, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

export function runNpm(args, cwd = root) {
  const npm = process.env.npm_execpath;
  assert(npm, 'Run this check with npm run verify:package.');
  return run(process.execPath, [npm, ...args], cwd);
}
