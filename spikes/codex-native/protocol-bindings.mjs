import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const fileName = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts(?![\s\S])/;
const tokens = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
const declaration = /^(?:import type \{ [\w$ ,]+ \}|export (?:type )?(?:\{ [\w$ ,]+ \}|\*)) from ("[^"]+") ;$/;

export function transformBindings(inventory) {
  assert(inventory !== null && typeof inventory === 'object' && !Array.isArray(inventory), 'Binding inventory must be an object');
  assert([Object.prototype, null].includes(Object.getPrototypeOf(inventory)), 'Binding inventory must be plain');
  const entries = Reflect.ownKeys(inventory).map((file) => {
    assert(typeof file === 'string' && fileName.test(file), 'Invalid binding path');
    const entry = Object.getOwnPropertyDescriptor(inventory, file);
    assert(entry.enumerable && Object.hasOwn(entry, 'value') && typeof entry.value === 'string', 'Binding source must be a string data property');
    return [file, entry.value];
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert(entries.length > 0, 'Binding inventory must not be empty');
  const names = new Set(entries.map(([file]) => file));
  const files = Object.create(null);
  let transformedImports = 0;
  for (const [file, source] of entries) {
    const lexical = [...source.matchAll(tokens)].filter(([token]) => !token.startsWith('//') && !token.startsWith('/*'));
    const edits = [];
    for (let i = 0; i < lexical.length; i++) {
      const keyword = lexical[i][0];
      if (keyword !== 'import' && keyword !== 'export') continue;
      if (keyword === 'import' && [':', '?'].includes(lexical[i + 1]?.[0])) continue;
      if (keyword === 'export' && lexical[i + 1]?.[0] !== '*' && lexical[i + 1]?.[0] !== '{'
        && !(lexical[i + 1]?.[0] === 'type' && ['{', '*'].includes(lexical[i + 2]?.[0]))) continue;
      const end = lexical.findIndex(([token], index) => index >= i && token === ';');
      assert(end >= i, `Unexpected binding import syntax in ${file}`);
      const statement = lexical.slice(i, end + 1);
      const match = declaration.exec(statement.map(([token]) => token).join(' '));
      assert(match, `Unexpected binding import syntax in ${file}`);
      const quoted = match[1];
      const specifier = quoted.slice(1, -1);
      assert(/^(?:\.\/|(?:\.\.\/)+)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(specifier), `Expected extensionless relative binding import in ${file}`);
      const module = posix.join(posix.dirname(file), specifier);
      assert(module !== '..' && !module.startsWith('../'), `Binding import escapes root in ${file}`);
      const suffix = names.has(`${module}.ts`) ? '.js' : '/index.js';
      assert(names.has(suffix === '.js' ? `${module}.ts` : `${module}/index.ts`), `Dangling binding import in ${file}`);
      const token = statement.at(-2);
      edits.push({ start: token.index + 1, end: token.index + quoted.length - 1, value: specifier + suffix });
      transformedImports++;
      i = end;
    }
    let consumed = source;
    for (const edit of edits.reverse()) consumed = consumed.slice(0, edit.start) + edit.value + consumed.slice(edit.end);
    files[file] = consumed;
  }
  return {
    files, transformedImports,
    sourceSha256: sha256(JSON.stringify(entries)),
    consumedSha256: sha256(JSON.stringify(Object.entries(files))),
  };
}

export function assertSelectedBinding(generated, selected) {
  assert(typeof generated === 'string' && typeof selected === 'string', 'Selected binding sources must be strings');
  const identity = { generatedSha256: sha256(generated), selectedSha256: sha256(selected) };
  assert(generated === selected, `Selected RequestId byte mismatch ${JSON.stringify({
    ...identity, generatedSource: generated.slice(0, 4096), truncated: generated.length > 4096,
  })}`);
  return identity;
}
