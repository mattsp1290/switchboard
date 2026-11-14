import test from 'node:test';
import { contracts, createFakeFixture } from '@mattsp1290/switchboard/testkit';
for (const [name, contract] of Object.entries(contracts)) {
  test('alias qualification: ' + name, { timeout: 10000 }, (t) => contract(createFakeFixture, t.signal));
}
