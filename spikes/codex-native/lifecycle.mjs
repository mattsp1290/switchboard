import assert from 'node:assert/strict';

export function ownedContainer(run, args, name) {
  let result;
  let operationObserved = false;
  const failures = [];
  try { result = run('docker', args); operationObserved = true; }
  catch (error) { failures.push(error); }
  let removalFailure;
  try { run('docker', ['rm', '-f', name], { timeout: 5000 }); operationObserved = true; }
  catch (error) { removalFailure = error; }
  let cleanupUncertain = true;
  try {
    const names = run('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 5000 });
    assert(!names.trim().split('\n').includes(name), 'Owned container still exists');
    assert(operationObserved, 'Never-observed creation remains uncertain despite empty inventory');
    cleanupUncertain = false;
  } catch (error) {
    failures.push(new Error('Container absence is unproved', { cause: error }));
    if (removalFailure) failures.push(removalFailure);
  }
  if (failures.length) {
    const error = new AggregateError(failures, `Owned container ${name} failed; cleanup ${cleanupUncertain ? 'uncertain' : 'proved absent'}`);
    Object.assign(error, { cleanupUncertain, stdout: result ?? failures[0].stdout, stderr: failures[0].stderr });
    throw error;
  }
  return result;
}
