import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, exactDiagnostics, successful } from '../../spikes/native-compiler/support/compiler.mjs';

const [mode, root] = process.argv.slice(2);
const env = Object.assign(Object.create(null), { TMPDIR: root, LANG: 'C', TZ: 'UTC' });
const executable = mode === 'missing' ? join(root, 'missing-executable') : process.execPath;
const args = mode === 'missing' ? [] : [fileURLToPath(new URL('./compiler-command-child.mjs', import.meta.url)), mode, root];
const result = command(executable, args, root, env, join(root, 'evidence.json'), 3000);
const expected = [{ file: 'fixture.ts', line: 1, code: 2322 }];
if (mode === 'success') assert.equal(successful(result), 'inert stdout\n');
else assert.throws(() => successful(result));
if (mode === 'diagnostic') exactDiagnostics(result, expected);
else assert.throws(() => exactDiagnostics(result, expected));
writeFileSync(join(root, 'returned.json'), JSON.stringify({
  code: result.error?.code ?? null, error: result.error?.message ?? null,
  status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
}));
