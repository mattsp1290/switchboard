import { contracts, createFakeFixture } from '@mattsp1290/switchboard/testkit';
import type {
  QualificationConnection, QualificationContract, QualificationFactory, QualificationFixture,
} from '@mattsp1290/switchboard/testkit';

export const createFixture: QualificationFactory = async () => {
  const fixture: QualificationFixture = createFakeFixture();
  return {
    samples: fixture.samples,
    controls: fixture.controls,
    connect(recordIntent): QualificationConnection {
      return fixture.connect(recordIntent);
    },
    dispose: fixture.dispose,
  };
};

export const groups: readonly QualificationContract[] = [
  contracts.uncertainty, contracts.sessions, contracts.interaction, contracts.events,
];

export const qualify = (signal: AbortSignal): Promise<void> => contracts.uncertainty(createFixture, signal);
