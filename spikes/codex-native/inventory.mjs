import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const limits = { entries: 128, depth: 8, fileBytes: 8 * 1024 * 1024, bytes: 8 * 1024 * 1024, milliseconds: 1000 };
function contained(root, target) {
  assert(typeof target === 'string' && !target.split(/[\\/]/).includes('..'), 'Lexical traversal rejected');
  const path = resolve(root, target);
  assert(path === root || path.startsWith(`${root}${sep}`), 'Outside-root input rejected');
  return path;
}
export function admittedPath(root, token, entries, negative = false) {
  assert(!isAbsolute(token), 'Inventory token must be relative');
  const path = contained(root, token);
  assert(/^(sessions|archived_sessions)(?:\/|$)/.test(token), 'Path is outside the history trees');
  assert(negative || entries.some((entry) => entry.token === token && entry.candidate), 'Not an admitted history file');
  let ancestor = path;
  for (;;) {
    try { assert(!lstatSync(ancestor).isSymbolicLink(), 'Symlink input rejected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (ancestor === root) break;
    ancestor = dirname(ancestor);
  }
  return path;
}
export function resultPath(root, value, entries) {
  try {
    assert(typeof value === 'string' && isAbsolute(value), 'Missing or ambiguous returned path');
    const path = contained(root, value);
    const token = relative(root, path);
    admittedPath(root, token, entries, true);
    assert(lstatSync(path).isFile(), 'Returned path is not a regular file');
    return { kind: 'contained', token, inventoried: entries.some((entry) => entry.token === token && entry.candidate) };
  } catch (error) { return { kind: 'unresolved', reason: error.message }; }
}
export function admit(root, overrides = {}) {
  const budget = { ...limits, ...overrides };
  const deadline = Date.now() + budget.milliseconds;
  root = resolve(root);
  assert.equal(realpathSync(root), root, 'Stable synthetic namespace has no symlink ancestors');
  const device = lstatSync(root).dev;
  const entries = [];
  let bytes = 0;
  const metadata = (path) => {
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), 'Host rejects symlinks before native discovery');
    assert(stat.isFile() || stat.isDirectory(), 'Host rejects special files');
    assert.equal(stat.dev, device, 'Unexpected source mount rejected');
    return { device: stat.dev, inode: stat.ino, size: stat.size, mode: stat.mode, modified: stat.mtimeMs, changed: stat.ctimeMs, directory: stat.isDirectory() };
  };
  const walk = (token, depth) => {
    assert(Date.now() <= deadline, 'Admission deadline exceeded');
    assert(depth <= budget.depth, 'Admission depth budget exceeded');
    const path = join(root, token);
    const stat = metadata(path);
    assert(entries.length < budget.entries, 'Admission entry budget exceeded');
    assert(stat.directory || stat.size <= budget.fileBytes, `Admission per-file byte budget exceeded for ${token} with ${stat.size} bytes`);
    bytes += stat.size;
    assert(bytes <= budget.bytes, 'Admission aggregate byte budget exceeded');
    entries.push({ token, ...stat, candidate: !stat.directory && /^(sessions|archived_sessions)\//.test(token) });
    if (stat.directory) children(path, (name) => walk(join(token, name), depth + 1));
    assert.deepEqual(metadata(path), stat, 'Source entry changed during admission');
  };
  const children = (path, visit) => {
    const directory = opendirSync(path);
    try {
      for (let child; (child = directory.readSync());) {
        assert(Date.now() <= deadline, 'Admission deadline exceeded');
        visit(child.name);
      }
    } finally { directory.closeSync(); }
  };
  const rootBefore = metadata(root);
  children(root, (token) => walk(token, 1));
  assert.deepEqual(metadata(root), rootBefore, 'Source root changed during admission');
  for (const entry of entries) {
    assert(Date.now() <= deadline, 'Admission deadline exceeded');
    const { token, candidate: _candidate, ...stat } = entry;
    assert.deepEqual(metadata(join(root, token)), stat, 'Source inventory changed during admission');
  }
  entries.sort((left, right) => left.token.localeCompare(right.token));
  return { entries, bytes, termination: 'exhausted', limits: budget };
}
export function fingerprint(root, inventory) {
  return inventory.entries.filter((entry) => !entry.directory).map(({ token }) => ({ token,
    sha256: createHash('sha256').update(readFileSync(join(root, token))).digest('hex') }));
}
export function requestBudget(maximum) {
  let used = 0;
  return (dispatch, request) => {
    assert(used < maximum, 'Path request budget exhausted before dispatch');
    used++;
    return dispatch(request);
  };
}
