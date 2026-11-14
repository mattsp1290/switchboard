import assert from 'node:assert/strict';

const normalized = new Map([
  ['TEXT_MESSAGE_CHUNK', ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']],
  ['TOOL_CALL_CHUNK', ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']],
  ['REASONING_MESSAGE_CHUNK', ['REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END']],
]);
const sorted = values => [...values].sort();

export function auditDispositions({ definitions, dispositions, emitted }) {
  const inventory = new Map(definitions.map(([name, , event]) => [name, event]));
  const explicit = new Set([...inventory.values()].filter(event => event && !normalized.has(event)));
  const declared = new Set();
  for (const row of dispositions) {
    assert.equal(row.length, 4, 'Disposition rows have four columns.');
    const [name, kind, carrierList, rationale] = row;
    assert(inventory.has(name), `Unknown disposition: ${name}`);
    assert(!declared.has(name), `Duplicate disposition: ${name}`);
    declared.add(name);
    assert(['implemented', 'nested', 'normalized', 'declaration'].includes(kind), `Invalid disposition: ${name}`);
    assert(rationale.trim(), `Missing rationale: ${name}`);
    const carriers = carrierList.split(',');
    assert(carriers.every(carrier => kind === 'declaration' ? inventory.has(carrier) : explicit.has(carrier)),
      `Invalid carriers: ${name}`);
    const event = inventory.get(name);
    if (event) {
      assert.equal(kind, normalized.has(event) ? 'normalized' : 'implemented', `Event disposition: ${name}`);
      assert.deepEqual(carriers, normalized.get(event) ?? [event], `Event carriers: ${name}`);
    } else {
      assert(['nested', 'declaration'].includes(kind), `Value disposition: ${name}`);
    }
  }
  assert.deepEqual(sorted(declared), sorted(inventory.keys()), 'Missing disposition definitions.');
  if (emitted === undefined) return;
  const actual = emitted.filter(item => item.origin === 'switchboard-projection').map(item => item.value);
  const types = new Set(actual.map(event => event.type));
  assert.deepEqual(sorted(types), sorted(explicit), 'Implemented event output coverage.');
  const children = actual.filter(event => event.type === 'SUBAGENT_FINISHED');
  assert(children.some(event => !('outcome' in event)), 'Child terminal coverage: absent outcome');
  assert(children.some(event => event.outcome?.type === 'success'), 'Child terminal coverage: explicit success');
  for (const [label, matches] of [
    ['omitted interrupts', ids => ids === undefined],
    ['empty interrupts', ids => Array.isArray(ids) && ids.length === 0],
    ['named interrupts', ids => Array.isArray(ids) && ids.length > 0],
  ]) {
    assert(children.some(event => event.outcome?.type === 'suspended' && matches(event.outcome.interruptIds)),
      `Child terminal coverage: suspended ${label}`);
  }
}
