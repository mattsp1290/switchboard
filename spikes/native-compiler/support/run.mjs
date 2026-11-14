import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const encoded = join(temporary, 'encoded');
mkdirSync(join(encoded, 'src'), { recursive: true });
installPackages(encoded, [declarations], tools, npm);
writeJson(join(encoded, 'package.json'), { ...sourceManifest, name: '@switchboard-proof/encoded' });
writeFileSync(join(encoded, 'src/index.ts'), "export { format } from './%68elper.js';\n");
copyFileSync(join(fixtures, 'inert/src/helper.ts'), join(encoded, 'src/%68elper.ts'));
successful(compile(encoded, ['src/index.ts'], false, true));
const encodedArtifact = packPackage(encoded, artifacts, npm);
const encodedConsumer = join(temporary, 'encoded-consumer');
mkdirSync(encodedConsumer);
installPackages(encodedConsumer, [encodedArtifact, declarations], tools, npm);
const encodedInstalled = join(encodedConsumer, 'node_modules/@switchboard-proof/encoded');
const encodedManifest = join(encodedInstalled, 'package.json');
const loadEncoded = () => invoke(['--input-type=module', '-e',
  "import('@switchboard-proof/encoded').catch(error => { console.log(error.code); process.exitCode = 1; })"], encodedConsumer);
const failedEncoded = loadEncoded();
assert.equal(failedEncoded.status, 1);
assert.match(failedEncoded.stdout, /ERR_MODULE_NOT_FOUND/);
assert.throws(() => assertEmitted(encodedInstalled), /Missing emitted relative import/);
for (const [target, accepted] of [['./dist/%68elper.js', false], ['./dist/%2568elper.js', true]]) {
  const manifest = readJson(encodedManifest);
  manifest.exports['.'].import = target;
  writeJson(encodedManifest, manifest);
  assert.equal(loadEncoded().status, accepted ? 0 : 1, target);
  if (accepted) assert.equal(assertEmitted(encodedInstalled).length, 1);
  else assert.throws(() => assertEmitted(encodedInstalled), /Missing emitted relative import/);
}
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
const nestedModules = join(consumer, 'node_modules/@switchboard-proof/declarations/node_modules');
const nestedForeign = join(nestedModules, '@switchboard-proof/foreign');
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
  mkdirSync(nestedForeign, { recursive: true });
  cpSync(join(consumer, 'node_modules/@switchboard-proof/foreign'), nestedForeign, { recursive: true });
  successful(compile(consumer, ['host.ts']));
  const nestedClosure = closure();
  const nestedDeclaration = join(nestedForeign, 'dist/index.d.ts');
  assert(nestedClosure.includes(nestedDeclaration), 'The strict consumer reaches the nested foreign declaration.');
  assert.throws(() => assertClosure(nestedClosure, allowed, [join(consumer, 'host.ts')]), /Foreign compiler file/);
  assert.throws(() => assertCoreIsolation(consumer, nestedClosure, {
    allowedRoots: allowed, allowedFiles: [join(consumer, 'host.ts')],
  }), /Foreign compiler file/);
  for (const policy of [
    { allowedRoots: [...allowed, nestedForeign], allowedFiles: [join(consumer, 'host.ts')] },
    { allowedRoots: allowed, allowedFiles: [join(consumer, 'host.ts'), nestedDeclaration] },
  ]) {
    assertClosure(nestedClosure, policy.allowedRoots, policy.allowedFiles);
    assertCoreIsolation(consumer, nestedClosure, policy);
  }
  rmSync(nestedModules, { recursive: true });
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
  rmSync(nestedModules, { recursive: true, force: true });
  writeFileSync(declaration, original);
}
positive();
exactDiagnostics(compile(consumer, ['private.ts']), [
  { file: 'private.ts', line: 1, code: 2307 }, { file: 'private.ts', line: 2, code: 2307 },
]);
const entry = join(installed, 'dist/index.js');
const originalEntry = readFileSync(entry, 'utf8');
const originalManifest = readFileSync(join(installed, 'package.json'), 'utf8');
const outside = join(installed, '../../outside.js');
writeFileSync(outside, 'export const inert = true;\n');
const urlMatrix = [
  ['./helper.js', true, 0], ['./%68elper.js', true, 0], ['./helper%2ejs', true, 0],
  ['./helper.js?query', false, 0], ['./helper.js#fragment', false, 0],
  ['./%2fhelper.js', false, 1], ['./%5chelper.js', false, 1], ['./%ZZ.js', false, 1],
  ['./../../../outside.js', false, 0], [outside, false, 0], [pathToFileURL(outside).href, false, 0],
  ['https://example.invalid/helper.js', false, 1], ['data:text/javascript,export default 1', false, 0],
  ['#private', false, 1], ['.hidden.js', false, 1], ['node:path', true, 0], ['node:missing', false, 1],
];
try {
  for (const [specifier, accepted, status] of urlMatrix) {
    writeFileSync(entry, `${originalEntry}\nimport ${JSON.stringify(specifier)};\n`);
    const result = invoke(['--input-type=module', '-e',
      'import(process.argv[1]).catch(error => { console.log(error.code ?? error.name); process.exitCode = 1; })',
      pathToFileURL(entry).href], consumer);
    assert.equal(result.status, status, `${specifier}: ${result.stdout}${result.stderr}`);
    if (accepted) assert.equal(assertEmitted(installed).length, 2, specifier);
    else assert.throws(() => assertEmitted(installed), undefined, specifier);
  }
  writeFileSync(entry, `${originalEntry}\nimport '@switchboard-proof/declarations';\n`);
  assert.equal(assertEmitted(installed).length, 2, 'Bare public packages remain for later loader acceptance.');
  writeFileSync(entry, originalEntry);
  for (const target of [
    './dist/index.js?query', './dist/index.js#fragment', './dist/%2findex.js', './dist/%5cindex.js',
    './dist/../dist/index.js', './dist/%2e%2e/dist/index.js', './dist/node_modules/index.js',
    '../inert/dist/index.js', entry, pathToFileURL(entry).href, 'https://example.invalid/index.js',
  ]) {
    const manifest = JSON.parse(originalManifest);
    manifest.exports['.'].import = target;
    writeJson(join(installed, 'package.json'), manifest);
    assert.throws(() => assertEmitted(installed), undefined, target);
  }
  writeFileSync(join(installed, 'package.json'), originalManifest);
  writeFileSync(entry, originalEntry.replace('./helper.js', './missing.js'));
  assert.throws(() => assertEmitted(installed), /Missing emitted relative import/);
  for (const expression of [
    "import('./helper.js' + '.missing')", "import('' + './missing.js')", 'import(specifier)',
    "import(`./helper.js`)", "import(('./helper.js'))", "import('./helper.js', {})",
    "import('./helper.js' /* trailing */)", "import(/* leading */ './helper.js')",
    "import /* between */ ('./helper.js')", "import('./helper.js' // trailing\n)",
    String.raw`import('./helper\u002ejs')`, String.raw`import('./helper.js\' + suffix')`,
  ]) {
    writeFileSync(entry, `${originalEntry}\nexport const load = () => ${expression};\n`);
    assert.throws(() => assertEmitted(installed), /Dynamic imports|Commented import syntax/, expression);
  }
  for (const syntax of [
    "import './missing.js';", 'export * from "./missing.js";', "export const load = () => import('./missing.js');",
  ]) {
    writeFileSync(entry, `${originalEntry}\n${syntax}\n`);
    assert.throws(() => assertEmitted(installed), /Missing emitted relative import/, syntax);
  }
  for (const syntax of [String.raw`import './helper\u002ejs';`, String.raw`export * from './helper.js\' + suffix';`]) {
    writeFileSync(entry, `${originalEntry}\n${syntax}\n`);
    assert.throws(() => assertEmitted(installed), /Emitted imports require complete unescaped/, syntax);
  }
  writeFileSync(entry, `${originalEntry}\nimport './helper.js';\nexport * from "./helper.js";
export const load = () => import('./helper.js');
export const loadDouble = () => import( "./helper.js" );\n`);
  assert.equal(assertEmitted(installed).length, 2, 'Quoted static, re-export and dynamic imports reach the helper.');
} finally {
  writeFileSync(entry, originalEntry);
  writeFileSync(join(installed, 'package.json'), originalManifest);
  rmSync(outside, { force: true });
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
  artifacts: [inert, declarations, foreign, native, encodedArtifact].map(({ path, sha256 }) => ({ path, sha256 })),
  compilerClosure: initialClosure, compiler: 'passed', moduleLoad: 'inert URL controls only; native not run', confinement: 'not claimed',
  passedControls: [
    'strict noDOM and explicitDOM installed consumers', 'owned source and third-party declaration diagnostics',
    'extra/unrelated errors and wrong location/code', 'unexpected output/status/signal/timeout',
    'foreign transitive declaration and source leak', 'nested foreign declaration and explicit root/file admission',
    'symlink declaration', 'private source/output imports',
    'strict compiled packed installed percent-filename rejection and decoded public export targets',
    'Node ESM URL matrix and owned graph containment', 'unsupported import forms and exact public export targets',
    'malformed relative emitted import', 'computed/commented/escaped emitted import rejection',
    'quoted static/re-export/dynamic emitted imports', 'installed/resolvable/reachable native-name controls',
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
