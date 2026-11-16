import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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
// Bounded source observation. `observeSource` takes one baseline and retains each selected file's exact bytes;
// `verifySource` re-walks under the same bounds and refuses at the first difference. The deadline is cooperative:
// no atomic snapshot, hostile-ancestor protection, atime preservation or bound on one blocking syscall is claimed.
/**
 * @typedef {'file'|'directory'|'symlink'|'missing'} Kind   special files are never recorded: they refuse
 * @typedef {{ kind: Kind, device?: number, inode?: number, size?: number, mode?: number, links?: number,
 *   modified?: number, changed?: number }} Meta   regular files take metadata from the opened descriptor
 * @typedef {Meta & { bytes?: Buffer, target?: Buffer }} Entry   exact retained file bytes, or raw symlink target bytes
 * @typedef {{ examined: number, entries: number, bytes: number, metadataBytes: number }} Counters
 *   examined: dirents read, root included; bytes: actual file and link-target bytes; metadataBytes: reported, unbudgeted
 * @typedef {{ label: string, root: (name: string) => boolean, trees: readonly string[],
 *   links: 'refuse'|'characterize', host: boolean }} Selector
 * @typedef {{ reason: string, token: string, field?: string, before?: unknown, after?: unknown, offset?: number }} Difference
 * @typedef {Difference & { stage: string, cause: 'policy'|'change', termination: 'refused', counters: Counters,
 *   compared: number, visited: string[] }} RefusalEvidence   first difference only, with the last 16 visited tokens
 */
const CHUNK = 64 * 1024;
const EVIDENCE_BYTES = 128 * 1024;
const FIELDS = ['kind', 'device', 'inode', 'size', 'mode', 'links', 'modified', 'changed'];
const IDENTITY = ['kind', 'device', 'inode'];
const TREES = Object.freeze(['sessions', 'archived_sessions']);
const ordinaryRoot = (name) => /\.sqlite(?:-(?:wal|shm))?$/.test(name);
const selector = (label, root, options = {}) => Object.freeze({ label, root, trees: TREES, links: 'refuse', host: false, ...options });
export const SELECTORS = Object.freeze({
  ordinary: selector('ordinary', ordinaryRoot),
  symlink: selector('symlink', ordinaryRoot, { links: 'characterize' }),
  h1: selector('h1', (name) => name.includes('.sqlite') || name.startsWith('thread_history')),
  host: selector('host', () => true, { trees: [], host: true }),
  hostLifetime: selector('host-lifetime', () => true, { trees: [], host: true, links: 'characterize' }),
});
/** @param {string} mode @returns {Selector} the only mode-to-selector map */
export const selectorFor = (mode) => ['prepare-accounts', 'account-reads'].includes(mode) ? SELECTORS.h1
  : mode === 'symlink' ? SELECTORS.symlink : SELECTORS.ordinary;
export class SourceRefusal extends Error {
  /** @param {RefusalEvidence} evidence */
  constructor(evidence) {
    const { stage, cause, reason, token, field } = evidence;
    const scope = cause === 'policy' ? 'observation refused'
      : /added|removed|appeared|vanished|replaced/.test(reason) || field === 'kind' ? 'file set preserved' : 'bytes preserved';
    super(`Source ${scope} at ${stage}: ${reason} at ${token}${field ? ` (${field})` : ''}`);
    this.evidence = evidence;
  }
}
const kindOf = (stat) => stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'special';
const describe = (stat) => ({ kind: kindOf(stat), device: stat.dev, inode: stat.ino, size: stat.size, mode: stat.mode,
  links: stat.nlink, modified: stat.mtimeMs, changed: stat.ctimeMs });
const differing = (left, right, fields = FIELDS) => fields.find((field) => left[field] !== right[field]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** One bounded walk shared by every phase; sinks return a Difference and only the walk raises it, with counters. */
function walk(fs, root, selection, budget, sink, stage) {
  const deadline = Date.now() + budget.milliseconds;
  const counters = { examined: 0, entries: 0, bytes: 0, metadataBytes: 0 };
  const visited = [];
  const probe = Buffer.alloc(1);
  let compared = 0;
  let current = '.';
  const raise = (difference, cause = 'change') => {
    throw new SourceRefusal({ stage, cause, ...difference, termination: 'refused', counters: { ...counters }, compared, visited: [...visited] });
  };
  const limit = (reason, token, extra = {}) => raise({ reason, token, ...extra }, 'policy');
  const check = (difference) => { if (difference) raise(difference); };
  const tick = (token) => { if (Date.now() > deadline) limit('deadline exceeded', token); };
  const lstat = (path) => {
    try { return fs.lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const children = (path, token, visit) => {
    const directory = fs.opendirSync(path);
    try {
      for (let child; (tick(token), child = directory.readSync());) {
        if (counters.examined >= budget.entries) limit('entry budget exceeded', token);
        counters.examined++;
        visit(child.name);
      }
    } finally { directory.closeSync(); }
  };
  const read = (path, token, before) => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = describe(fs.fstatSync(fd));
      // Path and descriptor are compared on identity only, and compared metadata comes from the descriptor. That keeps
      // history-copy's path-lstat size seam (the 24 MiB copy-budget control) reachable; do not widen this to size.
      const field = differing(opened, before, IDENTITY);
      if (field) raise({ reason: 'substituted before read', token, field });
      if (opened.size > budget.fileBytes) limit('per-file byte budget exceeded', token, { size: opened.size });
      if (counters.bytes + opened.size > budget.bytes) limit('aggregate byte budget exceeded', token, { size: opened.size });
      const target = sink.buffer(token, opened);
      check(target.reason && target);
      for (let offset = 0; offset < opened.size;) {
        tick(token);
        const count = fs.readSync(fd, target.buffer, target.at(offset), Math.min(CHUNK, opened.size - offset), offset);
        if (count === 0) raise({ reason: 'short read', token, offset });
        check(sink.chunk(token, target.buffer, target.at(offset), count, offset));
        offset += count;
        counters.bytes += count;
      }
      if (fs.readSync(fd, probe, 0, 1, opened.size) !== 0) raise({ reason: 'grew during read', token });
      const after = differing(describe(fs.fstatSync(fd)), opened);
      if (after) raise({ reason: 'changed during read', token, field: after });
      return opened;
    } finally { fs.closeSync(fd); }
  };
  const visit = (token, depth) => {
    current = token;
    tick(token);
    if (depth > budget.depth) limit('depth budget exceeded', token);
    const path = `${root}/${token}`;
    const stat = lstat(path);
    if (!stat) raise({ reason: 'vanished during enumeration', token });
    let meta = describe(stat);
    if (selection.host && meta.device !== rootMeta.device) limit('foreign device', token);
    if (meta.kind === 'special') limit('special file', token);
    if (meta.kind === 'symlink' && selection.links === 'refuse') limit('symlink', token);
    visited.push(token);
    if (visited.length > 16) visited.shift();
    counters.entries++;
    let target;
    if (meta.kind === 'file') meta = read(path, token, meta);
    else counters.metadataBytes += meta.size;
    if (meta.kind === 'symlink') {
      target = fs.readlinkSync(path, { encoding: 'buffer' });
      if (counters.bytes + target.length > budget.bytes) limit('aggregate byte budget exceeded', token);
      counters.bytes += target.length;
    }
    check(sink.entry(token, meta, target));
    compared++;
    if (meta.kind === 'directory') children(path, token, (name) => visit(`${token}/${name}`, depth + 1));
    current = token;
    const after = lstat(path);
    const field = after ? differing(describe(after), describe(stat)) : 'kind';
    if (field) raise({ reason: 'changed during observation', token, field });
  };
  let rootMeta;
  try {
    const rootStat = lstat(root);
    if (!rootStat?.isDirectory()) limit('root is not a directory', '.');
    if (selection.host && fs.realpathSync(root) !== root) limit('root has symlink ancestors', '.');
    rootMeta = describe(rootStat);
    check(sink.root(rootMeta));
    const seen = new Set();
    children(root, '.', (name) => {
      if (!selection.root(name) && !selection.trees.includes(name)) { check(sink.unselected(name)); return; }
      seen.add(name);
      visit(name, 1);
    });
    for (const tree of selection.trees.filter((name) => !seen.has(name))) {
      if (lstat(`${root}/${tree}`)) raise({ reason: 'appeared during enumeration', token: tree });
      check(sink.entry(tree, { kind: 'missing' }));
    }
    // The root keeps identity only: native writes auxiliary files beside the read-only mounts on purpose.
    const field = differing(describe(fs.lstatSync(root)), rootMeta, IDENTITY);
    if (field) raise({ reason: 'root replaced', token: '.', field });
    check(sink.end());
  } catch (error) {
    if (error instanceof SourceRefusal) throw error;
    limit(`observation failed: ${error.code ?? error.message}`, current);
  }
  return counters;
}

/**
 * Take a consumer's one baseline: every selected entry's metadata plus exact file bytes (at most `limits.bytes`).
 * @param {string} root @param {Selector} selection
 * @param {{ fs?: object, overrides?: Partial<typeof limits>, stage?: string }} [options]  fs defaults to node:fs
 */
export function observeSource(root, selection, { fs = nodeFs, overrides = {}, stage = 'baseline' } = {}) {
  root = resolve(root);
  const budget = { ...limits, ...overrides };
  const entries = new Map();
  const names = new Set();
  let rootMeta;
  let pending;
  const counters = walk(fs, root, selection, budget, {
    root: (meta) => { rootMeta = meta; },
    unselected: (name) => { names.add(name); },
    buffer: (_token, opened) => { pending = Buffer.allocUnsafe(opened.size); return { buffer: pending, at: (offset) => offset }; },
    chunk: () => undefined,
    entry: (token, meta, target) => {
      entries.set(token, { ...meta, ...(meta.kind === 'file' ? { bytes: pending } : {}), ...(target ? { target } : {}) });
    },
    end: () => undefined,
  }, stage);
  const digest = createHash('sha256');
  for (const token of [...entries.keys()].sort()) {
    const entry = entries.get(token);
    digest.update(JSON.stringify([token, ...FIELDS.map((field) => entry[field] ?? null)]));
    digest.update(entry.bytes ?? entry.target ?? '');
  }
  return Object.freeze({ fs, root, selection, budget, entries, names, rootMeta, counters, digest: digest.digest('hex') });
}

/** Re-walk under the baseline's bounds; refuse at the first added, removed, changed or byte-different selected entry. */
export function verifySource(baseline, stage) {
  const seen = new Set();
  const present = new Set();
  const scratch = Buffer.allocUnsafe(CHUNK);
  let expected;
  const counters = walk(baseline.fs, baseline.root, baseline.selection, baseline.budget, {
    root: (meta) => {
      const field = differing(meta, baseline.rootMeta, IDENTITY);
      return field && { reason: 'root replaced', token: '.', field };
    },
    unselected: (name) => { present.add(name); },
    buffer: (token, opened) => {
      expected = baseline.entries.get(token);
      if (!expected) return { reason: 'file added', token };
      if (!expected.bytes) return { reason: 'metadata changed', token, field: 'kind', before: expected.kind, after: 'file' };
      if (opened.size !== expected.bytes.length) return { reason: 'metadata changed', token, field: 'size', before: expected.size, after: opened.size };
      return { buffer: scratch, at: () => 0 };
    },
    chunk: (token, buffer, start, count, offset) => buffer.subarray(start, start + count)
      .equals(expected.bytes.subarray(offset, offset + count)) ? undefined : { reason: 'bytes changed', token, offset },
    entry: (token, meta, target) => {
      const before = baseline.entries.get(token);
      if (!before) return { reason: `${meta.kind} added`, token };
      const field = differing(meta, before);
      if (field) return { reason: 'metadata changed', token, field, before: before[field], after: meta[field] };
      if (target && !target.equals(before.target)) return { reason: 'symlink target changed', token };
      seen.add(token);
    },
    end: () => {
      const missing = [...baseline.entries.keys()].find((token) => !seen.has(token));
      return missing && { reason: 'entry removed', token: missing };
    },
  }, stage);
  const added = [...present].filter((name) => !baseline.names.has(name));
  const removed = [...baseline.names].filter((name) => !present.has(name));
  return { stage, counters, rootChanges: { added: added.slice(0, 16), removed: removed.slice(0, 16), addedCount: added.length, removedCount: removed.length } };
}

/** Bounded direct comparison of a file outside the source (a cold copy) against retained bytes; returns its sha256. */
export function compareFile(fs, path, expected) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = describe(fs.fstatSync(fd));
    assert(before.kind === 'file' && before.size === expected.length, 'Complete cold copy size');
    const scratch = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, expected.length)));
    const hash = createHash('sha256');
    for (let offset = 0; offset < expected.length;) {
      const count = fs.readSync(fd, scratch, 0, Math.min(scratch.length, expected.length - offset), offset);
      assert(count > 0 && scratch.subarray(0, count).equals(expected.subarray(offset, offset + count)), 'Complete cold copy bytes');
      hash.update(scratch.subarray(0, count));
      offset += count;
    }
    assert.equal(fs.readSync(fd, scratch, 0, 1, expected.length), 0, 'Cold copy grew during comparison');
    assert(!differing(describe(fs.fstatSync(fd)), before), 'Cold copy changed during comparison');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** Host /opt/inventory.json wire shape (unchanged keys plus `links`); candidates are regular files in the history trees. */
export function inventoryOf(baseline) {
  const entries = [...baseline.entries].filter(([, entry]) => entry.kind !== 'missing').map(([token, entry]) => ({ token,
    device: entry.device, inode: entry.inode, size: entry.size, mode: entry.mode, links: entry.links, modified: entry.modified,
    changed: entry.changed, directory: entry.kind === 'directory', candidate: entry.kind === 'file' && /^(sessions|archived_sessions)\//.test(token) }))
    .sort((left, right) => left.token.localeCompare(right.token));
  return { entries, bytes: baseline.counters.bytes, termination: 'exhausted', limits: baseline.budget };
}
/** Per-file sha256 of retained bytes, replacing the old unbounded re-read. */
export const digestsOf = (baseline) => [...baseline.entries].filter(([, entry]) => entry.bytes)
  .map(([token, entry]) => ({ token, sha256: sha256(entry.bytes) })).sort((left, right) => left.token.localeCompare(right.token));
/** Final-output source evidence, bounded before construction: metadata and sha256 per entry, never file bytes. */
export function evidenceOf(baseline, maxBytes = EVIDENCE_BYTES) {
  const summary = { selector: baseline.selection.label, digest: baseline.digest, termination: 'exhausted', counters: baseline.counters };
  const bound = [...baseline.entries].reduce((sum, [token, entry]) =>
    sum + 6 * Buffer.byteLength(token) + 384 + (entry.target ? 4 * Math.ceil(entry.target.length / 3) : 0), 0);
  if (bound > maxBytes) return { ...summary, entriesOmitted: baseline.entries.size };
  return { ...summary, entries: [...baseline.entries].sort(([left], [right]) => left < right ? -1 : 1).map(([token, { bytes, target, ...meta }]) => ({ token, ...meta,
    ...(bytes ? { sha256: sha256(bytes) } : {}), ...(target ? { target: target.toString('base64') } : {}) })) };
}
/** Creator export from one capture; the encoded size is bounded before any base64 string exists. */
export function exportOf(capture, cap) {
  const files = [...capture.entries].filter(([, entry]) => entry.kind === 'file');
  const encoded = files.reduce((sum, [token, entry]) => sum + 4 * Math.ceil(entry.bytes.length / 3) + 6 * Buffer.byteLength(token) + 8, 0);
  assert(encoded <= cap, `Prepared export cap exceeded before encoding: ${encoded} > ${cap} bytes`);
  return Object.fromEntries(files.map(([token, entry]) => [token, entry.bytes.toString('base64')]));
}
export function requestBudget(maximum) {
  let used = 0;
  return (dispatch, request) => {
    assert(used < maximum, 'Path request budget exhausted before dispatch');
    used++;
    return dispatch(request);
  };
}
