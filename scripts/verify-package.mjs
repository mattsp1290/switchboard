import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
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
  const buildFiles = readdirSync(join(root, 'dist'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
  assert(buildFiles.length > 0, 'The build emits package files.');
  assert(buildFiles.every((path) => /\.(?:js|d\.ts)$/.test(path)), 'Only JavaScript and declarations ship from dist.');
  assert.deepEqual(files, [
    'LICENSE',
    'README.md',
    ...buildFiles,
    'docs/architecture/boundaries.md',
    'package.json',
  ].sort(), 'The package contains only its public build, manifest, license, and README.');
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

  copyFileSync(join(root, 'tests/core/contracts.test.ts'), join(consumer, 'contracts.test.ts'));
  const consumerConfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      skipLibCheck: false,
      noEmit: true,
    },
    files: ['contracts.test.ts'],
  };
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(consumerConfig));
  const compilerManifest = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8'));
  const compiler = join(root, 'node_modules/typescript', compilerManifest.bin.tsc);
  run(process.execPath, [compiler, '-p', join(consumer, 'tsconfig.json')], consumer);

  const invalidCases = [
    ['unnarrowed-capability', 'catalog.api;', 2339],
    ['unsupported-api', "if (catalog.kind === 'unsupported') catalog.api;", 2339],
    ['unavailable-api', "if (catalog.kind === 'unavailable') catalog.api;", 2339],
    ['unsupported-literal', "const invalid = { kind: 'unsupported', reason: 'Absent.', api: catalogApi } satisfies Capability<Catalog>;", 2353],
    ['unavailable-literal', "const invalid = { kind: 'unavailable', reason: 'Disabled.', api: catalogApi } satisfies Capability<Catalog>;", 2353],
    ['supported-literal', "const invalid = { kind: 'supported' } satisfies Capability<Catalog>;", 1360],
    ['wrong-api', "const invalid: Capability<Catalog> = { kind: 'supported', api: { listModels: async () => ({ kind: 'ok', value: [{ id: 'a', contextWindow: 'large' }] }) } };", 2322],
    ['wrong-arguments', "if (catalog.kind === 'supported') await catalog.api.listModels({ provider: 42 });", 2322],
    ['wrong-result', "if (catalog.kind === 'supported') { const models = await catalog.api.listModels({ provider: 'acme' }); if (models.kind === 'ok') { const invalid: readonly { id: number }[] = models.value; } }", 2322],
    ['wrong-options', "registration.open({ executable: 'acme' });", 2353],
    ['wrong-identity', "const invalid: AdapterRegistration<Options, ExampleAdapter> = { identity: { ...identity, engine: 'other/engine' }, open: openExample };", 2322],
    ['missing-cleanup', 'const invalid: ExampleAdapter = { identity, capabilities: { modelCatalog: catalog } };', 2741],
    ['factory-variance', 'declare const restricted: AdapterRegistration<Options & { readonly token: string }, ExampleAdapter>; const invalid: AdapterRegistration<Options, ExampleAdapter> = restricted;', 2322],
    ['unknown-native-data', 'extension.data.modelAlias;', 18046],
    ['typed-native-data', 'const invalid: number = nativeData.data.modelAlias;', 2322],
    ['unnarrowed-outcome', 'opened.value;', 2339],
    ['unsupported-error', "const invalid: AdapterError = { code: 'unsupported', message: 'Absent.' };", 2322],
    ['private-import', `import '${manifest.name}/dist/core/contracts.js';`, 2882],
  ];
  const prelude = [
    `import type { AdapterError, AdapterRegistration, Capability } from '${manifest.name}';`,
    "import type { Catalog, ExampleAdapter, Options } from './contracts.test.js';",
    "import { catalog, catalogApi, extension, identity, nativeData, opened, openExample, registration } from './contracts.test.js';",
  ].join('\n');
  const invalidFiles = invalidCases.map(([name, source]) => {
    const file = `${name}.mts`;
    writeFileSync(join(consumer, file), `${prelude}\n${source}\n`);
    return file;
  });
  writeFileSync(join(consumer, 'invalid.json'), JSON.stringify({ ...consumerConfig, files: invalidFiles }));
  const rejected = spawnSync(process.execPath, [compiler, '-p', 'invalid.json', '--pretty', 'false'], {
    cwd: consumer,
    encoding: 'utf8',
  });
  assert.ifError(rejected.error);
  assert.equal(rejected.signal, null);
  assert.equal(rejected.status, 1, `Invalid consumers fail type checking.\n${rejected.stdout}\n${rejected.stderr}`);
  assert.equal(rejected.stderr, '');
  const diagnostics = [...rejected.stdout.matchAll(/^([^\n]+)\((\d+),(\d+)\): error TS(\d+):/gm)]
    .map((match) => ({ file: match[1], line: Number(match[2]), code: Number(match[4]) }));
  assert.equal(diagnostics.length, (rejected.stdout.match(/error TS\d+:/g) ?? []).length, rejected.stdout);
  const expected = invalidCases.map(([name, , code]) => ({ file: `${name}.mts`, line: 4, code }));
  const byFile = (left, right) => left.file.localeCompare(right.file);
  assert.deepEqual(diagnostics.sort(byFile), expected.sort(byFile), rejected.stdout);
  console.log(`Verified ${manifest.name}@${manifest.version} with ${process.version} on ${process.platform}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
