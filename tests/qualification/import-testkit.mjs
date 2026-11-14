import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { qualificationGroups } from './groups.mjs';
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (context.parentURL?.includes('/dist/testkit/')) {
    assert(resolved.url.startsWith('node:') || resolved.url.startsWith(new URL('./', context.parentURL).href)
      || resolved.url === new URL('../index.js', context.parentURL).href, 'Testkit must use the public core entry.');
    assert(!resolved.url.includes('/agui/'), 'Testkit cannot import AG-UI.');
    assert.notEqual(resolved.url, 'node:test', 'Testkit cannot import a test runner.');
  }
  return resolved;
} });
const { contracts, createFakeFixture } = await import('@mattsp1290/switchboard/testkit');
assert.deepEqual(Object.keys(contracts), qualificationGroups);
assert(Object.isFrozen(contracts), 'The public scenario registry is immutable.');
await createFakeFixture().dispose();
