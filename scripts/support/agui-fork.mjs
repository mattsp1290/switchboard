import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Owns the AG-UI PR 49 fork core archive contract for every development and installed check.
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const manifest = read('package.json');
export const fork = read('docs/protocol/ag-ui-fork.json');
export const { coreArtifact } = fork;

const canonicalCore = read('docs/protocol/ag-ui-pin.json').artifacts
  .find((artifact) => artifact.package === coreArtifact.package && artifact.version === coreArtifact.version);
assert(canonicalCore, 'The canonical pin records the fork core package and version.');
assert.equal(coreArtifact.sha256, canonicalCore.sha256, 'Fork core archive is byte-identical to the canonical core artifact.');
assert.equal(coreArtifact.integrity, canonicalCore.integrity, 'Fork core archive integrity matches the canonical core artifact.');
assert.equal(coreArtifact.version, manifest.peerDependencies['@ag-ui/core'], 'Fork core archive version matches the optional peer.');
assert(Number.isInteger(coreArtifact.bytes) && coreArtifact.bytes > 0, 'Fork core archive records its byte length.');
assert.match(coreArtifact.deliveryCommit, /^[a-f0-9]{40}$/, 'Fork core archive delivery is an immutable commit.');
const deliveryRaw = coreArtifact.deliveryRepository.replace(/^https:\/\/github\.com\//, 'https://raw.githubusercontent.com/');
assert.equal(
  coreArtifact.url,
  `${deliveryRaw}/${coreArtifact.deliveryCommit}/vendor/ag-ui/${fork.sourceCommit}/ag-ui-core-${coreArtifact.version}.tgz`,
  'Fork core archive URL is pinned to the delivery commit and fork source.',
);
assert.equal(manifest.devDependencies['@ag-ui/core'], coreArtifact.url, 'Development uses the frozen fork core archive.');

// A lockfile must hold exactly one AG-UI package: the fork core archive, with no nested or registry copy.
export function assertForkCoreLock(lock, label) {
  const aguiPackages = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/@ag-ui\//.test(path));
  assert.deepEqual(aguiPackages.map(([path]) => path), ['node_modules/@ag-ui/core'], `${label} installs only one fork AG-UI core package.`);
  const [[, core]] = aguiPackages;
  assert.equal(core.version, coreArtifact.version, `${label} fork core version.`);
  assert.equal(core.resolved, coreArtifact.url, `${label} resolves the frozen fork archive without registry fallback.`);
  assert.equal(core.integrity, coreArtifact.integrity, `${label} pins the fork archive integrity.`);
}

export function assertInstalledForkCore(directory, label) {
  assertForkCoreLock(JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8')), label);
}

const developmentLock = read('package-lock.json');
assert.equal(developmentLock.packages[''].devDependencies['@ag-ui/core'], coreArtifact.url, 'Development lock root selects the fork core archive.');
assertForkCoreLock(developmentLock, 'Development lock');
