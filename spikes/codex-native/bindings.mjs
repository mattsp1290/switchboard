import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

execFileSync('/opt/codex', ['app-server', 'generate-ts', '--out', '/tmp/bindings'], { timeout: 20000 });
const files = {};
for (const file of readdirSync('/tmp/bindings', { recursive: true })) {
  if (file.endsWith('.ts')) files[relative('/tmp/bindings', join('/tmp/bindings', file))] = readFileSync(join('/tmp/bindings', file), 'utf8');
}
process.stdout.write(JSON.stringify(files));
