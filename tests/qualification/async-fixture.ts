import { createFakeFixture } from '@mattsp1290/switchboard/testkit';
import type {
  QualificationFactory, QualificationFixture,
} from '@mattsp1290/switchboard/testkit';

export const createFixture: QualificationFactory = async () => {
  const fixture: QualificationFixture = createFakeFixture();
  return {
    samples: fixture.samples,
    controls: fixture.controls,
    connect: fixture.connect,
    dispose: fixture.dispose,
  };
};

