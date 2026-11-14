import { contracts } from '@mattsp1290/switchboard/testkit';
import type { QualificationContract } from '@mattsp1290/switchboard/testkit';
import { createFixture } from './async-fixture.js';

export const groups: readonly QualificationContract[] = Object.values(contracts);

export const qualify = (signal: AbortSignal): Promise<void> => contracts.uncertainty(createFixture, signal);
