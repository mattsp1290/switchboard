import test from 'node:test';
import { contracts } from '@mattsp1290/switchboard/testkit';
import { createFixture } from './fixture.test.ts';

for (const [name, contract] of Object.entries(contracts)) {
  test(`async fake qualification: ${name}`, { timeout: 10_000 }, (t) =>
    contract(createFixture, t.signal));
}
