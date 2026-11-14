import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertSelectedBinding, selectedRequestIdSha256, transformBindings } from '../../spikes/codex-native/protocol-bindings.mjs';

const root = new URL('../../', import.meta.url);
const selected = readFileSync(new URL('src/adapters/codex/protocol/RequestId.ts', root), 'utf8');
const hash = (source) => createHash('sha256').update(source).digest('hex');
const leafHash = 'beeb38dfd0b050b171141bd66d51663786a50a81cbe904ba9b006289a101fd39';
const noticeHashes = [
  ['licenses/codex-APACHE-2.0.txt', 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'],
  ['licenses/codex-NOTICE.txt', '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'],
];
const selectedOracle = (source) => assert.equal(hash(source), leafHash, 'selected-leaf-integrity');
const indexOracle = (transform) => {
  const result = transform({ 'A.ts': 'import type { B } from "./B";\n', 'B/index.ts': 'export type B = string;\n' });
  assert.equal(result.transformedImports, 1, 'index-rewrite-entered');
  assert.equal(result.files['A.ts'], 'import type { B } from "./B/index.js";\n', 'directory-index-resolution');
};
const intendedFailure = (name) => (error) => error.code === 'ERR_ASSERTION' && error.message.includes(name);

test('selected binding and upstream notices retain exact bytes', () => {
  selectedOracle(selected);
  assert.equal(selectedRequestIdSha256, leafHash, 'production-pin-matches-independent-oracle');
  for (const [file, expected] of noticeHashes) assert.equal(hash(readFileSync(new URL(file, root))), expected, file);
  const provenance = readFileSync(new URL('THIRD_PARTY_NOTICES.md', root), 'utf8');
  for (const digest of [leafHash, ...noticeHashes.map(([, digest]) => digest)]) assert(provenance.includes(digest));
  assert(provenance.includes('d32063f96c2dff1dc96af839b3952abb6acfeda4'));
  const identity = assertSelectedBinding(selected, selected);
  assert.deepEqual(identity, { generatedSha256: leafHash, selectedSha256: leafHash });
  const result = transformBindings({ 'RequestId.ts': selected });
  assert.equal(result.files['RequestId.ts'], selected);
  assert.equal(result.transformedImports, 0);
});

test('directory index, sibling preference, nested parent and exports resolve', () => {
  indexOracle(transformBindings);
  const inventory = {
    'A.ts': 'import type { B } from "./B";\nexport type { B } from "./B";\n',
    'B.ts': 'export type B = string;\n',
    'B/index.ts': 'export type B = number;\n',
    'nested/deep/C.ts': 'import type { B } from "../../B";\nexport * from "../../B";\nexport type * from "../../B";\n',
  };
  const result = transformBindings(inventory);
  assert.equal(result.transformedImports, 5);
  assert.equal(result.files['A.ts'], inventory['A.ts'].replaceAll('./B', './B.js'));
  assert.equal(result.files['nested/deep/C.ts'], inventory['nested/deep/C.ts'].replaceAll('../../B', '../../B.js'));
  assert.equal(result.files['B/index.ts'], inventory['B/index.ts']);
  assert.equal(inventory['A.ts'], 'import type { B } from "./B";\nexport type { B } from "./B";\n');
  const reordered = transformBindings(Object.fromEntries(Object.entries(inventory).reverse()));
  assert.equal(result.sourceSha256, reordered.sourceSha256);
  assert.equal(result.consumedSha256, reordered.consumedSha256);
  assert.notEqual(result.sourceSha256, result.consumedSha256);
  const namespaces = transformBindings({
    'index.ts': 'export * as v2 from "./v2";\nexport type * as v3 from "./v3";\nimport type * as V2 from "./v2";\n',
    'v2/index.ts': 'export type { X } from "./X";\n',
    'v2/X.ts': 'export type X = string;\n',
    'v3/index.ts': 'export type Y = string;\n',
  });
  assert.equal(namespaces.transformedImports, 4);
  assert.equal(namespaces.files['index.ts'], 'export * as v2 from "./v2/index.js";\nexport type * as v3 from "./v3/index.js";\nimport type * as V2 from "./v2/index.js";\n');
  assert.equal(namespaces.files['v2/index.ts'], 'export type { X } from "./X.js";\n');
});

test('only actual module specifiers change while notices and source remain exact', () => {
  const source = '// GENERATED! import type { Missing } from "./Missing";\n'
    + '/* export * from "./Absent"; */\n'
    + 'import /* retained */ type { B } from "./B";\n'
    + 'export type A = { import: string; importOptional?: string; value: "from \\\"./Missing\\\""; text: `import("./Missing")` };\n';
  const result = transformBindings({ 'A.ts': source, 'B.ts': selected });
  assert.equal(result.transformedImports, 1);
  assert.equal(result.files['A.ts'], source.replace('from "./B"', 'from "./B.js"'));
  assert.equal(result.files['B.ts'], selected);
});

test('malformed inventories and unsafe paths fail before producing a tree', () => {
  for (const inventory of [null, [], 0, '', {}, new Map(), { 'A.ts': null }, { 'A.ts': 0 }]) {
    assert.throws(() => transformBindings(inventory), /inventory|source/);
  }
  for (const file of ['../A.ts', '/A.ts', 'x/../A.ts', 'x//A.ts', 'A.js', 'x\\A.ts', './A.ts', 'x/.A.ts', 'A.ts\n']) {
    assert.throws(() => transformBindings({ [file]: '' }), /Invalid binding path/, file);
  }
  assert.throws(() => transformBindings({ [Symbol('file')]: '' }), /Invalid binding path/);
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'A.ts', { enumerable: true, get() { getterCalls++; return ''; } });
  assert.throws(() => transformBindings(accessor), /string data property/);
  assert.equal(getterCalls, 0);
  assert.throws(() => transformBindings(Object.defineProperty({}, 'A.ts', { value: '' })), /string data property/);
});

test('dangling, escaping, suffixed and unexpected import dialects are rejected', () => {
  for (const specifier of ['./Missing', '../B', '../../B', '/B', 'B', './B.js', './B.ts', './B.json',
    './B/../B', './B//index', './B?query', './B#hash', './B\\index', './']) {
    assert.throws(() => transformBindings({
      'A.ts': `import type { B } from "${specifier}";\n`, 'B.ts': '',
    }), (error) => /Dangling|escapes root|extensionless/.test(error.message)
      && error.message.includes(JSON.stringify(specifier)), specifier);
  }
  for (const source of ["import type { B } from './B';", 'import "./B";', 'import("./B");',
    'import type { B } from "./B"', 'import B from "./B";', 'export * from "external";',
    'export * as from "./B";', 'export type * as 2Bad from "./B";', 'import type * as from "./B";']) {
    assert.throws(() => transformBindings({ 'A.ts': source, 'B.ts': '' }), /syntax|extensionless/, source);
  }
  const huge = 'export * as ' + 'X'.repeat(10000) + ' nope "./B";';
  assert.throws(() => transformBindings({ 'A.ts': huge }), (error) => {
    assert(error.message.startsWith('Unexpected binding import syntax in A.ts: "export * as'));
    return Buffer.byteLength(error.message) < 600;
  });
});

test('selected leaf mismatch retains bounded raw generator evidence without normalization', () => {
  const generated = '// different generator header\n' + selected;
  assert.notEqual(hash(generated), leafHash, 'leaf-mismatch-entered');
  assert.throws(() => assertSelectedBinding(generated, selected), (error) => {
    assert(error.message.includes(hash(generated)));
    assert(error.message.includes(leafHash));
    assert(error.message.includes('different generator header'));
    return error.code === 'ERR_ASSERTION';
  });
  for (const unit of ['x', '\u0001', '"\\', '雪', '😀', '\ud800', '\udc00']) {
    const raw = unit.repeat(10000);
    assert.throws(() => assertSelectedBinding(raw, selected), (error) => {
      assert(Buffer.byteLength(error.message) < 900, 'bounded-leaf-mismatch-diagnostic');
      const evidence = JSON.parse(error.message.slice('Selected RequestId byte mismatch '.length));
      assert(Buffer.byteLength(JSON.stringify(evidence.generatedSource)) <= 512);
      assert(raw.startsWith(evidence.generatedSource));
      assert.equal(evidence.generatedSha256, hash(raw));
      assert.equal(evidence.truncated, true);
      return error.code === 'ERR_ASSERTION';
    });
  }
  assert.throws(() => assertSelectedBinding(undefined, selected), /must be strings/);
});

test('broken controls reach the same index and selected-leaf assertions', async () => {
  const source = readFileSync(new URL('spikes/codex-native/protocol-bindings.mjs', root), 'utf8');
  const changed = source.replace('value: specifier + suffix', "value: specifier + '.js'");
  assert.notEqual(changed, source, 'index-source-mutation-entered');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
  assert.throws(() => indexOracle(mutant.transformBindings), intendedFailure('directory-index-resolution'));
  const changedLeaf = selected.replace('string | number', 'string');
  assert.notEqual(changedLeaf, selected, 'selected-source-mutation-entered');
  assert.throws(() => selectedOracle(changedLeaf), intendedFailure('selected-leaf-integrity'));
});
