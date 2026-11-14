import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';

export function historyCopies(root, inventory, verifySources, report) {
  const base = 'thread_history_1.sqlite';
  const allowed = [base, `${base}-wal`, `${base}-shm`];
  const files = inventory.entries.filter((entry) => entry.token.startsWith('thread_history')).map((entry) => entry.token).sort();
  assert(files.includes(base), 'INCONCLUSIVE missing cold history base');
  assert(files.every((file) => allowed.includes(file)), 'Unsupported cold history family');
  const identity = (stat) => `${stat.dev}:${stat.ino}`;
  const describe = (path) => {
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Cold history requires regular files');
    return { inode: identity(stat), size: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  };
  const source = Object.fromEntries(files.map((file) => {
    const actual = describe(`${root}/${file}`);
    assert.equal(actual.size, inventory.entries.find((entry) => entry.token === file).size);
    assert.equal(actual.sha256, inventory.hashes.find((entry) => entry.token === file)?.sha256, 'Admitted cold history hash');
    return [file, actual];
  }));
  const inodes = new Set(inventory.entries.filter((entry) => !entry.directory).map((entry) => identity(lstatSync(`${root}/${entry.token}`))));
  let bytes = 0;
  report.copies = [];
  return (config) => {
    const destination = config.sqlite_home;
    assert.match(destination, /^\/tmp\/private-index-(accountA|accountB|apiKey)$/);
    const observation = { requester: destination.split('-').at(-1), destination, source, files: [], status: 'incomplete' };
    report.copies.push(observation);
    verifySources(`before ${observation.requester} cold copy`);
    assert.deepEqual(readdirSync(root).filter((file) => file.startsWith('thread_history')).sort(), files, 'Exact cold source family');
    for (const file of files) assert.deepEqual(describe(`${root}/${file}`), source[file], 'Frozen cold source generation');
    const size = files.reduce((sum, file) => sum + source[file].size, 0);
    assert(bytes + size <= 24 * 1024 * 1024, 'Aggregate cold copy budget');
    for (const earlier of report.copies.slice(0, -1)) {
      for (const file of readdirSync(earlier.destination)) inodes.add(identity(lstatSync(`${earlier.destination}/${file}`)));
    }
    mkdirSync(destination);
    assert.deepEqual(readdirSync(destination), [], 'New empty private SQLite directory');
    bytes += size;
    for (const file of files) {
      copyFileSync(`${root}/${file}`, `${destination}/${file}`, constants.COPYFILE_EXCL);
      const copied = describe(`${destination}/${file}`);
      assert(!inodes.has(copied.inode), 'Cold copies cannot alias originals or another reader');
      inodes.add(copied.inode);
      assert.equal(copied.size, source[file].size, 'Complete cold copy size');
      assert.equal(copied.sha256, source[file].sha256, 'Complete cold copy hash');
      assert(readFileSync(`${destination}/${file}`).equals(readFileSync(`${root}/${file}`)), 'Complete cold copy bytes');
      observation.files.push({ file, ...copied });
    }
    assert.deepEqual(readdirSync(destination).sort(), files, 'Exact private history family');
    for (const file of files) assert.deepEqual(describe(`${root}/${file}`), source[file], 'Source stable through cold copy');
    verifySources(`after ${observation.requester} cold copy`);
    Object.assign(observation, { status: 'complete-before-spawn', aggregateBytes: bytes });
  };
}
