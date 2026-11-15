import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { currentProducerIdentity, prepareProducerArtifact, root, validateFixtureOrigin } from '../scripts/support/observability-backends.mjs';

test('handoff identity uses the real build and pack without running the producer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-observability-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  const staged = join(directory, 'staged');
  for (const path of ['src', 'adapters/example/src', 'scripts', '.audit/llm-observability']) {
    await mkdir(join(project, path), { recursive: true });
  }
  await mkdir(staged);
  await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
  await cp(join(root, 'scripts/support'), join(project, 'scripts/support'), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({
    name: 'observability-artifact-test', version: '1.0.0', private: true, type: 'module', files: ['dist'],
    scripts: { build: 'tsc -p tsconfig.json && tsc -p adapters/example/tsconfig.json' },
  }));
  const compilerConfig = { compilerOptions: { target: 'ES2022', module: 'NodeNext', types: [],
    rootDir: 'src', outDir: 'dist', removeComments: false }, include: ['src'] };
  const writeConfig = config => writeFile(join(project, 'tsconfig.json'), JSON.stringify(config));
  await writeConfig(compilerConfig);
  await writeFile(join(project, 'adapters/example/tsconfig.json'), JSON.stringify({
    extends: '../../tsconfig.json', compilerOptions: { rootDir: 'src', outDir: '../../dist/example' }, include: ['src'],
  }));
  await writeFile(join(project, 'src/index.ts'), '// This comment is part of the emitted artifact.\nexport const value = 1;\n');
  const adapter = join(project, 'adapters/example/src/index.ts');
  await writeFile(adapter, 'export const adapter = 1;\n');
  const recipe = join(project, 'scripts/support/observability-producer.mjs');
  await writeFile(recipe, `throw new Error('Identity checks must never install or run the producer');\n${await readFile(recipe, 'utf8')}`);

  const { tarball, ...identity } = await prepareProducerArtifact(staged, project);
  assert.equal(identity.tarballSha256, createHash('sha256').update(await readFile(tarball)).digest('hex'));
  const fixture = { ...identity, scenarios: [] };
  const origin = { ...fixture, status: 'passed' };

  await t.test('unchanged output stays stable and generated receipts do not enter either fingerprint', async () => {
    await writeFile(join(project, '.audit/llm-observability/fixture.json'), JSON.stringify(fixture));
    const current = await currentProducerIdentity(project);
    assert.deepEqual(current, identity);
    assert.doesNotThrow(() => validateFixtureOrigin(fixture, origin, current));
  });

  await t.test('an emission-changing compiler option invalidates the previous artifact', async () => {
    await writeConfig({ ...compilerConfig, compilerOptions: { ...compilerConfig.compilerOptions, removeComments: true } });
    const current = await currentProducerIdentity(project);
    assert(!String(await readFile(join(project, 'dist/index.js'))).includes('This comment'));
    assert.equal(current.producerDigest, identity.producerDigest);
    assert.throws(() => validateFixtureOrigin(fixture, origin, current), /packed artifact changed/);
    await writeConfig(compilerConfig);
  });

  await t.test('a compiled adapter source change invalidates the previous artifact', async () => {
    await writeFile(adapter, 'export const adapter = 2;\n');
    const current = await currentProducerIdentity(project);
    assert.match(await readFile(join(project, 'dist/example/index.js'), 'utf8'), /adapter = 2/);
    assert.equal(current.producerDigest, identity.producerDigest);
    assert.throws(() => validateFixtureOrigin(fixture, origin, current), /packed artifact changed/);
    await writeFile(adapter, 'export const adapter = 1;\n');
  });

  await t.test('a producer recipe change has its own identity and cannot change already staged bytes', async () => {
    const previousRecipe = await readFile(join(staged, 'observability-producer.mjs'));
    await writeFile(recipe, String(previousRecipe).replace('@opentelemetry/api@1.9.0', '@opentelemetry/api@0.0.0'));
    const current = await currentProducerIdentity(project);
    assert.equal(current.tarballSha256, identity.tarballSha256);
    assert.deepEqual(await readFile(join(staged, 'observability-producer.mjs')), previousRecipe);
    assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), identity.tarballSha256);
    assert.throws(() => validateFixtureOrigin(fixture, origin, current), /producer changed/);
  });
});
