import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditDispositions } from '../scripts/audit-agui-dispositions.mjs';

const readRows = path => readFileSync(new URL(path, import.meta.url), 'utf8').trimEnd()
  .split('\n').slice(1).map(line => line.split('\t'));
const definitions = readRows('../docs/protocol/ag-ui-matrix.tsv');
const dispositions = readRows('../docs/protocol/ag-ui-dispositions.tsv');
const explicit = dispositions.filter(([, kind]) => kind === 'implemented').map(([, , type]) => type);
const childOutcomes = [undefined, { type: 'success' }, { type: 'suspended' },
  { type: 'suspended', interruptIds: [] }, { type: 'suspended', interruptIds: ['interrupt'] }];
const evidence = value => ({ origin: 'switchboard-projection', value });
const emitted = [
  ...explicit.filter(type => type !== 'SUBAGENT_FINISHED').map(type => evidence({ type })),
  ...childOutcomes.map(outcome => evidence({ type: 'SUBAGENT_FINISHED', ...(outcome ? { outcome } : {}) })),
];
const audit = changes => auditDispositions({ definitions, dispositions, emitted, ...changes });

test('exact declaration inventory works without emitted evidence', () => {
  audit({ emitted: undefined });
  audit();
});

for (const [label, mutate, message] of [
  ['missing', rows => rows.slice(1), /Missing disposition definitions/],
  ['duplicate', rows => [...rows, rows[0]], /Duplicate disposition: Event/],
  ['unknown', rows => [...rows, ['Unknown', 'declaration', 'RunAgentInput', 'Invalid definition.']], /Unknown disposition: Unknown/],
  ['invalid kind', rows => rows.map((row, index) => index ? row : [row[0], 'planned', ...row.slice(2)]), /Invalid disposition: Event/],
  ['missing rationale', rows => rows.map((row, index) => index ? row : [...row.slice(0, 3), '']), /Missing rationale: Event/],
  ['invalid carrier', rows => rows.map((row, index) => index ? row : [row[0], row[1], 'UNKNOWN', row[3]]), /Invalid carriers: Event/],
]) {
  test(`audit rejects ${label} disposition`, () => {
    assert.throws(() => audit({ dispositions: mutate(dispositions) }), message);
  });
}

test('every implemented event requires actual projection evidence', () => {
  assert.equal(explicit.length, 28);
  for (const type of explicit) {
    const removed = emitted.filter(item => item.value.type !== type);
    assert.throws(() => audit({ emitted: removed }), /Implemented event output coverage/, `Removed ${type}`);
    const sentinel = emitted.map(item => item.value.type === type ? { ...item, origin: 'sdk-sentinel' } : item);
    assert.throws(() => audit({ emitted: sentinel }), /Implemented event output coverage/, `Sentinel ${type}`);
  }
  assert.throws(() => audit({ emitted: emitted.map(item => ({ ...item, origin: 'upstream-fixture' })) }),
    /Implemented event output coverage/);
  assert.throws(() => audit({ emitted: [] }), /Implemented event output coverage/);
  assert.throws(() => audit({ emitted: [...emitted, evidence({ type: 'TEXT_MESSAGE_CHUNK' })] }),
    /Implemented event output coverage/);
});

for (const [index, label] of ['absent outcome', 'explicit success', 'suspended omitted interrupts',
  'suspended empty interrupts', 'suspended named interrupts'].entries()) {
  test(`audit rejects missing child terminal ${label}`, () => {
    const removed = emitted.filter(item => item.value.type !== 'SUBAGENT_FINISHED'
      || item.value.outcome !== childOutcomes[index]);
    assert.throws(() => audit({ emitted: removed }), new RegExp(`Child terminal coverage: ${label}`));
  });
}

test('chunks cannot claim direct output and declarations cannot invent events', () => {
  for (const name of ['TextMessageChunkEvent', 'ToolCallChunkEvent', 'ReasoningMessageChunkEvent', 'ResumeEntry', 'Tool']) {
    const changed = dispositions.map(row => row[0] === name ? [name, 'implemented', 'RUN_STARTED', row[3]] : row);
    assert.throws(() => audit({ dispositions: changed }), /Event disposition|Value disposition/);
  }
});
