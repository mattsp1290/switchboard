import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));

test('the root compiler policy rejects the Claude SDK on HeadersInit', () => {
  let stderr = '';
  try {
    execFileSync(process.execPath, [tsc, '-p', 'tests/adapters/claude-host/strict/tsconfig.json', '--pretty', 'false'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('strict SDK import compiled');
  } catch (error) {
    stderr = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.match(stderr, /node_modules\/@modelcontextprotocol\/sdk\/dist\/esm\/shared\/transport\.d\.ts.*TS2304: Cannot find name 'HeadersInit'/);
});

test('the Claude host project compiles and its declarations do not name the SDK', () => {
  const out = mkdtempSync(join(tmpdir(), 'switchboard-claude-host-declarations-'));
  try {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--emitDeclarationOnly', '--outDir', 'dist'], { cwd: root, stdio: 'inherit' });
    execFileSync(process.execPath, [tsc, '-p', 'adapters/claude-host/tsconfig.json', '--noEmit'], { cwd: root, stdio: 'inherit' });
    execFileSync(process.execPath, [tsc, '-p', 'adapters/claude-host/tsconfig.json', '--outDir', out, '--declaration'],
      { cwd: root, stdio: 'inherit' });
    for (const name of ['index.d.ts', 'sdk.d.ts']) {
      assert.doesNotMatch(readFileSync(join(out, name), 'utf8'), /@anthropic-ai/);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
