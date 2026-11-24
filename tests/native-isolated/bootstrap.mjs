// Trusted entry: no SDK or test module is loaded until trace descriptors are inaccessible.
import assert from 'node:assert/strict';
import { closeSync, readlinkSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const entries = new Set(['claude-runtime', 'codex-sdk-chat', 'pi-runtime', 'pi-host', 'cursor-runtime']
  .map(name => `/stage/tests/native-isolated/${name}.native.mjs`)
  .concat(['decoy-read', 'network', 'launch'].map(name => `/stage/tests/native-isolated/controls/${name}.mjs`)));
assert.equal(process.execPath, '/usr/local/bin/node');
assert.deepEqual(process.execArgv, ['--test-reporter=tap']);
assert.equal(process.argv.length, 3);
assert.equal(process.argv[1], '/stage/tests/native-isolated/bootstrap.mjs');
assert(entries.has(process.argv[2]));
assert.deepEqual({ ...process.env }, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/switchboard-decoy', TMPDIR: '/tmp' });
const trace = readlinkSync('/proc/self/fd/3');
assert.match(trace, /^pipe:\[\d+\]$/);
closeSync(3);
for (const fd of readdirSync('/proc/self/fd')) {
  let link;
  try { link = readlinkSync(`/proc/self/fd/${fd}`); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  assert.notEqual(link, trace, 'trace descriptor remains inherited');
}
assert.throws(() => readdirSync(`/proc/${process.ppid}/fd`), error => error.code === 'EACCES' || error.code === 'EPERM',
  'tracer descriptors must be inaccessible');
await import(pathToFileURL(process.argv[2]).href);
