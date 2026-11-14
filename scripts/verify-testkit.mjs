import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runNpm, testEnvironment } from './support/exec.mjs';
import { assertCoreIsolation } from '../spikes/native-compiler/support/package.mjs';
import { compilerLibraryRoots, nodeDeclarationRoots } from '../spikes/native-compiler/support/compiler.mjs';
import { qualificationGroups, qualificationSupportFiles, qualificationTypeFixtures } from '../tests/qualification/groups.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

export function verifyTestkit({ consumer, tarball, compiler, compilerOptions }) {
  const runtimeEnvironment = testEnvironment();
  mkdirSync(join(consumer, 'qualification'), { recursive: true });
  const qualificationConsumers = readdirSync(join(root, 'tests/qualification')).filter((name) => name.endsWith('.consumer.mjs'));
  for (const file of [...qualificationConsumers, ...qualificationTypeFixtures, ...qualificationSupportFiles]) {
    copyFileSync(join(root, 'tests/qualification', file), join(consumer, 'qualification', file));
  }
  assert(qualificationConsumers.length > 0, 'Installed qualification consumers exist.');
  const qualificationFixtures = qualificationConsumers.sort().map((file) => `qualification/${file}`);
  const runtimeOutput = run(process.execPath, ['--test', '--test-reporter=tap', ...qualificationFixtures], consumer, runtimeEnvironment);
  for (const name of qualificationGroups) {
    assert.match(runtimeOutput, new RegExp(`^ok \\d+ - fake qualification: ${RegExp.escape(name)}$`, 'm'));
    assert.match(runtimeOutput, new RegExp(`^ok \\d+ - async fake qualification: ${RegExp.escape(name)}$`, 'm'));
  }
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects recovery dispatch$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects false certainty$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects async close promise replacement$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects effect-derived delivery$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects ignored subscription abort$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification isolates rejected continuation inputs$/m);
  process.stdout.write(runtimeOutput);
  const installed = join(consumer, 'node_modules', ...manifest.name.split('/'));
  const qualificationTypes = [...qualificationTypeFixtures, ...qualificationSupportFiles].map(file => `qualification/${file}`);
  writeFileSync(join(consumer, 'testkit.json'), JSON.stringify({
    compilerOptions, files: qualificationTypes,
  }));
  const kitTypes = run(process.execPath, [compiler, '-p', 'testkit.json', '--listFilesOnly'], consumer);
  assert(!kitTypes.includes('/agui/') && !kitTypes.includes('/@ag-ui/'), 'Testkit types have no AG-UI dependency.');
  assertCoreIsolation(consumer, kitTypes.trim().split('\n'), {
    allowedRoots: [...compilerLibraryRoots(root), ...nodeDeclarationRoots(consumer), installed],
    allowedFiles: qualificationTypes.map(file => join(consumer, file)),
  });
  run(process.execPath, [compiler, '-p', 'testkit.json'], consumer);
  const importOutput = run(process.execPath, ['--test-reporter=tap', 'qualification/import-testkit.mjs'], consumer, runtimeEnvironment);
  assert.doesNotMatch(importOutput, /^# tests [1-9]\d*$/m, 'Importing testkit does not register tests.');
  console.log('Verified installed testkit factory declarations, isolation, and import without test registration.');

  const aliasConsumer = join(dirname(consumer), 'alias-consumer');
  const alias = '@mattsp1290/switchboard-qualification';
  mkdirSync(aliasConsumer);
  writeFileSync(join(aliasConsumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  process.stdout.write(runNpm([
    'install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund',
    `${alias}@file:${tarball}`,
    `@types/node@${manifest.devDependencies['@types/node']}`,
  ], aliasConsumer));
  assert(!existsSync(join(aliasConsumer, 'node_modules', ...manifest.name.split('/'))), 'Alias has no separately installed core.');
  assert(!existsSync(join(aliasConsumer, 'node_modules/@ag-ui/core')), 'Alias consumer has no SDK.');
  writeFileSync(join(aliasConsumer, 'qualification.mjs'), readFileSync(join(root, 'tests/qualification/alias.mjs'), 'utf8')
    .replaceAll(`${manifest.name}/testkit`, `${alias}/testkit`));
  const aliasOutput = run(process.execPath, ['--test', '--test-reporter=tap', 'qualification.mjs'], aliasConsumer, runtimeEnvironment);
  assert.match(aliasOutput, new RegExp(`^# tests ${qualificationGroups.length}$`, 'm'));
  for (const name of qualificationGroups) {
    assert.match(aliasOutput, new RegExp(`^ok \\d+ - alias qualification: ${RegExp.escape(name)}$`, 'm'));
  }
  process.stdout.write(aliasOutput);
  for (const file of qualificationTypeFixtures) {
    writeFileSync(join(aliasConsumer, file), readFileSync(join(root, 'tests/qualification', file), 'utf8')
      .replaceAll(`${manifest.name}/testkit`, `${alias}/testkit`));
  }
  writeFileSync(join(aliasConsumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions, files: [...qualificationTypeFixtures, 'qualification.mjs'],
  }));
  run(process.execPath, [compiler, '-p', 'tsconfig.json'], aliasConsumer);
  console.log('Verified dev-only artifact alias without a separate canonical core install.');
}

export function testkitInvalidCases(name) {
  const testkitImports = `import type { QualificationFixture, QualificationConnection } from '${name}/testkit'; import { contracts, createFakeFixture } from '${name}/testkit';`;
  return [
    ['contracts-readonly', `${testkitImports} contracts.uncertainty = contracts.events;`, 2540],
    ['contract-factory-missing-dispose', `${testkitImports} const { dispose, ...fixture } = createFakeFixture(); contracts.uncertainty(() => fixture, new AbortController().signal);`, 2322],
    ['fake-observer-publish', `${testkitImports} createFakeFixture().connect(() => {}).events.publish({ kind: 'progress', sequence: 1 });`, 2339],
    ['fixture-missing-dispose', `${testkitImports} const { dispose, ...fixture } = createFakeFixture(); const invalid: QualificationFixture = fixture;`, 2741],
    ['fixture-publish-only', `${testkitImports} const fixture = createFakeFixture(); const connection = fixture.connect(() => {}); const invalid: QualificationConnection = { ...connection, events: { publish() {} } };`, 2353],
    ['fixture-recovery-run', `${testkitImports} declare const saved: Parameters<QualificationConnection['recover']>[0]; createFakeFixture().connect(() => {}).recover(saved).run();`, 2339],
    ['fixture-submit-unknown-code', `${testkitImports} const fixture = createFakeFixture(); const connection = fixture.connect(() => {}); const invalid: QualificationConnection = { ...connection, async submit() { return { kind: 'error', error: { code: 'conflict' } }; } };`, 2322],
    ['fixture-close-unknown-code', `${testkitImports} const fixture = createFakeFixture(); const connection = fixture.connect(() => {}); const invalid: QualificationConnection = { ...connection, async close() { return { kind: 'error', error: { code: 'conflict' } }; } };`, 2322],
    ['fixture-recovery-undispatched', `${testkitImports} const connection = createFakeFixture().connect(() => {}); declare const saved: Parameters<QualificationConnection['recover']>[0]; connection.recover({ ...saved, observation: { kind: 'not-dispatched', reason: 'aborted' } });`, 2322],
  ];
}
