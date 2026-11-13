import test from 'node:test';

test('packed package supports ESM and TypeScript consumers', async () => {
  await import('../scripts/verify-package.mjs');
});
