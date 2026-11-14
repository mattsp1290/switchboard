import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCoreIsolation } from '../spikes/native-compiler/support/package.mjs';
import { compilerLibraryRoots, nodeDeclarationRoots } from '../spikes/native-compiler/support/compiler.mjs';

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

const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'switchboard-package-')));
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
    './agui': { types: './dist/agui/index.d.ts', import: './dist/agui/index.js' },
  });
  assert.deepEqual(installedManifest.peerDependencies, { '@ag-ui/core': '1.0.4' });
  assert.deepEqual(installedManifest.peerDependenciesMeta, { '@ag-ui/core': { optional: true } });
  assert(!existsSync(join(consumer, 'node_modules/@ag-ui/core')), 'Core consumer has no SDK installed.');
  assert.equal(installedManifest.private, true);
  assert.equal(Object.keys(installedManifest.dependencies ?? {}).length, 0);

  writeFileSync(join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as switchboard from '${manifest.name}';
assert.throws(() => createRequire(import.meta.url).resolve('@ag-ui/core'), { code: 'MODULE_NOT_FOUND' });
assert.equal(typeof switchboard, 'object');
assert.equal(typeof switchboard.createEventStream, 'function');
for (const subpath of ${JSON.stringify(buildFiles.flatMap((path) => [path, path.replace(/^dist\//, '')]))}) {
  await assert.rejects(import('${manifest.name}/' + subpath), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
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
  cpSync(join(root, 'tests/qualification'), join(consumer, 'qualification'), { recursive: true });
  const qualificationFixtures = readdirSync(join(consumer, 'qualification')).filter((file) => file.endsWith('.consumer.mjs'))
    .sort().map((file) => `qualification/${file}`);
  assert(qualificationFixtures.length > 0, 'Installed qualification consumers exist.');
  const runtimeEnvironment = { ...process.env };
  delete runtimeEnvironment.NODE_TEST_CONTEXT;
  const runtimeOutput = run(process.execPath, ['--test', '--test-reporter=tap', ...runtimeFixtures, ...qualificationFixtures], consumer, runtimeEnvironment);
  assert.match(runtimeOutput, /^# tests [1-9]\d*$/m, 'Installed runtime helper tests execute.');
  const { contracts } = await import(new URL('../tests/qualification/harness/contracts.mjs', import.meta.url));
  for (const name of Object.keys(contracts)) {
    assert.match(runtimeOutput, new RegExp(`^ok \\d+ - fake qualification: ${RegExp.escape(name)}$`, 'm'));
  }
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects recovery dispatch$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects false certainty$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects effect-derived delivery$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification rejects ignored subscription abort$/m);
  assert.match(runtimeOutput, /^ok \d+ - qualification isolates rejected continuation inputs$/m);
  process.stdout.write(runtimeOutput);
  const checkedFixtures = [...typeFixtures, 'session-discovery.consumer.mjs'];
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
      allowJs: true,
      checkJs: true,
    },
    files: checkedFixtures,
  };
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(consumerConfig));
  const compilerManifest = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8'));
  const compiler = join(root, 'node_modules/typescript', compilerManifest.bin.tsc);
  const coreTypes = run(process.execPath, [compiler, '-p', 'tsconfig.json', '--listFilesOnly'], consumer);
  assert(!coreTypes.includes('/agui/'), 'Root declarations do not reference the integration.');
  assert(!coreTypes.includes('/@ag-ui/'), 'Root declarations do not reference the SDK.');
  assertCoreIsolation(consumer, coreTypes.trim().split('\n'), {
    allowedRoots: [...compilerLibraryRoots(root), ...nodeDeclarationRoots(consumer), installed],
    allowedFiles: checkedFixtures.map(file => join(consumer, file)),
  });
  run(process.execPath, [compiler, '-p', 'tsconfig.json'], consumer);

  const discoveryImports = `import type { SessionDiscoveryDiagnostic, SessionDiscoveryPage, SessionReference, SessionInspection, DispatchTarget } from '${manifest.name}'; import { fileDiagnostic, observedPage, sessionReference } from './sessions.test.js';`;
  const discoveryInvalidCases = [
    ['page-missing-diagnostics', "const invalid: SessionDiscoveryPage = { kind: 'complete', sessions: [], examined: 0, skipped: { corrupt: 0, inaccessible: 0 } };", 2322],
    ['page-missing-reason', "const invalid: SessionDiscoveryPage = { ...observedPage, kind: 'truncated' };", 2322],
    ['page-invalid-reason', "const invalid: SessionDiscoveryPage = { ...observedPage, kind: 'truncated', reason: 'bytes' };", 2322],
    ['page-complete-reason', "const invalid: SessionDiscoveryPage = { kind: 'complete', sessions: [], examined: 0, skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [], reason: 'results' };", 2353],
    ['page-cancelled-reason', "const invalid: SessionDiscoveryPage = { kind: 'cancelled', sessions: [], examined: 0, skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [], reason: 'results' };", 2353],
    ['diagnostic-rpc', "const raw = { code: -32603, message: '/private/file' }; const invalid: SessionDiscoveryDiagnostic = raw;", 2739],
    ['diagnostic-message', "const invalid: SessionDiscoveryDiagnostic = { kind: 'file-inspection-failed', subject: { kind: 'discovery-file', token: '1' }, message: 'raw' };", 2353],
    ['diagnostic-error', "const invalid: SessionDiscoveryDiagnostic = { kind: 'file-inspection-failed', subject: { kind: 'discovery-file', token: '1' }, error: { code: -32603 } };", 2353],
    ['diagnostic-path', "const invalid: SessionDiscoveryDiagnostic = { kind: 'file-inspection-failed', subject: { kind: 'discovery-file', token: '1' }, path: '/private/file' };", 2353],
    ['diagnostic-session-subject', "const invalid: SessionDiscoveryDiagnostic = { kind: 'file-inspection-failed', subject: sessionReference };", 2741],
    ['diagnostic-reference', "const invalid: SessionReference = fileDiagnostic;", 2739],
    ['subject-reference', "const invalid: SessionReference = fileDiagnostic.subject;", 2739],
    ['diagnostic-inspection', "declare const inspection: SessionInspection<unknown>; declare const access: Parameters<typeof inspection.inspect>[0]; inspection.inspect({ ...access, reference: fileDiagnostic });", 2739],
    ['subject-inspection', "declare const inspection: SessionInspection<unknown>; declare const access: Parameters<typeof inspection.inspect>[0]; inspection.inspect({ ...access, reference: fileDiagnostic.subject });", 2739],
    ['diagnostic-dispatch', "const invalid: DispatchTarget = { kind: 'session', reference: fileDiagnostic };", 2739],
    ['subject-dispatch', "const invalid: DispatchTarget = { kind: 'session', reference: fileDiagnostic.subject };", 2739],
    ['diagnostic-kind-readonly', "fileDiagnostic.kind = 'file-inspection-failed';", 2540],
    ['subject-token-readonly', "fileDiagnostic.subject.token = 'changed';", 2540],
    ['page-diagnostics-readonly', "observedPage.diagnostics = [];", 2540],
    ['page-diagnostics-push', "observedPage.diagnostics.push(fileDiagnostic);", 2339],
  ].map(([name, source, code]) => [`session-discovery-${name}`, `${discoveryImports} ${source}`, code]);
  const invalidCases = [
    ...discoveryInvalidCases,
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

    ['discovery-namespace', `import type { FileDiscoveryScope } from '${manifest.name}'; import { sessionBinding } from './sessions.test.js'; const invalid: FileDiscoveryScope = { binding: sessionBinding, root: '/fixture' };`, 2741],
    ['discovery-readonly', "import { fileBounds } from './discovery.test.js'; fileBounds.maxFileBytes = 2;", 2540],
    ['discovery-values', "import { filePage } from './discovery.test.js'; filePage.values.push('x');", 2339],
    ['discovery-terminal', "import { filePage } from './discovery.test.js'; filePage.reason;", 2339],
    ['discovery-skip', `import type { FileDecode } from '${manifest.name}'; const invalid: FileDecode<string> = { kind: 'skip', value: 'x' };`, 2353],
    ['discovery-async', `import { discoverFiles } from '${manifest.name}'; import { fileOptions } from './discovery.test.js'; discoverFiles({ ...fileOptions, decode: async () => ({ kind: 'skip' }) });`, 2322],
    ["diagnostics-code", "import { createSafeError } from '@mattsp1290/switchboard'; createSafeError('ECONNRESET');", 2345],
    ["diagnostics-category", "import { summarizeDiagnostic } from '@mattsp1290/switchboard'; summarizeDiagnostic('native', {});", 2345],
    ["diagnostics-error-readonly", "import { error } from './diagnostics.test.js'; error.message = 'changed';", 2540],
    ["diagnostics-unnarrowed", "import { diagnostic } from './diagnostics.test.js'; diagnostic.error;", 2339],
    ["diagnostics-category-readonly", "import { diagnostic } from './diagnostics.test.js'; if (diagnostic.kind === 'redacted') diagnostic.category = 'headers';", 2540],
    ["diagnostics-nested-readonly", "import { diagnostic } from './diagnostics.test.js'; if (diagnostic.kind === 'error') diagnostic.error.code = 'closed';", 2540],
    ["diagnostics-adapter-error", "import { createSafeError } from '@mattsp1290/switchboard'; const invalid: AdapterError = createSafeError('unsupported');", 2322],
    ["diagnostics-metadata", "import { createSafeError } from '@mattsp1290/switchboard'; createSafeError('busy', { message: 'raw' });", 2554],
    ["dispatch-missing-evidence", "import type { NativeDispatchObservation } from '@mattsp1290/switchboard'; const invalid: NativeDispatchObservation<string> = { kind: 'accepted' };", 2322],
    ["dispatch-host-native-reference", "import type { NativeOperationReference } from '@mattsp1290/switchboard'; import { dispatchIdentity } from './dispatch.test.js'; const invalid: NativeOperationReference = dispatchIdentity;", 2739],
    ["dispatch-readonly-envelope", "import { dispatchEvidence } from './dispatch.test.js'; dispatchEvidence.identity.hostOperationId = 'changed';", 2540],
    ["dispatch-unnarrowed-result", "import { unknownObservation } from './dispatch.test.js'; unknownObservation.result;", 2339],
    ["dispatch-unknown-result", "import { unknownObservation } from './dispatch.test.js'; if (unknownObservation.kind === 'conclusive') unknownObservation.result.state;", 18046],
    ["dispatch-new-session-native-token", "import type { DispatchTarget } from '@mattsp1290/switchboard'; import { sessionBinding } from './sessions.test.js'; const invalid: DispatchTarget = { kind: 'new-session', binding: sessionBinding, opaque: 'invented' };", 2353],
    ["recovery-no-run", "import { recovery } from './dispatch-recovery.test.js'; recovery.run();", 2339],
    ["recovery-no-dispatch", "import type { RecoveryDispatchOptions } from '@mattsp1290/switchboard'; import { dispatchIdentity } from './dispatch.test.js'; const invalid: RecoveryDispatchOptions<string> = { mode: 'recovery', identity: dispatchIdentity, dispatchNative() { return { kind: 'outcome-unknown' }; } };", 2353],
    ["recovery-unnarrowed-result", "import type { ReconcileResult } from '@mattsp1290/switchboard'; declare const result: ReconcileResult<string>; result.value;", 2339],
    ["recovery-invalid-previous", "import type { RecoveryDispatchOptions } from '@mattsp1290/switchboard'; import { dispatchIdentity } from './dispatch.test.js'; const invalid: RecoveryDispatchOptions<string> = { mode: 'recovery', identity: dispatchIdentity, previous: { kind: 'not-dispatched', reason: 'aborted' } };", 2322],
    ["recovery-readonly-receipt", "import { dispatchEvidence } from './dispatch.test.js'; if (dispatchEvidence.nativeOperation !== null) dispatchEvidence.nativeOperation.id = 'changed';", 2540],
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
  const integration = join(temporary, 'integration');
  mkdirSync(integration);
  writeFileSync(join(integration, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  process.stdout.write(runNpm([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', join(artifacts, pack.filename),
    `@ag-ui/core@${manifest.peerDependencies['@ag-ui/core']}`,
    `@types/node@${manifest.devDependencies['@types/node']}`,
  ], integration));
  assert(!existsSync(join(integration, 'node_modules/zod')), 'Integration consumer has no optional Zod installed.');
  const aguiFixtures = readdirSync(join(root, 'tests/agui')).filter((file) => file.endsWith('.ts')).sort();
  const aguiTests = aguiFixtures.filter((file) => file.endsWith('.test.ts'));
  assert(aguiTests.length > 0, 'Installed AG-UI tests exist.');
  for (const file of aguiFixtures) copyFileSync(join(root, 'tests/agui', file), join(integration, file));
  copyFileSync(join(root, 'docs/protocol/ag-ui-pin.json'), join(integration, 'ag-ui-pin.json'));
  writeFileSync(join(integration, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { ...consumerConfig.compilerOptions, noEmit: false, noEmitOnError: true, outDir: 'compiled' },
    files: aguiFixtures,
  }));
  run(process.execPath, [compiler, '-p', 'tsconfig.json'], integration);
  const aguiInvalidCases = [
    ['subagent-outcome-readonly', "declare const value: Extract<import('@mattsp1290/switchboard/agui').SubagentFact, { kind: 'subagent-finished' }>; if (value.outcome?.type === 'suspended') value.outcome.interrupts?.push({ scope: [], id: '' });", 2339],
    ['subagent-parent-wire', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-started', subagent: { scope: [], id: '' }, name: '', parentMessage: 'wire' };", 2322],
    ['subagent-private-error', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-failed', subagent: { scope: [], id: '' }, failure: 'native-failure', message: 'private' };", 2353],
    ['subagent-wire', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-started', subagent: 'wire', name: '' };", 2322],
    ['subagent-missing-name', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-started', subagent: { scope: [], id: '' } };", 2322],
    ['subagent-readonly', "declare const value: import('@mattsp1290/switchboard/agui').SubagentFact; value.subagent.id = 'changed';", 2540],
    ['subagent-outcome', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-finished', subagent: { scope: [], id: '' }, outcome: { type: 'success', interrupts: [] } };", 2353],
    ['subagent-error', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-failed', subagent: { scope: [], id: '' }, failure: 'private' };", 2322],
    ['subagent-usage', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-finished', subagent: { scope: [], id: '' }, usage: [] };", 2353],
    ['subagent-result', "const invalid: import('@mattsp1290/switchboard/agui').SubagentFact = { kind: 'subagent-finished', subagent: { scope: [], id: '' }, result: () => {} };", 2322],
    ['reasoning-role', "const invalid: import('@mattsp1290/switchboard/agui').ReasoningFact = { kind: 'reasoning-message-started', message: { scope: [], id: '' }, role: 'assistant' };", 2322],
    ['reasoning-role-missing', "const invalid: import('@mattsp1290/switchboard/agui').ReasoningFact = { kind: 'reasoning-message-started', message: { scope: [], id: '' } };", 2322],
    ['reasoning-target', "const invalid: import('@mattsp1290/switchboard/agui').ReasoningTarget = { kind: 'message', tool: { scope: [], id: '' } };", 2353],
    ['reasoning-wire-id', "const invalid: import('@mattsp1290/switchboard/agui').ReasoningTarget = { kind: 'tool', tool: 'wire' };", 2322],
    ['reasoning-readonly', "declare const value: import('@mattsp1290/switchboard/agui').ReasoningTarget; value.kind = 'tool';", 2540],
    ['interrupt-empty', "const invalid: import('@mattsp1290/switchboard/agui').TerminalFact = { kind: 'run-finished', outcome: 'interrupt', interrupts: [] };", 2322],
    ['interrupt-wire-id', "const invalid: import('@mattsp1290/switchboard/agui').NativeInterrupt = { interrupt: 'wire', reason: '' };", 2322],
    ['interrupt-array-schema', "const invalid: import('@mattsp1290/switchboard/agui').NativeInterrupt = { interrupt: { scope: [], id: '' }, reason: '', responseSchema: [] };", 2322],
    ['interrupt-readonly', "declare const value: import('@mattsp1290/switchboard/agui').NativeInterrupt; value.reason = 'changed';", 2540],
    ['usage-readonly', "declare const value: import('@mattsp1290/switchboard/agui').NativeTokenUsage; value.inputTokens = 1;", 2540],
    ['usage-unknown', "const invalid: import('@mattsp1290/switchboard/agui').NativeTokenUsage = { privateCounter: 1 };", 2353],
    ['usage-string', "const invalid: import('@mattsp1290/switchboard/agui').NativeTokenUsage = { inputTokens: '1' };", 2322],
    ['part-null-metadata', "const invalid: import('@mattsp1290/switchboard/agui').NativeContent = [{ type: 'text', text: 'x', metadata: null }];", 2322],
    ['event-readonly', "declare const event: Extract<ProjectionEvent, { type: 'RUN_STARTED' }>; event.threadId = 'changed';", 2540],
    ['content-readonly', "declare const event: Extract<ProjectionEvent, { type: 'TOOL_CALL_RESULT' }>; if (typeof event.content !== 'string') event.content.push({ type: 'text', text: 'changed' });", 2339],
    ['result-readonly', "declare const result: Extract<NonNullable<Extract<ProjectionEvent, { type: 'RUN_FINISHED' }>['result']>, readonly unknown[]>; result.push(0);", 2339],
  ];
  const nativeMessageInvalid = [
    ["{ id: 'wire', role: 'assistant' }", 2322],
    ["{ id: ref, role: 'assistant', subagentRunId: 'wire' }", 2322],
    ["{ id: ref, role: 'assistant', toolCalls: [{ id: 'wire', type: 'function', function: { name: '', arguments: '' } }] }", 2322],
    ["{ id: ref, role: 'tool', content: '', toolCallId: 'wire' }", 2322],
    ["{ id: ref, role: 'user', content: [{ type: 'text', id: 'wire', text: '' }] }", 2322],
    ["{ id: ref, role: 'assistant', content: [] }", 2322],
    ["{ id: ref, role: 'tool', content: '', toolCallId: ref, name: 'forbidden' }", 2353],
    ["{ id: ref, role: 'activity', activityType: '', content: {}, encryptedValue: '' }", 2353],
    ["{ id: ref, role: 'reasoning', content: '', name: '' }", 2353],
    ...['null', '[]', '1', '{ invalid: () => {} }', '{ invalid: undefined }', '{ invalid: 1n }'].map(metadata => [`{ id: ref, role: 'assistant', metadata: ${metadata} }`, 2322]),
    ["{ id: ref, role: 'assistant', toolCalls: [{ id: ref, type: 'function', function: { name: '', arguments: '' }, metadata: [] }] }", 2322],
    ["{ id: ref, role: 'user', content: [{ type: 'text', text: '', metadata: null }] }", 2322],
    ["{ id: ref, role: 'activity', activityType: '', content: [] }", 2322],
    ["{ id: ref, role: 'tool', content: '' }", 2322],
    ["{ id: ref, role: 'user' }", 2322],
    ["{ id: ref, role: 'reasoning' }", 2322],
    ["{ id: ref, role: 'assistant', subagentRunId: undefined }", 2375],
    ["{ id: ref, role: 'assistant', metadata: { value: Symbol() } }", 2322],
    ["{ id: ref, role: 'assistant', toolCalls: [{ id: ref, type: 'function', function: { name: '', arguments: '' }, metadata: null }] }", 2322],
    ["{ id: ref, role: 'assistant', toolCalls: [{ id: ref, type: 'function', function: { name: '', arguments: '' }, metadata: { value: () => {} } }] }", 2322],
    ["{ id: ref, role: 'user', content: [{ type: 'text', text: '', metadata: () => {} }] }", 2322],
    ["{ id: ref, role: 'activity', activityType: '', content: { value: () => {} } }", 2322],
    ["{ id: ref, role: 'developer' }", 2322],
    ["{ id: ref, role: 'system' }", 2322],
    ["{ id: ref, role: 'tool', toolCallId: ref }", 2322],
    ["{ id: ref, role: 'activity', activityType: '' }", 2322],
    ["{ id: ref, role: 'activity', content: {} }", 2322],
    ["{ id: ref, role: 'activity', activityType: '', content: {}, name: '' }", 2353],
  ];
  assert.equal(nativeMessageInvalid.length, 33);
  for (const [index, [expression, code]] of nativeMessageInvalid.entries()) {
    aguiInvalidCases.push([`message-${index}`, `const ref = { scope: [], id: 'native' }; const invalid: import('${manifest.name}/agui').NativeMessage = ${expression};`, code]);
  }
  for (const [name, source] of aguiInvalidCases) writeFileSync(join(integration, `${name}.mts`),
    `import type { ProjectionEvent } from '${manifest.name}/agui';\n${source}\n`);
  writeFileSync(join(integration, 'invalid.json'), JSON.stringify({
    compilerOptions: consumerConfig.compilerOptions, files: aguiInvalidCases.map(([name]) => `${name}.mts`),
  }));
  const invalidAgui = spawnSync(process.execPath, [compiler, '-p', 'invalid.json', '--pretty', 'false'], { cwd: integration, encoding: 'utf8' });
  assert.equal(invalidAgui.status, 1, invalidAgui.stdout + invalidAgui.stderr);
  const actualAgui = [...invalidAgui.stdout.matchAll(/^([^\n(]+)\((\d+),\d+\): error TS(\d+):/gm)]
    .map(([, file, line, code]) => ({ file, line: Number(line), code: Number(code) }));
  assert.equal(actualAgui.length, (invalidAgui.stdout.match(/error TS\d+:/g) ?? []).length, invalidAgui.stdout);
  assert.deepEqual(actualAgui.sort(byFile), aguiInvalidCases.map(([name, , code]) => ({ file: `${name}.mts`, line: 2, code })).sort(byFile), invalidAgui.stdout);
  console.log(`Verified ${nativeMessageInvalid.length} installed NativeMessage negative type fixtures.`);
  const collected = join(temporary, 'emitted-events.jsonl');
  writeFileSync(collected, '');
  writeFileSync(join(integration, 'compiled/empty-test.js'), '');
  const emptyOutput = run(process.execPath, ['--test-reporter=tap', 'compiled/empty-test.js'], integration, runtimeEnvironment);
  assert.doesNotMatch(emptyOutput, /^# tests [1-9]\d*$/m, 'An empty module cannot satisfy the registered-test gate.');
  for (const file of aguiTests) {
    const output = run(process.execPath, ['--test-reporter=tap', `compiled/${file.replace(/\.ts$/, '.js')}`],
      integration, { ...runtimeEnvironment, AGUI_COLLECTOR_PATH: collected });
    assert.match(output, /^# tests [1-9]\d*$/m, `${file} executes nonzero installed tests.`);
    process.stdout.write(output);
  }
  const subagentCases = readFileSync(collected, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(item => item.path.startsWith('subagents/') && item.origin === 'switchboard-projection').map(item => item.value);
  for (const type of ['SUBAGENT_STARTED', 'SUBAGENT_FINISHED', 'SUBAGENT_ERROR']) {
    assert(subagentCases.some(event => event.type === type), `Installed subagent output includes ${type}.`);
  }
  const childFinishes = subagentCases.filter(event => event.type === 'SUBAGENT_FINISHED');
  assert(childFinishes.some(event => !('outcome' in event)));
  assert(childFinishes.some(event => event.outcome?.type === 'success'));
  for (const size of [undefined, 0, 1, 2]) {
    assert(childFinishes.some(event => event.outcome?.type === 'suspended' && event.outcome.interruptIds?.length === size));
  }
  console.log(`Collected ${subagentCases.length} actual installed subagent-test events.`);
  const reasoningCases = readFileSync(collected, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(item => item.path.startsWith('reasoning/') && item.origin === 'switchboard-projection');
  for (const type of ['REASONING_START', 'REASONING_END', 'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END', 'REASONING_ENCRYPTED_VALUE']) {
    assert(reasoningCases.some(item => item.value.type === type), `Installed reasoning output includes ${type}.`);
  }
  for (const subtype of ['message', 'tool-call']) {
    assert(reasoningCases.some(item => item.value.type === 'REASONING_ENCRYPTED_VALUE' && item.value.subtype === subtype));
  }
  assert(reasoningCases.filter(item => item.value.type === 'REASONING_MESSAGE_START').every(item => item.value.role === 'reasoning'));
  console.log(`Collected ${reasoningCases.length} actual installed reasoning-test events.`);
  const terminalCases = readFileSync(collected, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(item => item.path.startsWith('terminals/') && item.origin === 'switchboard-projection');
  assert(terminalCases.some(item => item.value.type === 'RUN_FINISHED' && item.value.outcome?.type === 'interrupt'));
  for (const type of ['RUN_FINISHED', 'RUN_ERROR']) {
    assert(terminalCases.some(item => item.value.type === type && Array.isArray(item.value.usage)));
  }
  console.log(`Collected ${terminalCases.length} actual installed terminal-test events.`);
  process.stdout.write(run(process.execPath, [join(root, 'scripts/verify-agui-matrix.mjs'), '--emitted-events', collected]));
  console.log(`Verified ${manifest.name}@${manifest.version} with ${process.version} on ${process.platform}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
