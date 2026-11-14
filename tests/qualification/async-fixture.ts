import { createFakeFixture } from '@mattsp1290/switchboard/testkit';
import type {
  QualificationConnection, QualificationFactory, QualificationFixture,
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

