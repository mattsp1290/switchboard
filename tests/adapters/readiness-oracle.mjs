import assert from 'node:assert/strict';

const order = ['installation', 'version', 'authentication', 'workspace'];
const unobserved = ['timed_out', 'cancelled', 'unknown', 'not_checked', 'unsupported'];
const blocking = { install_required: ['not_installed', 'not_executable'], version_required: ['mismatch'],
  sign_in_required: ['sign_in_required', 'unsupported_method'], workspace_unavailable: ['inaccessible'] };
const extra = { qualified: ['observed', 'required'], mismatch: ['observed', 'required'], signed_in: ['method'] };

/** Recomputes every derived field from `facts` independently of the adapters and scans the JSON for canaries. */
export function assertCoherentReport(report, canaries = []) {
  assert.deepEqual(Object.keys(report).sort(), ['checked', 'facts', 'observedAt', 'provider', 'remediation', 'verdict']);
  assert.deepEqual(Object.keys(report.facts), order);
  for (const fact of order) assert.deepEqual(Object.keys(report.facts[fact]).sort(), [...extra[report.facts[fact].state] ?? [], 'state']);
  const states = order.map(fact => report.facts[fact].state);
  assert.deepEqual(report.checked, order.filter(fact => !unobserved.includes(report.facts[fact].state)));
  const version = report.facts.version;
  if ('observed' in version) assert.match(version.observed, /^\d{1,4}\.\d{1,4}\.\d{1,4}(-(alpha|beta|rc)(\.\d{1,4})?)?$/);
  const action = order.flatMap(fact => Object.keys(blocking).filter(code => blocking[code].includes(report.facts[fact].state)))[0];
  const ready = states[0] === 'available' && states[1] === 'qualified' && states[2] === 'signed_in' && ['accessible', 'unsupported'].includes(states[3]);
  assert.equal(report.verdict, ready ? 'ready' : action ? 'blocked' : 'unverified');
  if (ready) assert.equal(report.remediation, null);
  else {
    assert.deepEqual(Object.keys(report.remediation).sort(), ['code', 'message']);
    assert(action ? report.remediation.code === action
      : ['retry_check', 'check_cancelled', 'runtime_closed', 'check_unavailable'].includes(report.remediation.code));
  }
  assert(Number.isFinite(Date.parse(report.observedAt)));
  const json = JSON.stringify(report);
  assert.deepEqual(JSON.parse(json), report);
  for (const canary of canaries) assert(!json.includes(canary), canary);
  return report;
}
