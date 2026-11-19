import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NATIVE_SDK_PACKAGES } from './support/native-sdk-tripwire.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tripwire = fileURLToPath(new URL('./support/native-sdk-tripwire.mjs', import.meta.url));
const load = (specifier) => spawnSync(process.execPath, ['--import', tripwire, '--input-type=module', '-e',
  `try { await import(${JSON.stringify(specifier)}); console.log('loaded'); } catch (error) { console.log(error.code); }`],
  { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });

test('this test process runs under the native SDK tripwire', () => {
  assert(process.execArgv.some((arg) => arg.includes('native-sdk-tripwire.mjs')), 'run the ordinary suite with npm test');
});

test('a native SDK load fails the process even when the error is caught', () => {
  for (const name of ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', '@earendil-works/pi-coding-agent']) {
    assert(NATIVE_SDK_PACKAGES.includes(name));
    const result = load(name);
    assert.equal(result.stdout.trim(), 'ERR_SWITCHBOARD_NATIVE_SDK_TRIPWIRE', name);
    assert.match(result.stderr, new RegExp(`native SDK tripwire: ${name} loaded outside`));
    assert.equal(result.status, 1, name);
  }
});

test('other packages load normally under the tripwire', () => {
  const result = load('ajv');
  assert.equal(result.stdout.trim(), 'loaded');
  assert.equal(result.status, 0);
});
