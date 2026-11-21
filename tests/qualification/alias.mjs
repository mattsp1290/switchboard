import test from 'node:test';
import { contracts, createFakeFixture } from '@operatorworks/switchboard/testkit';
for (const [name, contract] of Object.entries(contracts)) {
  test(`alias qualification: ${name}`, { timeout: 10_000 }, (t) => contract(createFakeFixture, t.signal));
}
