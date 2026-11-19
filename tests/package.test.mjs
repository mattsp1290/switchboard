import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('packed package supports ESM and TypeScript consumers', async () => {
  await import('../scripts/verify-package.mjs');
  const read = (path) => readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8');
  const declarations = read('index.d.ts');
  for (const name of ['HostAdapter', 'HostAdapterCapabilities', 'HostAdapterError', 'HostAdapterEvent', 'HostAdapterRegistration',
    'HostContinueInput', 'HostEnvironment', 'HostFingerprintApi', 'HostInspectApi', 'HostInterruptResult', 'HostLaunch',
    'HostOpenOptions', 'HostResume', 'HostRunInput', 'HostSegmentRequest', 'HostSegmentResult', 'HostToolCall',
    'HostToolDeclaration', 'HostUsage', 'HostWriteStatus', 'HostRouteCredential']) {
    assert.match(declarations, new RegExp(`\\b${name}\\b`), `${name} is a root type export`);
  }
  assert.doesNotMatch(read('index.js'), /host-adapter/, 'the root entry imports no host-adapter module at run time');
  assert.doesNotMatch(read('core/host-adapter.js'), /\bimport\b/, 'the contract module loads nothing at run time');
  assert.doesNotMatch(read('core/host-adapter.d.ts'), /adapters\/|@anthropic-ai|@openai|@earendil-works|@ag-ui/,
    'the contract declarations reference no adapter or native SDK');
});
