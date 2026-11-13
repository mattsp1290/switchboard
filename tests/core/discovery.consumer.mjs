import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { discoverFiles, fileDiscoveryLimits, sessionLimits } from '@mattsp1290/switchboard';

const binding = { engine: 'fixture', nativeVersion: '1', account: 'fixture-account', authorizedScope: 'fixture-scope', nativeFormat: 'fixture-only' };
const bounds = { maxResults: 20, maxExamined: 100, maxDurationMs: 1000, maxDepth: 4, maxFileBytes: 100, maxTotalBytes: 1000 };
async function fixture(t, entries = {}) {
  const base = await fs.mkdtemp(join(tmpdir(), 'switchboard-files-'));
  const root = join(base, 'authorized');
  await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(entries)) {
    const path = join(root, name);
    await fs.mkdir(dirname(path), { recursive: true });
    if (content === null) await fs.mkdir(path, { recursive: true });
    else await fs.writeFile(path, content);
  }
  return { base, root, run: (overrides = {}) => discoverFiles({
    scope: { binding, root, namespace: 'host-stable' }, expected: binding, bounds,
    signal: new AbortController().signal, selectFile: () => true,
    decode: ({ relativeName, bytes }) => ({ kind: 'found', value: { name: relativeName, text: Buffer.from(bytes).toString() } }),
    ...overrides,
  }) };
}
function page(result) { assert.equal(result.kind, 'ok'); return result.value; }
function error(result, code) { assert.deepEqual(result, { kind: 'error', error: { code } }); }
function terminal(result, kind, reason) {
  const value = page(result);
  assert.equal(value.kind, kind);
  if (reason) assert.equal(value.reason, reason);
  return value;
}
function patch(t, object, method, wrapper) {
  const original = object[method].bind(object);
  t.mock.method(object, method, (...args) => wrapper(original, ...args));
}
function handles(t, hooks = {}) {
  const live = new Set();
  for (const [method, hook] of [['open', hooks.file], ['opendir', hooks.directory]]) {
    patch(t, fs, method, async (original, ...args) => {
      const handle = await original(...args);
      live.add(handle);
      patch(t, handle, 'close', async (close) => { await close(); live.delete(handle); });
      if (hook) await hook(handle, ...args);
      return handle;
    });
  }
  t.after(() => assert.equal(live.size, 0, 'Every acquired handle closes.'));
  return live;
}

test('real fixture traversal, empty roots, root aliases and filtering preserve bytes and counts', async (t) => {
  const f = await fixture(t, { 'one.fixture': 'abc', 'sub/two.fixture': 'de', 'unrelated': 'never-read' });
  handles(t);
  const result = terminal(await f.run({ selectFile: (name) => name.endsWith('.fixture') }), 'complete');
  assert.deepEqual(result.values.map((item) => item.text).sort(), ['abc', 'de']);
  assert.equal(result.examined, 4);
  assert.equal(result.bytesRead, 5);
  const empty = await fixture(t);
  assert.equal(terminal(await empty.run(), 'complete').examined, 0);
  const alias = join(f.base, 'root-alias');
  await fs.symlink(f.root, alias);
  assert.equal(page(await f.run({ scope: { binding, root: alias, namespace: 'host-stable' } })).values.length, 3);
});
test('all input and binding checks precede filesystem access', async (t) => {
  const f = await fixture(t);
  for (const method of ['realpath', 'lstat', 'opendir', 'open']) patch(t, fs, method, () => assert.fail('No I/O before validation.'));
  for (const key of Object.keys(binding)) error(await f.run({ expected: { ...binding, [key]: 'other' } }), 'binding-mismatch');
  for (const root of ['relative', `${f.root}/../sibling`, `${f.root}/./file`, `${f.root}\0hidden`]) {
    error(await f.run({ scope: { binding, root, namespace: 'host-stable' } }), 'invalid-input');
  }
  for (const key of Object.keys(bounds)) {
    for (const value of [-1, 0.5, NaN, Infinity, fileDiscoveryLimits[key] + 1, Number.MAX_SAFE_INTEGER, '1']) {
      error(await f.run({ bounds: { ...bounds, [key]: value } }), 'invalid-input');
    }
    if (key !== 'maxDepth') error(await f.run({ bounds: { ...bounds, [key]: 0 } }), 'invalid-input');
  }
  for (const key of Object.keys(binding)) {
    for (const value of ['', '\0', 'x'.repeat(sessionLimits.identifierLength + 1), 1]) {
      error(await f.run({ expected: { ...binding, [key]: value } }), 'invalid-input');
      error(await f.run({ scope: { binding: { ...binding, [key]: value }, root: f.root, namespace: 'host-stable' } }), 'invalid-input');
    }
  }
  for (const overrides of [{ scope: null }, { bounds: null }, { signal: {} }, { selectFile: null }, { decode: null },
    { scope: { binding, root: f.root, namespace: 'untrusted' } }, { bounds: { ...bounds, maxResults: 101 } }]) {
    error(await f.run(overrides), 'invalid-input');
  }
  error(await discoverFiles(null), 'invalid-input');
  const controller = new AbortController(); controller.abort();
  terminal(await f.run({ signal: controller.signal }), 'cancelled');
  assert.equal(fileDiscoveryLimits.maxExamined, sessionLimits.maxExamined);
});
test('missing and non-directory roots are inaccessible', async (t) => {
  const f = await fixture(t, { leaf: 'fixture' });
  for (const root of [join(f.root, 'missing'), join(f.root, 'leaf')]) {
    error(await f.run({ scope: { binding, root, namespace: 'host-stable' } }), 'inaccessible-root');
  }
});
test('descendant links, prefix siblings, links inside root and nonregular leaves are rejected', async (t) => {
  const f = await fixture(t);
  const sibling = `${f.root}-sibling`; await fs.mkdir(sibling); await fs.writeFile(join(sibling, 'outside'), 'outside');
  await fs.symlink(sibling, join(f.root, 'directory-link'));
  await fs.symlink(join(sibling, 'outside'), join(f.root, 'leaf-link'));
  await fs.symlink(f.root, join(f.root, 'inside-link'));
  execFileSync('mkfifo', [join(f.root, 'pipe')]);
  const result = terminal(await f.run(), 'complete');
  assert.equal(result.examined, 4); assert.equal(result.skipped.rejected, 4);
  assert.equal(result.bytesRead, 0); assert.deepEqual(result.values, []);
});
test('unreadable fixture leaves and roots report permission failures', async (t) => {
  if (process.getuid?.() === 0) { t.skip('Root privileges invalidate chmod permission assertions.'); return; }
  const f = await fixture(t, { private: 'fixture' });
  await fs.chmod(join(f.root, 'private'), 0);
  try { assert.equal(page(await f.run()).skipped.inaccessible, 1); }
  finally { await fs.chmod(join(f.root, 'private'), 0o600); }
  await fs.chmod(f.root, 0);
  try { error(await f.run(), 'inaccessible-root'); }
  finally { await fs.chmod(f.root, 0o700); }
});
test('corruption is adapter-declared, skip is filtering and callback faults are structured', async (t) => {
  const f = await fixture(t, { item: 'not-json' }); handles(t);
  assert.equal(page(await f.run({ decode: () => ({ kind: 'corrupt' }) })).skipped.corrupt, 1);
  assert.equal(page(await f.run({ decode: () => ({ kind: 'skip' }) })).skipped.corrupt, 0);
  for (const overrides of [{ decode: () => { throw new Error('secret-content'); } },
    { selectFile: () => { throw new Error('secret-path'); } }, { selectFile: async () => true },
    { decode: () => null }, { decode: () => ({ get kind() { throw new Error('credential-canary'); } }) },
    { decode: async () => ({ kind: 'skip' }) }]) error(await f.run(overrides), 'callback-failure');
});
test('exact result, examined and depth bounds remain conservatively truncated', async (t) => {
  const f = await fixture(t, { only: 'fixture' }); handles(t);
  assert.equal(terminal(await f.run({ bounds: { ...bounds, maxResults: 1 } }), 'truncated', 'results').values.length, 1);
  assert.equal(terminal(await f.run({ bounds: { ...bounds, maxResults: 1, maxExamined: 1 }, selectFile: () => false }), 'truncated', 'examined').examined, 1);
  const nested = await fixture(t, { 'a/b/item': 'nested', rootFile: 'root' });
  for (const maxDepth of [0, 1]) {
    const result = terminal(await nested.run({ bounds: { ...bounds, maxDepth } }), 'truncated', 'depth');
    assert.deepEqual(result.values.map((item) => item.text), ['root']);
    assert.equal(result.examined, 2 + maxDepth);
  }
  assert.equal(terminal(await nested.run({ bounds: { ...bounds, maxDepth: 2 } }), 'complete').values.length, 2);
  const many = await fixture(t, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`item-${i}`, 'fixture'])));
  const filtered = terminal(await many.run({ bounds: { ...bounds, maxResults: 1, maxExamined: 7 }, selectFile: () => false }), 'truncated', 'examined');
  assert.equal(filtered.examined, 7); assert.equal(filtered.bytesRead, 0);
});
test('file and total byte limits establish EOF before decoding and charge the growth sentinel', async (t) => {
  const f = await fixture(t, { item: 'abcd' }); handles(t);
  assert.equal(terminal(await f.run({ bounds: { ...bounds, maxFileBytes: 4 } }), 'complete').bytesRead, 4);
  const oversized = page(await f.run({ bounds: { ...bounds, maxFileBytes: 3 } }));
  assert.equal(oversized.skipped.oversized, 1); assert.equal(oversized.bytesRead, 0);
  for (const maxTotalBytes of [3, 4]) {
    const result = terminal(await f.run({ bounds: { ...bounds, maxTotalBytes } }), 'truncated', 'bytes');
    assert.equal(result.bytesRead, maxTotalBytes); assert.deepEqual(result.values, []);
  }
  assert.equal(terminal(await f.run({ bounds: { ...bounds, maxTotalBytes: 5 } }), 'complete').values.length, 1);
});
test('growth after stat is bounded by actual bytes including an oversize sentinel', async (t) => {
  const f = await fixture(t, { item: 'ab' });
  handles(t, { file: async () => fs.appendFile(join(f.root, 'item'), 'cdefghij') });
  const result = terminal(await f.run({ bounds: { ...bounds, maxFileBytes: 4 } }), 'complete');
  assert.equal(result.bytesRead, 5); assert.equal(result.skipped.oversized, 1); assert.deepEqual(result.values, []);
});
test('disappearance, leaf replacement and post-open path changes use verified handles', async (t) => {
  for (const scenario of ['absent', 'replacement', 'symlink', 'fifo', 'same-handle']) await t.test(scenario, async (s) => {
    const f = await fixture(s, { item: 'original' }); handles(s);
    const path = join(f.root, 'item');
    if (scenario === 'same-handle') {
      patch(s, fs, 'open', async (open, ...args) => {
        const handle = await open(...args);
        const stat = handle.stat.bind(handle);
        s.mock.method(handle, 'stat', async (...statArgs) => {
          const result = await stat(...statArgs); await fs.rename(path, `${path}.old`); await fs.writeFile(path, 'replacement'); return result;
        });
        return handle;
      });
    } else patch(s, fs, 'open', async (open, ...args) => {
      await fs.rename(path, `${path}.old`);
      if (scenario === 'replacement') await fs.writeFile(path, 'replacement');
      if (scenario === 'symlink') await fs.symlink(`${path}.old`, path);
      if (scenario === 'fifo') execFileSync('mkfifo', [path]);
      return open(...args);
    });
    const result = page(await f.run({ bounds: { ...bounds, maxResults: 1, maxExamined: 1 } }));
    if (scenario === 'same-handle') assert.equal(result.values[0].text, 'original');
    else { assert.equal(result.skipped[scenario === 'absent' ? 'absent' : 'rejected'], 1); assert.equal(result.bytesRead, 0); }
  });
});
test('directory replacement after open is detected before entry reads', async (t) => {
  const f = await fixture(t, { 'sub/item': 'fixture' });
  handles(t, { directory: async (_handle, path) => {
    if (path.endsWith('/sub')) { await fs.rename(path, `${path}-old`); await fs.mkdir(path); }
  } });
  const result = page(await f.run({ bounds: { ...bounds, maxResults: 1, maxExamined: 2 }, selectFile: () => false }));
  assert(result.skipped.rejected >= 1); assert.equal(result.bytesRead, 0);
});
test('unknown I/O failures remain errors and close every acquired handle', async (t) => {
  for (const point of ['realpath', 'lstat', 'read', 'dir-read']) await t.test(point, async (s) => {
    const f = await fixture(s, { item: 'fixture' });
    const broken = () => { throw Object.assign(new Error('private-path'), { code: 'EIO' }); };
    handles(s, { file: async (handle) => { if (point === 'read') s.mock.method(handle, 'read', broken); },
      directory: async (handle) => { if (point === 'dir-read') s.mock.method(handle, 'read', broken); } });
    if (point === 'realpath' || point === 'lstat') s.mock.method(fs, point, broken);
    error(await f.run(), 'io-failure');
  });
});
test('abort during handle acquisition or partial reads waits for cleanup and never decodes a prefix', async (t) => {
  for (const point of ['directory', 'file', 'read']) await t.test(point, async (s) => {
    const f = await fixture(s, { item: Buffer.alloc(70000, 65) });
    const controller = new AbortController();
    const live = handles(s, { directory: async () => { if (point === 'directory') controller.abort(); },
      file: async (handle) => {
        if (point === 'file') controller.abort();
        if (point === 'read') patch(s, handle, 'read', async (read, ...args) => { const result = await read(...args); controller.abort(); return result; });
      } });
    const result = terminal(await f.run({ signal: controller.signal, bounds: { ...bounds, maxFileBytes: 80000, maxTotalBytes: 90000 },
      decode: () => assert.fail('Incomplete bytes cannot be decoded.') }), 'cancelled');
    assert.equal(result.bytesRead, point === 'read' ? 65536 : 0);
    assert.equal(live.size, 0, 'Cancellation resolves only after every acquired handle closes.');
  });
});
test('elapsed duration and abort after callbacks stop further work', async (t) => {
  for (const point of ['await', 'select', 'decode']) await t.test(point, async (s) => {
    const f = await fixture(s, { item: 'fixture' }); const controller = new AbortController();
    handles(s, { file: async () => { if (point === 'await') await setTimeout(20); } });
    terminal(await f.run({ signal: controller.signal, bounds: { ...bounds, maxDurationMs: point === 'await' ? 10 : 1000 },
      selectFile: () => { if (point === 'select') controller.abort(); return true; },
      decode: () => { controller.abort(); return { kind: 'found', value: 'discarded-after-cancel' }; },
    }), point === 'await' ? 'truncated' : 'cancelled', point === 'await' ? 'duration' : undefined);
  });
});
test('configuration snapshots read known getters once and ignore extra fields', async (t) => {
  const f = await fixture(t, { item: 'four' }); handles(t);
  let byteReads = 0; let rootReads = 0; let accountReads = 0;
  const capturedBounds = { ...bounds, get maxTotalBytes() { return ++byteReads === 1 ? 1 : Infinity; },
    get credentialCanary() { throw new Error('unknown-field-credential-canary'); } };
  const scope = { namespace: 'host-stable', get root() { return ++rootReads === 1 ? f.root : '/unrelated-home'; },
    binding: { ...binding, get account() { return ++accountReads === 1 ? binding.account : 'other'; } } };
  const result = terminal(await f.run({ scope, bounds: capturedBounds }), 'truncated', 'bytes');
  assert.equal(result.bytesRead, 1); assert.deepEqual(result.values, []);
  assert.deepEqual([byteReads, rootReads, accountReads], [1, 1, 1]);
});
test('throwing configuration getters return a sanitized error before I/O', async (t) => {
  const f = await fixture(t);
  for (const method of ['realpath', 'lstat', 'opendir', 'open']) patch(t, fs, method, () => assert.fail('Invalid input cannot reach I/O.'));
  const throwing = () => { throw new Error('credential-canary'); };
  for (const section of ['scope', 'bounds', 'expected', 'signal']) {
    error(await f.run(Object.defineProperty({}, section, { enumerable: true, get: () =>
      section === 'scope' ? { get root() { return throwing(); } } : section === 'bounds' ? { get maxResults() { return throwing(); } }
        : section === 'expected' ? { get account() { return throwing(); } } : {}})), 'invalid-input');
  }
  const input = Object.defineProperty({}, 'scope', { get: throwing });
  error(await discoverFiles(input), 'invalid-input');
});
test('the total byte budget is shared across files and growth cannot enlarge it', async (t) => {
  const f = await fixture(t, { a: 'ab', b: 'cd' }); handles(t);
  const shared = terminal(await f.run({ bounds: { ...bounds, maxTotalBytes: 3 } }), 'truncated', 'bytes');
  assert.equal(shared.bytesRead, 3); assert.equal(shared.values.length, 1);
  const growing = await fixture(t, { item: 'ab' });
  patch(t, fs, 'open', async (open, ...args) => {
    const handle = await open(...args); await fs.appendFile(join(growing.root, 'item'), 'cdef'); return handle;
  });
  const result = terminal(await growing.run({ bounds: { ...bounds, maxTotalBytes: 4 } }), 'truncated', 'bytes');
  assert.equal(result.bytesRead, 4); assert.deepEqual(result.values, []);
});
test('abort after a returned directory entry charges the entry before closing', async (t) => {
  const f = await fixture(t, { item: 'fixture' }); const controller = new AbortController();
  const live = handles(t, { directory: async (handle) => {
    patch(t, handle, 'read', async (read) => { const entry = await read(); controller.abort(); return entry; });
  } });
  const result = terminal(await f.run({ signal: controller.signal }), 'cancelled');
  assert.equal(result.examined, 1); assert.equal(result.bytesRead, 0); assert.equal(live.size, 0);
});
test('deadline checks include time spent inside either synchronous callback', async (t) => {
  for (const point of ['selectFile', 'decode']) await t.test(point, async (s) => {
    const f = await fixture(s, { item: 'fixture' }); handles(s); let called = false;
    const slow = () => { called = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); };
    const result = terminal(await f.run({ bounds: { ...bounds, maxDurationMs: 100 },
      [point]: () => { slow(); return point === 'selectFile' ? true : { kind: 'found', value: 'discarded' }; },
    }), 'truncated', 'duration');
    assert(called); assert.deepEqual(result.values, []);
  });
});
test('short reads assemble the whole file before decoding', async (t) => {
  const f = await fixture(t, { item: 'four' });
  handles(t, { file: async (handle) => patch(t, handle, 'read', (read, buffer, offset, length, position) =>
    read(buffer, offset, Math.min(length, 1), position)) });
  const result = terminal(await f.run(), 'complete');
  assert.equal(result.bytesRead, 4); assert.equal(result.values[0].text, 'four');
});
