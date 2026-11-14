import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertClosure, assertEmitted, command, compilerLibraryRoots, compilerPolicy, exactDiagnostics, nodeDeclarationRoots, successful } from './compiler.mjs';
import { assertCoreIsolation, digest, installPackages, installTools, npmCommand, npmEnvironment, packPackage, readJson, writeJson } from './package.mjs';

assert.equal(process.version, 'v24.22.3');
const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'switchboard-compiler-')));
const evidence = join(temporary, 'evidence');
mkdirSync(evidence);
console.log(`Evidence directory ${evidence}`);
const environment = npmEnvironment(temporary);
const npm = npmCommand(process.argv[2], environment, evidence);
assert.equal(npm(['--version'], temporary).trim(), '11.19.1');
const tools = join(temporary, 'tools');
const compiler = installTools(root, tools, npm);
assert.equal(successful(command(process.execPath, [compiler, '--version'], tools, environment,
  join(evidence, 'typescript-version.json'))).trim(), 'Version 7.0.2');
let index = 0;
const invoke = (args, project, timeout) => command(process.execPath, args, project, environment,
  join(evidence, `command-${++index}.json`), timeout);
const compile = (project, files, dom = false, emit = false, list = false) => {
  writeJson(join(project, 'tsconfig.json'), compilerPolicy(files, dom, emit));
  return invoke([compiler, '-p', 'tsconfig.json', '--pretty', 'false', ...(list ? ['--listFilesOnly'] : [])], project);
};
const artifacts = join(temporary, 'artifacts');
mkdirSync(artifacts);
const packageFixture = (name) => {
  const project = join(temporary, name);
  cpSync(join(fixtures, name), project, { recursive: true });
  return project;
};
const declarations = packPackage(packageFixture('declarations'), artifacts, npm);
const foreign = packPackage(packageFixture('foreign'), artifacts, npm);
const native = packPackage(packageFixture('native-control'), artifacts, npm);
const source = packageFixture('inert');
const sourceManifest = readJson(join(source, 'package.json'));
installPackages(source, [declarations], tools, npm);
writeJson(join(source, 'package.json'), sourceManifest);
successful(compile(source, ['src/index.ts'], false, true));
assert.equal(assertEmitted(source).length, 2, 'The emitted entry reaches its real relative helper.');
const inert = packPackage(source, artifacts, npm);
const consumer = join(temporary, 'consumer');
mkdirSync(consumer);
installPackages(consumer, [inert, declarations, foreign], tools, npm);
for (const file of ['host.ts', 'invalid.ts', 'extra.ts', 'private.ts']) copyFileSync(join(fixtures, file), join(consumer, file));
const installed = join(consumer, 'node_modules/@switchboard-proof/inert');
const declaration = join(consumer, 'node_modules/@switchboard-proof/declarations/dist/index.d.ts');
const allowed = [...compilerLibraryRoots(tools), ...nodeDeclarationRoots(consumer),
  installed, join(consumer, 'node_modules/@switchboard-proof/declarations')];
const closure = () => successful(compile(consumer, ['host.ts'], false, false, true)).trim().split('\n');
const positive = () => {
  successful(compile(consumer, ['host.ts']));
  successful(compile(consumer, ['host.ts'], true));
  const files = closure();
  assert(files.includes(declaration), 'A real third-party declaration is compiler-reachable.');
  assertClosure(files, allowed, [join(consumer, 'host.ts')]);
  assertCoreIsolation(consumer, files, { allowedRoots: allowed, allowedFiles: [join(consumer, 'host.ts')] });
  assert.equal(assertEmitted(installed).length, 2);
  return files;
};
const initialClosure = positive();
const owned = [{ file: 'invalid.ts', line: 1, code: 2322 }];
const invalid = compile(consumer, ['invalid.ts']);
exactDiagnostics(invalid, owned);
assert.throws(() => exactDiagnostics(invalid, [{ ...owned[0], line: 2 }]));
assert.throws(() => exactDiagnostics(invalid, [{ ...owned[0], code: 2307 }]));
const extra = compile(consumer, ['extra.ts']);
exactDiagnostics(extra, [{ file: 'extra.ts', line: 1, code: 2322 }, { file: 'extra.ts', line: 2, code: 2322 }]);
assert.throws(() => exactDiagnostics(extra, [{ file: 'extra.ts', line: 1, code: 2322 }]));
assert.throws(() => exactDiagnostics(extra, owned));
assert.throws(() => exactDiagnostics({ ...invalid, stdout: invalid.stdout + 'compiler crashed\n' }, owned));
for (const [script, timeout] of [['process.exit(2)', 1000], ["process.kill(process.pid, 'SIGTERM')", 1000], ['setInterval(() => {}, 1000)', 100]]) {
  assert.throws(() => exactDiagnostics(invoke(['-e', script], consumer, timeout), owned));
}
const original = readFileSync(declaration, 'utf8');
const sourceLeak = join(installed, 'dist/stray.ts');
try {
  writeFileSync(declaration, 'export type Label = MissingDeclaration;\n');
  exactDiagnostics(compile(consumer, ['host.ts']), [{
    file: 'node_modules/@switchboard-proof/declarations/dist/index.d.ts', line: 1, code: 2304,
  }]);
  writeFileSync(declaration, "import type { Foreign } from '@switchboard-proof/foreign';\nexport type Label = Foreign['text'];\n");
  successful(compile(consumer, ['host.ts']));
  assert.throws(() => assertClosure(closure(), allowed, [join(consumer, 'host.ts')]), /Foreign compiler file/);
  assert.throws(() => assertCoreIsolation(consumer, closure(), {
    allowedRoots: allowed, allowedFiles: [join(consumer, 'host.ts')],
  }), /Foreign compiler file/);
  writeFileSync(sourceLeak, 'export type Label = string;\n');
  writeFileSync(declaration, "export type Label = import('../../inert/dist/stray.js').Label;\n");
  successful(compile(consumer, ['host.ts']));
  assert.throws(() => assertClosure(closure(), allowed, [join(consumer, 'host.ts')]), /Unexpected compiler source/);
  rmSync(sourceLeak);
  rmSync(declaration);
  symlinkSync(join(consumer, 'node_modules/@switchboard-proof/foreign/dist/index.d.ts'), declaration);
  writeFileSync(join(consumer, 'alias.ts'), "import type { Foreign } from '@switchboard-proof/declarations';\nexport type Alias = Foreign;\n");
  successful(compile(consumer, ['alias.ts']));
  const linked = successful(compile(consumer, ['alias.ts'], false, false, true)).trim().split('\n');
  assert.throws(() => assertClosure(linked, allowed, [join(consumer, 'alias.ts')]), /Foreign compiler file|symlinks/);
} finally {
  rmSync(declaration, { force: true });
  rmSync(sourceLeak, { force: true });
  writeFileSync(declaration, original);
}
positive();
exactDiagnostics(compile(consumer, ['private.ts']), [
  { file: 'private.ts', line: 1, code: 2307 }, { file: 'private.ts', line: 2, code: 2307 },
]);
const entry = join(installed, 'dist/index.js');
const originalEntry = readFileSync(entry, 'utf8');
try {
  writeFileSync(entry, originalEntry.replace('./helper.js', './missing.js'));
  assert.throws(() => assertEmitted(installed), /Missing emitted relative import/);
} finally {
  writeFileSync(entry, originalEntry);
}
positive();
const contaminated = join(temporary, 'contaminated');
mkdirSync(contaminated);
installPackages(contaminated, [native], tools, npm);
writeFileSync(join(contaminated, 'host.ts'), "import type { Control } from '@anthropic-ai/claude-agent-sdk';\nexport type Result = Control;\n");
successful(compile(contaminated, ['host.ts']));
const contaminatedClosure = successful(compile(contaminated, ['host.ts'], false, false, true)).trim().split('\n');
assert.throws(() => assertCoreIsolation(contaminated, []), /Native dependency resolves/);
assert.throws(() => assertCoreIsolation(contaminated, contaminatedClosure), /Native compiler reference/);
rmSync(join(contaminated, 'node_modules/@anthropic-ai/claude-agent-sdk/dist/index.js'));
assert.throws(() => assertCoreIsolation(contaminated, []), /Installed native dependency/);
positive();
const summary = {
  sourceCommit: successful(command('/usr/bin/git', ['rev-parse', 'HEAD'], root, environment,
    join(evidence, 'source-commit.json'))).trim(),
  node: process.version, npm: '11.19.1', typescript: '7.0.2', nodeTypes: '24.19.2',
  sourceLockSha256: digest(join(root, 'package-lock.json')),
  sourceManifestSha256: digest(join(root, 'package.json')),
  artifacts: [inert, declarations, foreign, native].map(({ path, sha256 }) => ({ path, sha256 })),
  compilerClosure: initialClosure, compiler: 'passed', moduleLoad: 'not run', confinement: 'not claimed',
  passedControls: [
    'strict noDOM and explicitDOM installed consumers', 'owned source and third-party declaration diagnostics',
    'extra/unrelated errors and wrong location/code', 'unexpected output/status/signal/timeout',
    'foreign transitive declaration and source leak', 'symlink declaration', 'private source/output imports',
    'malformed relative emitted import', 'installed/resolvable/reachable native-name controls',
    'positive fixture restoration after every mutation group',
  ],
  sources: readdirSync(fileURLToPath(new URL('./', import.meta.url)), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, sha256: digest(path) };
    }),
};
writeJson(join(evidence, 'summary.json'), summary);
console.log('Installed inert compiler/package controls passed. Native compatibility and confinement are untested.');
