import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import type { ProjectionEvent } from '@mattsp1290/switchboard/agui';

export function collectEvents(
  name: string,
  events: readonly ProjectionEvent[],
  origin: 'sdk-sentinel' | 'switchboard-projection' = 'switchboard-projection',
): void {
  const target = process.env.AGUI_COLLECTOR_PATH;
  assert(target, 'Installed tests require an explicit event collector path.');
  assert(events.length > 0, `${name} must collect actual output.`);
  for (const [index, value] of events.entries()) {
    appendFileSync(target, JSON.stringify({
      path: `${name}/${index}`, definition: 'Event', value,
      expected: true, ts: true, py: true, origin,
    }) + '\n');
  }
}
