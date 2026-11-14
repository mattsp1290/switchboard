import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function command(executable, args, cwd, env, evidence, timeout = 120_000) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(evidence, JSON.stringify({ executable, args, cwd, ...result, error: result.error?.message }, null, 2));
  return result;
}

export function successful(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

export function compilerPolicy(files, dom = false, emit = false) {
  return {
    compilerOptions: {
      target: 'ES2022',
      lib: dom ? ['ES2022', 'DOM'] : ['ES2022'],
      types: ['node'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      skipLibCheck: false,
      noEmitOnError: true,
      forceConsistentCasingInFileNames: true,
      noEmit: !emit,
      ...(emit ? { declaration: true, rootDir: 'src', outDir: 'dist' } : {}),
    },
    files,
  };
}

export function exactDiagnostics(result, expected) {
  assert(expected.length > 0, 'A rejected program requires attributed diagnostics.');
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  for (const line of result.stdout.trimEnd().split('\n')) {
    assert(/^(?:[^\n]+\(\d+,\d+\): error TS\d+:|\s|$)/.test(line), `Unexpected compiler output: ${line}`);
  }
  const actual = [...result.stdout.matchAll(/^([^\n]+)\((\d+),(\d+)\): error TS(\d+):/gm)]
    .map((match) => ({ file: match[1].replaceAll('\\', '/'), line: Number(match[2]), code: Number(match[4]) }));
  assert.equal(actual.length, (result.stdout.match(/error TS\d+:/g) ?? []).length, result.stdout);
  const order = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code - b.code;
  assert.deepEqual(actual.sort(order), [...expected].sort(order), result.stdout);
}

export function inside(file, directory) {
  const path = relative(directory, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

export function assertClosure(files, allowedRoots, allowedFiles) {
  assert(files.length > 0, 'Compiler closure is nonempty.');
  const roots = allowedRoots.map((path) => realpathSync(path));
  const exact = new Set(allowedFiles.map((path) => realpathSync(path)));
  for (const file of files) {
    assert(isAbsolute(file), `Absolute compiler path required: ${file}`);
    const actual = realpathSync(file);
    assert.equal(actual, file, `Compiler closure cannot use symlinks: ${file}`);
    assert(exact.has(actual) || /\.d\.(?:ts|mts|cts)$/.test(actual), `Unexpected compiler source: ${actual}`);
    assert(exact.has(actual) || roots.some((root) => inside(actual, root)
      && !relative(root, actual).split(sep).includes('node_modules')), `Foreign compiler file: ${actual}`);
  }
}

export function nodeDeclarationRoots(project) {
  const root = resolve(project, 'node_modules/@types/node');
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return [root, ...Object.keys(manifest.dependencies ?? {}).map((name) => resolve(project, 'node_modules', name))];
}

export function compilerLibraryRoots(project) {
  const root = resolve(project, 'node_modules/typescript');
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const installed = Object.entries(manifest.optionalDependencies ?? {})
    .filter(([name]) => existsSync(resolve(project, 'node_modules', name)))
    .map(([name, version]) => {
      const directory = resolve(project, 'node_modules', name);
      assert.equal(JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).version, version);
      return resolve(directory, 'lib');
    });
  assert(installed.length > 0, 'TypeScript platform compiler must be installed.');
  return [resolve(root, 'lib'), ...installed];
}

export function assertEmitted(packageRoot) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  const owned = (specifier, base, exported = false) => {
    assert(typeof specifier === 'string' && (exported ? specifier.startsWith('./') : /^\.\.?\//.test(specifier)),
      `Owned ESM requires a relative URL: ${specifier}`);
    assert(!/[?#\\]/.test(specifier) && !/%(?:2f|5c)/i.test(specifier),
      `Unsupported emitted URL syntax: ${specifier}`);
    if (exported) assert(!decodeURIComponent(specifier.slice(2)).split('/').some((part) => /^(?:\.{1,2}|node_modules)$/i.test(part)),
      `Invalid public export target: ${specifier}`);
    const file = fileURLToPath(new URL(specifier, base));
    assert.equal(extname(file), '.js', `Owned ESM requires explicit .js: ${specifier}`);
    assert(inside(file, packageRoot) && existsSync(file), `Missing emitted relative import: ${specifier}`);
    assert.equal(realpathSync(file), file, 'Emitted files cannot be symlinks.');
    return file;
  };
  const root = pathToFileURL(`${packageRoot}${sep}`);
  const pending = Object.values(manifest.exports).map((entry) => owned(entry.import, root, true));
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    assert(!/\b(?:import|from)\s*\/[/*]/.test(source), 'Commented import syntax needs explicit emitted inspection.');
    assert(!/\bimport\s*\((?!\s*(?:"[^"\\\r\n]*"|'[^'\\\r\n]*')\s*\))/.test(source),
      'Dynamic imports require a complete unescaped quoted literal argument.');
    const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(?=["'])/g;
    const literal = /(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')/y;
    for (const match of source.matchAll(imports)) {
      literal.lastIndex = match.index + match[0].length;
      const quoted = literal.exec(source);
      assert(quoted, 'Emitted imports require complete unescaped quoted literal specifiers.');
      const specifier = quoted[1] ?? quoted[2];
      if (specifier.startsWith('.')) pending.push(owned(specifier, pathToFileURL(file)));
      else assert((specifier.startsWith('node:') && isBuiltin(specifier))
        || /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/i.test(specifier),
      `Unsupported emitted import specifier: ${specifier}`);
    }
  }
  return [...seen];
}
