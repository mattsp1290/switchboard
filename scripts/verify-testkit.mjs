import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCoreIsolation } from '../spikes/native-compiler/support/package.mjs';
import { compilerLibraryRoots, nodeDeclarationRoots } from '../spikes/native-compiler/support/compiler.mjs';
import { qualificationGroups, qualificationSupportFiles, qualificationTypeFixtures } from '../tests/qualification/groups.mjs';

export function verifyTestkit({ root, consumer, temporary, tarball, compiler, compilerOptions, manifest,
  run, runNpm, runtimeEnvironment }) {
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

  const aliasConsumer = join(temporary, 'alias-consumer');
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
  console.log('Verified dev-only artifact alias with package self-reference and no canonical core install.');
}
