import { contracts } from '@operatorworks/switchboard/testkit';
import type { QualificationContract } from '@operatorworks/switchboard/testkit';
import { createFixture } from './async-fixture.js';

export const groups: readonly QualificationContract[] = Object.values(contracts);

export const qualify = (signal: AbortSignal): Promise<void> => contracts.uncertainty(createFixture, signal);
