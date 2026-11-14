import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { EventType, omitOptionalNulls, PROTOCOL_VERSION } from '@ag-ui/core';
import type { RunStartedEvent } from '@ag-ui/core';
import * as integration from '@mattsp1290/switchboard/agui';
import { collectEvents } from './collector.js';

const require = createRequire(import.meta.url);

test('installed metadata matches the canonical pin without optional Zod', () => {
  const pin = JSON.parse(readFileSync(new URL('../ag-ui-pin.json', import.meta.url), 'utf8'));
  assert.deepEqual(integration.aguiProtocol, {
    version: pin.protocol,
    sourceCommit: pin.sourceCommit,
    typescriptSdk: pin.artifacts[0].version,
    pythonSdk: pin.artifacts[1].version,
    mapping: pin.classification.switchboardMapping,
    planned: 'advanced',
  });
  assert.equal(integration.aguiProtocol.version, PROTOCOL_VERSION);
  assert(Object.isFrozen(integration.aguiProtocol));
  assert.throws(() => require.resolve('zod'), { code: 'MODULE_NOT_FOUND' });
});

test('SDK sentinel exercises collection and is not Switchboard mapping evidence', () => {
  const value = omitOptionalNulls({
    type: EventType.RUN_STARTED,
    threadId: 'sdk-sentinel-thread',
    runId: 'sdk-sentinel-run',
  } satisfies RunStartedEvent, 'Event');
  assert.equal(value.type, EventType.RUN_STARTED);
  collectEvents('sdk-sentinel/run-started', [value], 'sdk-sentinel');
});
