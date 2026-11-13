import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npm = process.env.npm_execpath;
assert(npm, 'Run this check with npm run verify:package.');

function run(command, args, cwd = root, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function runNpm(args, cwd = root) {
  return run(process.execPath, [npm, ...args], cwd);
}

const temporary = mkdtempSync(join(tmpdir(), 'switchboard-package-'));
try {
  process.stdout.write(runNpm(['run', 'build']));
  const artifacts = join(temporary, 'artifacts');
  const consumer = join(temporary, 'consumer');
  mkdirSync(artifacts);
  mkdirSync(consumer);

  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', artifacts]));
  assert.equal(packed.length, 1, 'Pack produces one package.');
  const [pack] = packed;
  const files = pack.files.map(({ path }) => path).sort();
  const buildFiles = readdirSync(join(root, 'dist'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
  assert(buildFiles.length > 0, 'The build emits package files.');
  assert(buildFiles.every((path) => /\.(?:js|d\.ts)$/.test(path)), 'Only JavaScript and declarations ship from dist.');
  assert.deepEqual(files, [
    'LICENSE',
    'README.md',
    ...buildFiles,
    'docs/architecture/boundaries.md',
    'package.json',
  ].sort(), 'The package contains only its public build, manifest, license, and README.');
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);

  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  process.stdout.write(runNpm([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', join(artifacts, pack.filename),
    `@types/node@${manifest.devDependencies['@types/node']}`,
  ], consumer));

  const installed = join(consumer, 'node_modules', ...manifest.name.split('/'));
  assert.equal(readFileSync(join(installed, 'LICENSE'), 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(installedManifest.exports, {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  });
  assert.equal(installedManifest.private, true);
  assert.equal(Object.keys(installedManifest.dependencies ?? {}).length, 0);

  writeFileSync(join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import * as switchboard from '${manifest.name}';
assert.equal(typeof switchboard, 'object');
assert.equal(typeof switchboard.createEventStream, 'function');
await assert.rejects(import('${manifest.name}/dist/index.js'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
});
`);
  run(process.execPath, ['runtime.mjs'], consumer);

  const fixtures = readdirSync(join(root, 'tests/core')).sort();
  const typeFixtures = fixtures.filter((file) => file.endsWith('.test.ts'));
  const runtimeFixtures = fixtures.filter((file) => file.endsWith('.consumer.mjs'));
  assert(typeFixtures.length > 0, 'Public type fixtures exist.');
  assert(runtimeFixtures.length > 0, 'Installed runtime helper fixtures exist.');
  for (const file of [...typeFixtures, ...runtimeFixtures]) {
    copyFileSync(join(root, 'tests/core', file), join(consumer, file));
  }
  const runtimeEnvironment = { ...process.env };
  delete runtimeEnvironment.NODE_TEST_CONTEXT;
  const runtimeOutput = run(process.execPath, ['--test', '--test-reporter=tap', ...runtimeFixtures], consumer, runtimeEnvironment);
  assert.match(runtimeOutput, /^# tests [1-9]\d*$/m, 'Installed runtime helper tests execute.');
  process.stdout.write(runtimeOutput);
  const consumerConfig = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022'],
      types: ['node'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      skipLibCheck: false,
      noEmit: true,
    },
    files: typeFixtures,
  };
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(consumerConfig));
  const compilerManifest = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8'));
  const compiler = join(root, 'node_modules/typescript', compilerManifest.bin.tsc);
  run(process.execPath, [compiler, '-p', join(consumer, 'tsconfig.json')], consumer);

  const invalidCases = [
    ['unnarrowed-capability', 'catalog.api;', 2339],
    ['unsupported-api', "if (catalog.kind === 'unsupported') catalog.api;", 2339],
    ['unavailable-api', "if (catalog.kind === 'unavailable') catalog.api;", 2339],
    ['unsupported-literal', "const invalid = { kind: 'unsupported', reason: 'Absent.', api: catalogApi } satisfies Capability<Catalog>;", 2353],
    ['unavailable-literal', "const invalid = { kind: 'unavailable', reason: 'Disabled.', api: catalogApi } satisfies Capability<Catalog>;", 2353],
    ['supported-literal', "const invalid = { kind: 'supported' } satisfies Capability<Catalog>;", 1360],
    ['wrong-api', "const invalid: Capability<Catalog> = { kind: 'supported', api: { listModels: async () => ({ kind: 'ok', value: [{ id: 'a', contextWindow: 'large' }] }) } };", 2322],
    ['wrong-arguments', "if (catalog.kind === 'supported') await catalog.api.listModels({ provider: 42 });", 2322],
    ['wrong-result', "if (catalog.kind === 'supported') { const models = await catalog.api.listModels({ provider: 'acme' }); if (models.kind === 'ok') { const invalid: readonly { id: number }[] = models.value; } }", 2322],
    ['wrong-options', "registration.open({ executable: 'acme' });", 2353],
    ['wrong-identity', "const invalid: AdapterRegistration<Options, ExampleAdapter> = { identity: { ...identity, engine: 'other/engine' }, open: openExample };", 2322],
    ['missing-cleanup', 'const invalid: ExampleAdapter = { identity, capabilities: { modelCatalog: catalog } };', 2741],
    ['factory-variance', 'declare const restricted: AdapterRegistration<Options & { readonly token: string }, ExampleAdapter>; const invalid: AdapterRegistration<Options, ExampleAdapter> = restricted;', 2322],
    ['unknown-native-data', 'extension.data.modelAlias;', 18046],
    ['typed-native-data', 'const invalid: number = nativeData.data.modelAlias;', 2322],
    ['unnarrowed-outcome', 'opened.value;', 2339],
    ['unsupported-error', "const invalid: AdapterError = { code: 'unsupported', message: 'Absent.' };", 2322],
    ['session-kind', `import type { SessionReference } from '${manifest.name}'; import { sessionBinding } from './sessions.test.js'; const invalid: SessionReference = { kind: 'checkpoint', formatVersion: 1, binding: sessionBinding, opaque: 'x' };`, 2322],
    ['session-checkpoint', `import type { CheckpointReference } from '${manifest.name}'; import { sessionReference } from './sessions.test.js'; const invalid: CheckpointReference = sessionReference;`, 2741],
    ['session-readonly', "import { sessionReference } from './sessions.test.js'; sessionReference.binding.account = 'other';", 2540],
    ['observer-publication', "import { observer } from './events.test.js'; observer.publish(1);", 2339],
    ['event-payload', "import { events } from './events.test.js'; events.publish({ vendorKind: 'usage', usage: { tokens: 'three' } });", 2322],
    ['event-listener', "import { observer } from './events.test.js'; observer.subscribe((event: number) => {});", 2345],
    ['event-native-cancel', `import { createEventStream } from '${manifest.name}'; createEventStream({ maxObservers: 1, capacity: 1, cancelNative() {} });`, 2353],

    ["auth-direct-material", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; const invalid = { ...directConfig, resolve: () => 42 } satisfies AuthConfiguration<Awaited<ReturnType<typeof directResolver>>>;", 2322],
    ["auth-invocation-request", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; scoped.resolve({ boundary: 'invocation', invocationId: 'run', requestId: 'bad' }, signal);", 2353],
    ["auth-proxy-endpoint", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; const invalid = { kind: 'litellm', credentialPurpose: 'litellm-proxy', model: 'alias', protocol: 'native', resolve: proxyResolver } satisfies AuthConfiguration<unknown>;", 1360],
    ["auth-proxy-material", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; const invalid = { ...proxyConfig, resolve: directResolver } satisfies AuthConfiguration<unknown>;", 1360],
    ["auth-proxy-purpose", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; const invalid = { kind: 'litellm', endpoint: 'http://private/root', model: 'alias', protocol: 'native', resolve: proxyResolver } satisfies AuthConfiguration<unknown>;", 1360],
    ["auth-readonly-context", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; declare const context: AuthResolutionContext; context.scope.account = 'other';", 2540],
    ["auth-request-id", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; scoped.resolve({ boundary: 'request', invocationId: 'run' }, signal);", 2345],
    ["auth-unnarrowed-material", "import type { AuthConfiguration, AuthResolutionContext, ResolvedAuthentication } from '@mattsp1290/switchboard'; import { directConfig, proxyConfig, directResolver, proxyResolver, scoped, signal } from './auth.test.js'; declare const resolved: ResolvedAuthentication<unknown>; resolved.material.token;", 18046],

    ["interaction-kind", "import type { InteractionContinuation } from '@mattsp1290/switchboard'; import { toolOutcome } from './interaction.test.js'; const invalid: InteractionContinuation = { formatVersion: 1, kind: 'approval', outcome: toolOutcome };", 2353],
    ["interaction-tool-target", "import type { ToolOutcome } from '@mattsp1290/switchboard'; import { toolOutcome, approvalTarget } from './interaction.test.js'; const invalid: ToolOutcome = { ...toolOutcome, target: approvalTarget };", 2741],
    ["interaction-delegation-target", "import type { DelegatedOutcome } from '@mattsp1290/switchboard'; import { toolTarget } from './interaction.test.js'; const invalid: DelegatedOutcome = { kind: 'cancelled', target: toolTarget, delivery: { kind: 'unknown' } };", 2741],
    ["interaction-withhold", "import type { InteractionContinuation } from '@mattsp1290/switchboard'; const invalid: InteractionContinuation = { formatVersion: 1, kind: 'withhold' };", 2322],
    ["interaction-unknown-effect", "import type { ToolEffect } from '@mattsp1290/switchboard'; declare const effect: ToolEffect; effect.effect;", 2339],
    ["interaction-unknown-delivery", "import type { NativeDelivery } from '@mattsp1290/switchboard'; declare const delivery: NativeDelivery; delivery.evidence;", 2339],
    ["interaction-cancelled-result", "import type { DelegatedOutcome } from '@mattsp1290/switchboard'; declare const child: DelegatedOutcome; if (child.kind === 'cancelled') child.result;", 2339],
    ["interaction-readonly", "import { approval } from './interaction.test.js'; approval.choices[0]!.label = 'changed';", 2540],
    ["interaction-unknown-data", "import { native } from './interaction.test.js'; native.data.opaque;", 18046],
    ['private-import', `import '${manifest.name}/dist/core/contracts.js';`, 2882],
  ];
  const prelude = [
    `import type { AdapterError, AdapterRegistration, Capability } from '${manifest.name}';`,
    "import type { Catalog, ExampleAdapter, Options } from './contracts.test.js';",
    "import { catalog, catalogApi, extension, identity, nativeData, opened, openExample, registration } from './contracts.test.js';",
  ].join('\n');
  const invalidFiles = invalidCases.map(([name, source]) => {
    const file = `${name}.mts`;
    writeFileSync(join(consumer, file), `${prelude}\n${source}\n`);
    return file;
  });
  writeFileSync(join(consumer, 'invalid.json'), JSON.stringify({ ...consumerConfig, files: invalidFiles }));
  const rejected = spawnSync(process.execPath, [compiler, '-p', 'invalid.json', '--pretty', 'false'], {
    cwd: consumer,
    encoding: 'utf8',
  });
  assert.ifError(rejected.error);
  assert.equal(rejected.signal, null);
  assert.equal(rejected.status, 1, `Invalid consumers fail type checking.\n${rejected.stdout}\n${rejected.stderr}`);
  assert.equal(rejected.stderr, '');
  const diagnostics = [...rejected.stdout.matchAll(/^([^\n]+)\((\d+),(\d+)\): error TS(\d+):/gm)]
    .map((match) => ({ file: match[1], line: Number(match[2]), code: Number(match[4]) }));
  assert.equal(diagnostics.length, (rejected.stdout.match(/error TS\d+:/g) ?? []).length, rejected.stdout);
  const expected = invalidCases.map(([name, , code]) => ({ file: `${name}.mts`, line: 4, code }));
  const byFile = (left, right) => left.file.localeCompare(right.file);
  assert.deepEqual(diagnostics.sort(byFile), expected.sort(byFile), rejected.stdout);
  console.log(`Verified ${manifest.name}@${manifest.version} with ${process.version} on ${process.platform}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
