import { createFakeFixture } from '@operatorworks/switchboard/testkit';
import type {
  QualificationFactory, QualificationFixture,
} from '@operatorworks/switchboard/testkit';

export const createFixture: QualificationFactory = async () => {
  const fixture: QualificationFixture = createFakeFixture();
  return {
    samples: fixture.samples,
    controls: fixture.controls,
    connect: fixture.connect,
    dispose: fixture.dispose,
  };
};
