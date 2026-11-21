import test from 'node:test';
import { contracts } from '@operatorworks/switchboard/testkit';
import { createFixture } from './async-fixture.ts';

for (const [name, contract] of Object.entries(contracts)) {
  test(`async fake qualification: ${name}`, { timeout: 10_000 }, (t) =>
    contract(createFixture, t.signal));
}
