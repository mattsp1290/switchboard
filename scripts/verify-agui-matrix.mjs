import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(await readFile(join(root, 'docs/protocol/ag-ui-pin.json'), 'utf8'));
const readRows = async (file) => (await readFile(join(root, file), 'utf8')).split('\n').filter(Boolean).slice(1).map((line) => line.split('\t'));
const rows = await readRows('docs/protocol/ag-ui-matrix.tsv');
const fixtures = await readRows('tests/agui/fixtures/upstream.tsv');
assert.equal(rows.length, 98, 'Pinned definition count');
assert.equal(fixtures.length, 219, 'Pinned upstream fixture count');
const cache = process.env.AGUI_ARTIFACT_CACHE ?? join(tmpdir(), 'switchboard-agui-pins');
const sha = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const sorted = (values) => [...values].sort();
const list = (value) => value ? value.split(',') : [];
async function pinned(path, url, hash) {
  const target = join(cache, path);
  let bytes;
  try { bytes = await readFile(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    assert(response.ok, `${response.status} fetching ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha(bytes), hash, `SHA-256 ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  assert.equal(sha(bytes), hash, `SHA-256 ${path}`);
  return bytes;
}
const source = async (path, hash) => {
  if (process.env.AGUI_SOURCE_ROOT) {
    const bytes = await readFile(join(process.env.AGUI_SOURCE_ROOT, path));
    assert.equal(sha(bytes), hash, `source SHA-256 ${path}`);
    return bytes;
  }
  return pinned(`upstream/${path}`, `${pin.sourceBase}${path}`, hash);
};
const schema = JSON.parse(await source('spec/1.0/schema.json', pin.upstreamFiles['spec/1.0/schema.json']));
const corpus = (await source('spec/1.0/fixtures/MANIFEST.txt', pin.upstreamFiles['spec/1.0/fixtures/MANIFEST.txt'])).toString();
assert.deepEqual(sorted(fixtures.map(([path]) => path)), sorted(corpus.split('\n').filter((line) => line.endsWith('.json') && !line.endsWith('.expect.json'))));
assert.deepEqual(sorted(rows.map(([name]) => name)), sorted(Object.keys(schema.$defs)));
assert.equal(rows.length, new Set(rows.map(([name]) => name)).size);
assert.equal(fixtures.length, new Set(fixtures.map(([path]) => path)).size);
assert.equal(sha(await readFile(join(root, 'tests/agui/fixtures/UPSTREAM-LICENSE'))), pin.upstreamFiles.LICENSE);
const flatten = (name) => {
  const def = schema.$defs[name];
  const properties = {}, required = new Set(def.required);
  for (const parent of def.allOf ?? []) {
    const inherited = flatten(parent.$ref.split('/').at(-1));
    Object.assign(properties, inherited.properties);
    for (const key of inherited.required) required.add(key);
  }
  return { properties: Object.assign(properties, def.properties), required: sorted(required) };
};
const sample = (def) => {
  if (def.$ref) return sample(schema.$defs[def.$ref.split('/').at(-1)]);
  if ('const' in def) return def.const;
  if (def.enum) return def.enum[0];
  if (def.oneOf ?? def.anyOf) return sample((def.oneOf ?? def.anyOf)[0]);
  if (def.type === 'array') return Array.from({ length: def.minItems ?? 0 }, () => sample(def.items));
  if (def.type === 'string') return '';
  if (def.type === 'integer' || def.type === 'number') return def.minimum ?? 0;
  if (def.type === 'boolean') return false;
  const result = {};
  for (const parent of def.allOf ?? []) Object.assign(result, sample(parent));
  for (const key of def.required ?? []) result[key] = sample(def.properties?.[key] ?? flatten(def.$anchor).properties[key]);
  return result;
};
const cases = rows.map(([definition]) => ({ definition, value: sample(schema.$defs[definition]), expected: true }));
for (const [definition, , , , required, defaults] of rows) {
  const def = schema.$defs[definition];
  for (const variant of def.oneOf ?? def.enum?.map((value) => ({ const: value })) ?? []) {
    cases.push({ definition, value: sample(variant), expected: true });
  }
  for (const key of list(required)) {
    const value = sample(def);
    delete value[key];
    cases.push({ definition, value, expected: false, ts: false, py: list(defaults).includes(key) });
  }
}
for (let offset = 0; offset < fixtures.length; offset += 12) {
  const batch = await Promise.all(fixtures.slice(offset, offset + 12).map(async ([path, hash, ts, py]) => ({
    definition: path.split('/')[0], path, value: JSON.parse(await source(`spec/1.0/fixtures/${path}`, hash)),
    expected: path.includes('/valid/'), ts: ts === 'true', py: py === 'true',
  })));
  cases.push(...batch);
}
const arguments_ = process.argv.slice(2);
assert(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === '--emitted-events'),
  'Usage: verify-agui-matrix.mjs [--emitted-events /absolute/path/to/events.jsonl]');
const emitted = arguments_.length === 0 ? [] : (await readFile(resolve(arguments_[1]), 'utf8'))
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));
if (arguments_.length > 0) assert(emitted.length > 0, 'Installed tests collected actual output.');
assert.equal(new Set(emitted.map((item) => item.path)).size, emitted.length, 'Collected case names are unique.');
for (const item of emitted) {
  assert.equal(item.definition, 'Event');
  assert.equal(item.expected, true);
  assert.equal(item.ts, true);
  assert.equal(item.py, true);
  assert.equal(typeof item.path, 'string');
  assert(['sdk-sentinel', 'switchboard-projection'].includes(item.origin), 'Output evidence has explicit provenance.');
}
cases.push(...emitted);
const scratch = await mkdtemp(join(tmpdir(), 'switchboard-agui-sdk-'));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: scratch, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined, `${command} must be installed`);
  assert.equal(result.status, 0, `${command} failed\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
try {
  for (const artifact of pin.artifacts) {
    const bytes = await pinned(artifact.file, artifact.url, artifact.sha256);
    if (artifact.integrity) assert.equal(`sha512-${sha(bytes, 'sha512', 'base64')}`, artifact.integrity);
    await writeFile(join(scratch, artifact.file), bytes);
  }
  const tools = pin.verifierTools;
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    `./${pin.artifacts[0].file}`, `zod@${tools.zod}`, `ajv@${tools.ajv}`]);
  const require = createRequire(join(scratch, 'package.json'));
  const sdk = require('@ag-ui/core'), validators = require('@ag-ui/core/schemas');
  assert.equal(require('@ag-ui/core/package.json').version, pin.artifacts[0].version);
  assert.equal(sdk.PROTOCOL_VERSION, pin.protocol);
  const events = rows.filter((row) => row[2]).map((row) => row[2]);
  assert.deepEqual(sorted(Object.values(sdk.EventType)), sorted(events));
  const packageDir = dirname(require.resolve('@ag-ui/core/package.json'));
  const declarations = await readFile(join(packageDir, 'dist', 'version-DEKfpZNa.d.ts'), 'utf8');
  const declared = new Set([...declarations.matchAll(/(?:type|enum) (\w+)\s*(?:=|\{)/g)].map((match) => match[1]));
  const publicDeclarations = await readFile(join(packageDir, 'dist', 'index.d.ts'), 'utf8');
  const publicNames = new Set([...publicDeclarations.matchAll(/export \{([^}]+)\};/g)].flatMap((match) =>
    match[1].split(',').map((name) => name.trim().split(/\s+as\s+/).at(-1).replace(/^type /, ''))));
  for (const [name, category, event, fields, required] of rows) {
    assert(pin.categories[category] && declared.has(name), `${name} needs classification and published TypeScript declaration`);
    assert(publicNames.has(name), `${name} TypeScript public export`);
    const shape = validators[`${name}Schema`]?.shape;
    assert(validators[`${name}Schema`], `published schema ${name}`);
    assert.equal(event, schema.$defs[name].properties?.type?.const?.match(/^[A-Z_]+$/)?.[0] ?? '', name);
    const canonical = flatten(name);
    assert.deepEqual(list(fields), sorted(Object.keys(canonical.properties)), `${name} canonical fields`);
    assert.deepEqual(list(required), canonical.required, `${name} canonical required fields`);
    if (shape) {
      assert.deepEqual(sorted(Object.keys(shape)), list(fields), `${name} TypeScript fields`);
      assert.deepEqual(sorted(Object.keys(shape).filter((key) => !shape[key].isOptional())), list(required), `${name} TypeScript required fields`);
    }
  }
  const Ajv = require('ajv/dist/2020.js').default, ajv = new Ajv({ strict: false });
  ajv.addSchema(schema);
  for (const item of cases) {
    const label = item.path ?? item.definition;
    assert.equal(ajv.getSchema(`${schema.$id}#/$defs/${item.definition}`)(item.value), item.expected, `${label} canonical acceptance`);
    assert.equal(validators[`${item.definition}Schema`].safeParse(item.value).success, item.ts ?? true, `${label} TypeScript acceptance`);
  }
  const python = JSON.parse(run('uv', ['run', '--python', tools.python, '--isolated', '--no-project',
    '--with', join(scratch, pin.artifacts[1].file), '--with', `pydantic==${tools.pydantic}`,
    'python', join(root, 'tests/agui/compare-python.py')], { input: JSON.stringify({ definitions: rows.map(([name]) => name), cases }) }));
  assert.equal(python.version, pin.artifacts[1].version);
  assert.equal(python.protocol, pin.protocol);
  assert.deepEqual(sorted(python.events), sorted(events));
  for (const [name, , , fields, required, defaults, exported] of rows) {
    assert.equal(python.public[name], exported === 'true', `${name} Python public export`);
    const actual = python.fields[name];
    if (!actual) continue;
    assert.deepEqual(actual.fields, list(fields), `${name} Python fields`);
    assert.deepEqual(actual.required, list(required).filter((key) => !list(defaults).includes(key)), `${name} Python defaults`);
  }
  assert.deepEqual(python.accepted, cases.map((item) => item.py ?? true), 'Python fixture acceptance');
  console.log(`Installed output verified: ${emitted.filter((item) => item.origin === 'switchboard-projection').length} Switchboard events; ${emitted.filter((item) => item.origin === 'sdk-sentinel').length} SDK sentinels (not mapping evidence).`);
  console.log(`AG-UI ${pin.protocol}: ${events.length} events, ${rows.length} definitions, ${fixtures.length} pinned fixtures verified against canonical schema and both published SDKs.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
