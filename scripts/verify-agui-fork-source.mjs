import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-agui-fork-source.mjs /absolute/path/to/ag-ui');
const repository = resolve(process.argv[2]);
const pin = JSON.parse(await readFile(new URL('../docs/protocol/ag-ui-fork.json', import.meta.url), 'utf8'));
const canonical = JSON.parse(await readFile(new URL('../docs/protocol/ag-ui-pin.json', import.meta.url), 'utf8'));
const options = { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 };
const git = (...args) => execFileSync('git', ['-C', repository, ...args], options);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const commit = (value) => {
  assert.match(value, /^[a-f0-9]{40}$/, 'Expected an immutable Git commit');
  assert.equal(git('rev-parse', `${value}^{commit}`).toString().trim(), value);
  return value;
};
const ancestor = (value) => {
  const result = spawnSync('git', ['-C', repository, 'merge-base', '--is-ancestor', commit(value), pin.sourceCommit], options);
  assert.ifError(result.error);
  assert([0, 1].includes(result.status), result.stderr?.toString());
  return result.status === 0;
};

assert.equal(pin.qualification, 'source-only');
commit(pin.sourceCommit);
assert.equal(git('rev-parse', `${pin.sourceCommit}^{tree}`).toString().trim(), pin.sourceTree, 'Fork source tree');
for (const branch of pin.sourceBranches) {
  assert(ancestor(branch.includedCommit), `Included source PR ${branch.pullRequest}`);
  assert.equal(ancestor(branch.observedCommit), branch.observedCommitIncluded, `Observed source PR ${branch.pullRequest} ancestry`);
}
const files = new Map();
for (const [path, digest] of Object.entries(pin.files)) {
  const bytes = git('cat-file', 'blob', `${pin.sourceCommit}:${path}`);
  assert.equal(sha(bytes), digest, `Fork SHA-256 ${path}`);
  files.set(path, bytes);
}
for (const path of ['spec/1.0/schema.json', 'spec/1.0/fixtures/MANIFEST.txt', 'LICENSE']) {
  assert.equal(sha(files.get(path)), canonical.upstreamFiles[path], `Historical canonical parity ${path}`);
}
for (const expected of pin.packages) {
  const manifest = JSON.parse(files.get(`${expected.path}/package.json`));
  assert.equal(manifest.name, expected.name, 'Source package name');
  assert.equal(manifest.version, expected.version, `Source version ${expected.name}`);
  assert.equal(manifest.license, 'MIT', `Source license ${expected.name}`);
  const entry = files.get(`${expected.path}/src/index.ts`).toString();
  for (const name of expected.publicExports) {
    assert.match(entry, new RegExp(`export[^;]*\\b${name}\\b`, 's'), `Public source export ${expected.name} ${name}`);
  }
}
process.stdout.write(`Verified source only at ${pin.sourceCommit}.\n`);
process.stdout.write('Package installation, runtime adoption, native behavior and live routes remain unqualified.\n');
