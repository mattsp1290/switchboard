import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertClosure, command, inside, successful } from './compiler.mjs';

export const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

export function npmEnvironment(temporary) {
  const user = join(temporary, 'user.npmrc');
  const global = join(temporary, 'global.npmrc');
  writeFileSync(user, '');
  writeFileSync(global, '');
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary,
    npm_config_userconfig: user, npm_config_globalconfig: global,
    npm_config_cache: join(temporary, 'cache'), npm_config_registry: 'https://registry.npmjs.org/',
  };
}

export function npmCommand(npmCli, env, evidence) {
  assert(isAbsolute(npmCli) && existsSync(npmCli), 'Pass an absolute npm CLI path.');
  let index = 0;
  return (args, cwd) => successful(command(process.execPath, [npmCli, ...args], cwd, env,
    join(evidence, `npm-${++index}.json`)));
}

export function installTools(root, target, npm) {
  mkdirSync(target);
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, file), join(target, file));
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], target);
  assert.equal(digest(join(root, 'package-lock.json')), digest(join(target, 'package-lock.json')));
  const ts = readJson(join(target, 'node_modules/typescript/package.json'));
  assert.equal(ts.version, '7.0.2');
  assert.equal(readJson(join(target, 'node_modules/@types/node/package.json')).version, '24.19.2');
  return resolve(target, 'node_modules/typescript', ts.bin.tsc);
}

export function packPackage(project, artifacts, npm) {
  const manifest = readJson(join(project, 'package.json'));
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts], project));
  assert.equal(packed.length, 1);
  const [metadata] = packed;
  assert.equal(metadata.name, manifest.name);
  assert.equal(metadata.version, manifest.version);
  assert(metadata.files.every(({ path }) => path === 'package.json' || /^dist\/.+\.(?:js|d\.ts)$/.test(path)));
  for (const entry of Object.values(manifest.exports)) {
    for (const target of [entry.types, entry.import].filter(Boolean)) {
      assert(target.startsWith('./dist/'));
      assert(metadata.files.some(({ path }) => path === target.slice(2)), `Missing export: ${target}`);
    }
  }
  const path = join(artifacts, metadata.filename);
  const artifact = { path, sha256: digest(path), metadata, exports: manifest.exports, manifest };
  writeJson(`${path}.json`, artifact);
  return artifact;
}

export function installPackages(project, artifacts, tools, npm) {
  const dependencies = Object.fromEntries(artifacts.map(({ path, metadata }) => [metadata.name, `file:${path}`]));
  dependencies['@types/node'] = '24.19.2';
  writeJson(join(project, 'package.json'), { private: true, type: 'module', dependencies });
  const original = readJson(join(tools, 'package-lock.json')).packages;
  const packages = { '': { dependencies } };
  const addRegistry = (name, parent = '') => {
    let ancestor = parent;
    let key;
    while (true) {
      key = `${ancestor ? ancestor + '/' : ''}node_modules/${name}`;
      if (original[key]) break;
      assert(ancestor, `Dependency missing from committed graph: ${name}`);
      ancestor = ancestor.replace(/(?:^|\/)node_modules\/[^/]+(?:\/[^/]+)?$/, '');
    }
    if (packages[key]) return;
    packages[key] = original[key];
    for (const dependency of Object.keys(original[key].dependencies ?? {})) addRegistry(dependency, key);
  };
  addRegistry('@types/node');
  for (const { path, metadata, manifest } of artifacts) {
    packages[`node_modules/${metadata.name}`] = {
      version: manifest.version, resolved: `file:${path}`, integrity: metadata.integrity,
      ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
      ...(manifest.peerDependencies ? { peerDependencies: manifest.peerDependencies } : {}),
    };
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!(name in dependencies)) addRegistry(name);
    }
  }
  writeJson(join(project, 'package-lock.json'), { lockfileVersion: 3, requires: true, packages });
  npm(['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], project);
  const realized = readJson(join(project, 'package-lock.json')).packages;
  for (const [path, record] of Object.entries(realized)) {
    if (!path || record.resolved?.startsWith('file:')) continue;
    assert.deepEqual([record.version, record.resolved, record.integrity],
      [original[path]?.version, original[path]?.resolved, original[path]?.integrity], `Registry graph changed: ${path}`);
  }
  npm(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], project);
  for (const { path, sha256, metadata, exports } of artifacts) {
    assert.equal(digest(path), sha256);
    const installed = join(project, 'node_modules', metadata.name);
    assert.equal(realpathSync(installed), installed, 'No package workspace links.');
    assert.deepEqual(readJson(join(installed, 'package.json')).exports, exports);
  }
}

const nativeNames = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core', '@openai/codex-sdk', '@openai/codex', '@modelcontextprotocol/sdk'];

export function assertCoreIsolation(project, closure = [], closurePolicy) {
  const require = createRequire(join(project, 'package.json'));
  for (const name of nativeNames) {
    assert(!closure.some((file) => file.replaceAll('\\', '/').includes(`/node_modules/${name}/`)), `Native compiler reference: ${name}`);
    assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' }, `Native dependency resolves: ${name}`);
  }
  if (closure.length) assertClosure(closure, closurePolicy.allowedRoots, closurePolicy.allowedFiles);
  const modules = join(project, 'node_modules');
  if (!existsSync(modules)) return;
  for (const path of readdirSync(modules, { recursive: true })) {
    if (!path.endsWith('package.json')) continue;
    const file = join(modules, path);
    assert(inside(realpathSync(file), modules), 'Installed package files cannot escape node_modules.');
    assert(!nativeNames.includes(readJson(file).name), `Installed native dependency: ${path}`);
  }
}
