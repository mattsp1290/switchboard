import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npm = process.env.npm_execpath;
assert(npm, 'Run this check with npm run verify:package.');

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function runNpm(args, cwd = root) {
  return run(process.execPath, [npm, ...args], cwd);
}

const temporary = mkdtempSync(join(tmpdir(), 'switchboard-package-'));
try {
  process.stdout.write(runNpm(['run', 'build']));
  const artifacts = join(temporary, 'artifacts');
  const consumer = join(temporary, 'consumer');
  mkdirSync(artifacts);
  mkdirSync(consumer);

  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', artifacts]));
  assert.equal(packed.length, 1, 'Pack produces one package.');
  const [pack] = packed;
  const files = pack.files.map(({ path }) => path).sort();
  assert.deepEqual(files, [
    'LICENSE',
    'README.md',
    'dist/index.d.ts',
    'dist/index.js',
    'docs/architecture/boundaries.md',
    'package.json',
  ], 'The package contains only its public build, manifest, license, and README.');
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);

  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  process.stdout.write(runNpm([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', join(artifacts, pack.filename),
  ], consumer));

  const installed = join(consumer, 'node_modules', ...manifest.name.split('/'));
  assert.equal(readFileSync(join(installed, 'LICENSE'), 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(installedManifest.exports, {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  });
  assert.equal(installedManifest.private, true);
  assert.equal(Object.keys(installedManifest.dependencies ?? {}).length, 0);

  writeFileSync(join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import * as switchboard from '${manifest.name}';
assert.equal(typeof switchboard, 'object');
assert.deepEqual(Object.keys(switchboard), []);
await assert.rejects(import('${manifest.name}/dist/index.js'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
});
`);
  run(process.execPath, ['runtime.mjs'], consumer);

  writeFileSync(join(consumer, 'types.mts'), `
import * as switchboard from '${manifest.name}';
type IsAny<T> = 0 extends (1 & T) ? true : false;
const namespaceIsAny: IsAny<typeof switchboard> = false;
const namespaceIsEmpty: keyof typeof switchboard extends never ? true : false = true;
void namespaceIsAny;
void namespaceIsEmpty;
`);
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    files: ['types.mts'],
  }));
  const compilerManifest = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8'));
  const compiler = join(root, 'node_modules/typescript', compilerManifest.bin.tsc);
  run(process.execPath, [compiler, '-p', join(consumer, 'tsconfig.json')], consumer);
  console.log(`Verified ${manifest.name}@${manifest.version} with ${process.version} on ${process.platform}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
