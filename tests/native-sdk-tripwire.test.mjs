import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NATIVE_SDK_PACKAGES } from './support/native-sdk-tripwire.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tripwire = fileURLToPath(new URL('./support/native-sdk-tripwire.mjs', import.meta.url));
const probes = [];
const created = [];
// A package with no built entry never reaches the load hook. Point at a file under its directory.
const specifier = (name) => {
  const dir = join(root, 'node_modules', ...name.split('/'));
  if (!existsSync(join(dir, 'package.json'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, type: 'module' })}\n`);
    writeFileSync(join(dir, 'switchboard-tripwire-probe.mjs'), 'export {};\n');
    created.push(dir);
    return pathToFileURL(join(dir, 'switchboard-tripwire-probe.mjs')).href;
  }
  if (name === '@openai/codex') return pathToFileURL(join(dir, 'bin/codex.js')).href;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const target = pkg.exports?.['.'];
  const rel = typeof target === 'string' ? target : target?.import || pkg.module || pkg.main;
  if (typeof rel === 'string' && existsSync(join(dir, rel))) return name;
  const probe = join(dir, 'switchboard-tripwire-probe.mjs');
  writeFileSync(probe, 'export {};\n');
  probes.push(probe);
  return pathToFileURL(probe).href;
};
process.on('exit', () => { for (const dir of created) rmSync(dir, { recursive: true, force: true }); });
const load = (specifier) => spawnSync(process.execPath, ['--import', tripwire, '--input-type=module', '-e',
  `try { await import(${JSON.stringify(specifier)}); console.log('loaded'); } catch (error) { console.log(error.code); }`],
  { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });

test('this test process runs under the native SDK tripwire', () => {
  assert(process.execArgv.some((arg) => arg.includes('native-sdk-tripwire.mjs')), 'run the ordinary suite with npm test');
});

test('a native SDK load fails the process even when the error is caught', () => {
  try {
    for (const name of ['@cursor/sdk', '@cursor/sdk-darwin-arm64', '@cursor/sdk-darwin-x64', '@cursor/sdk-linux-arm64', '@cursor/sdk-linux-x64', '@cursor/sdk-win32-x64']) {
      assert.equal(NATIVE_SDK_PACKAGES.includes(name), true, name);
    }
    for (const name of NATIVE_SDK_PACKAGES) {
      const result = load(specifier(name));
      assert.equal(result.stdout.trim(), 'ERR_SWITCHBOARD_NATIVE_SDK_TRIPWIRE', name);
      assert.match(result.stderr, new RegExp(`native SDK tripwire: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} loaded outside`));
      assert.equal(result.status, 1, name);
    }
  } finally {
    for (const probe of probes.splice(0)) rmSync(probe, { force: true });
  }
});

test('clearing exitCode after a caught native SDK import still fails under node --test', () => {
  const dir = mkdtempSync(join(root, 'switchboard-tripwire-'));
  const file = join(dir, 'clear.test.mjs');
  writeFileSync(file, `
    import test from 'node:test';
    const names = ${JSON.stringify(NATIVE_SDK_PACKAGES.map((name) => specifier(name)))};
    test('catch and clear', async () => {
      for (const name of names) {
        try { await import(name); } catch { /* the tripwire must still fail the process */ }
      }
      process.exitCode = 0;
    });
  `);
  try {
    const result = spawnSync(process.execPath, ['--import', tripwire, '--test', file], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH },
    });
    assert.match(`${result.stderr}\n${result.stdout}`, /native SDK tripwire:/);
    assert.equal(result.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const probe of probes.splice(0)) rmSync(probe, { force: true });
  }
});

test('other packages load normally under the tripwire', () => {
  const result = load('ajv');
  assert.equal(result.stdout.trim(), 'loaded');
  assert.equal(result.status, 0);
});
