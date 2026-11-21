import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runNpm, testEnvironment } from './support/exec.mjs';
import { assertInstalledForkCore } from './support/agui-fork.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pinned = name => `${name}@${manifest.devDependencies[name]}`;

export function verifyObservability({ consumer, tarball, compiler, compilerOptions }) {
  const pins = JSON.parse(readFileSync(join(root, 'docs/observability/qualification-pin.json'), 'utf8'));
  assert.equal(pins.semanticConventions.version, '1.37.0');
  for (const [name, version] of Object.entries(pins.packages)) {
    assert.equal(manifest.devDependencies[name], version, `Qualification package pin differs for ${name}.`);
  }
  for (const [file, pin] of Object.entries(pins.semanticConventions.schemas)) {
    const digest = createHash('sha256').update(readFileSync(join(root, 'tests/observability/fixtures', file))).digest('hex');
    assert.equal(digest, pin.sha256, `Upstream schema bytes changed for ${file}.`);
  }
  const minimal = join(dirname(consumer), 'observability-api-consumer');
  mkdirSync(minimal);
  writeFileSync(join(minimal, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  process.stdout.write(runNpm(['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', tarball,
    pinned('@opentelemetry/api'), pinned('@types/node')], minimal));
  assert(!existsSync(join(minimal, 'node_modules/@ag-ui')), 'API-only observability consumer has no AG-UI peer.');
  assert(!existsSync(join(minimal, 'node_modules/@opentelemetry/sdk-trace-base')), 'Recording entry needs no SDK.');
  copyFileSync(join(root, 'tests/observability/types.test.ts'), join(minimal, 'types.test.ts'));
  writeFileSync(join(minimal, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: ['types.test.ts'] }));
  run(process.execPath, [compiler, '-p', 'tsconfig.json'], minimal);
  verifyInvalidTypes(minimal, compiler, compilerOptions);
  const declarations = run(process.execPath, [compiler, '-p', 'tsconfig.json', '--listFilesOnly'], minimal);
  assert(!declarations.includes('/agui/') && !declarations.includes('/@ag-ui/'), 'Observability declarations are independent of AG-UI.');
  assert(!declarations.includes('/sdk-trace-'), 'Observability declarations depend only on the OTel API.');
  writeFileSync(join(minimal, 'api-only.mjs'), `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { createGenAiObserver } from '${manifest.name}/observability';
const observer = createGenAiObserver({ tracer: trace.getTracer('api-only'), contentPolicy: { kind: 'none' }, allowedToolNames: [] });
const result = observer.start({ kind: 'agent', provider: 'openai' }, ROOT_CONTEXT);
assert.equal(result.kind, 'ok');
assert.equal(result.value.finish({ kind: 'success' }).kind, 'ok');
observer.close();
assert.equal(observer.diagnostics().activeSpans, 0);
assert.equal(observer.diagnostics().telemetryFailures, 0);
`);
  run(process.execPath, ['api-only.mjs'], minimal, testEnvironment());
  console.log('Verified installed observability with only its API peer and strict negative type fixtures.');

  const installed = join(dirname(consumer), 'observability-sdk-consumer');
  mkdirSync(join(installed, 'tests/observability'), { recursive: true });
  mkdirSync(join(installed, 'support'));
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const dependencies = ['@opentelemetry/api', '@opentelemetry/sdk-trace-base', '@opentelemetry/sdk-trace-node',
    '@opentelemetry/resources', '@opentelemetry/exporter-trace-otlp-proto', '@ag-ui/core', '@types/node', 'ajv'];
  process.stdout.write(runNpm(['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', tarball,
    ...dependencies.map(pinned)], installed));
  assertInstalledForkCore(installed, 'Observability SDK consumer');
  process.stdout.write(runNpm(['ls', ...dependencies], installed));
  for (const file of ['recording.consumer.mjs', 'host.consumer.mjs', 'baseline.consumer.mjs', 'types.test.ts']) {
    copyFileSync(join(root, 'tests/observability', file), join(installed, 'tests/observability', file));
  }
  cpSync(join(root, 'tests/observability/fixtures'), join(installed, 'tests/observability/fixtures'), { recursive: true });
  for (const file of ['observability-fixture.mjs', 'datadog-exporter.mjs']) {
    copyFileSync(join(root, 'scripts/support', file), join(installed, 'support', file));
  }
  writeFileSync(join(installed, 'coexistence.ts'), `
import { createGenAiObserver } from '${manifest.name}/observability';
import { createAguiProjection } from '${manifest.name}/agui';
import { createRunBaseline } from '${manifest.name}/baseline';
import { contracts, createFakeFixture } from '${manifest.name}/testkit';
import * as core from '${manifest.name}';
void [createGenAiObserver, createAguiProjection, createRunBaseline, contracts, createFakeFixture, core];
`);
  writeFileSync(join(installed, 'tsconfig.json'), JSON.stringify({ compilerOptions,
    files: ['tests/observability/types.test.ts', 'coexistence.ts'] }));
  run(process.execPath, [compiler, '-p', 'tsconfig.json'], installed);
  run(process.execPath, ['coexistence.ts'], installed, testEnvironment());
  const output = run(process.execPath, ['--test', '--test-reporter=tap', 'tests/observability/recording.consumer.mjs',
    'tests/observability/host.consumer.mjs', 'tests/observability/baseline.consumer.mjs'], installed, testEnvironment());
  assert.match(output, /^# tests [1-9]\d*$/m, 'Installed observability tests execute.');
  assert.match(output, /^# fail 0$/m, 'Installed observability tests pass.');
  assert.match(output, /^ok \d+ - observability sanitized text matches independently pinned upstream schemas$/m);
  process.stdout.write(output);
  console.log('Verified installed SDK recording, real HTTP boundaries, privacy schemas, lifecycle faults, and optional-entry coexistence.');
}

function verifyInvalidTypes(consumer, compiler, compilerOptions) {
  const prelude = `import { ROOT_CONTEXT } from '@opentelemetry/api'; import { observer, model, agent, tool } from './types.test.js'; import type { GenAiOperation, TerminalOutcome, ContentObservation } from '${manifest.name}/observability';`;
  const cases = [
    ['no-sdk-end', "if (model.kind === 'ok') model.value.end();", 2339],
    ['no-attributes', "if (model.kind === 'ok') model.value.update({ attributes: { secret: 'token' } });", 2353],
    ['no-error-object', "if (model.kind === 'ok') model.value.finish({ kind: 'error', category: new Error('secret') });", 2322],
    ['fixed-error-category', "if (model.kind === 'ok') model.value.finish({ kind: 'error', category: 'raw-provider-message' });", 2322],
    ['no-agent-usage', "if (agent.kind === 'ok') agent.value.update({ usage: { inputTokens: 1 } });", 2339],
    ['no-tool-usage', "if (tool.kind === 'ok') tool.value.update({ usage: { inputTokens: 1 } });", 2339],
    ['required-model-provider', "observer.start({ kind: 'model', operation: 'chat' }, ROOT_CONTEXT);", 2769],
    ['required-agent-provider', "observer.start({ kind: 'agent' }, ROOT_CONTEXT);", 2769],
    ['explicit-parent', "observer.start({ kind: 'agent', provider: 'openai' });", 2554],
    ['no-native-handle', "observer.start({ kind: 'agent', provider: 'openai', nativeHandle: { secret: 'token' } }, ROOT_CONTEXT);", 2769],
    ['no-tool-start-usage', "observer.start({ kind: 'tool', name: 'add', usage: { inputTokens: 1 } }, ROOT_CONTEXT);", 2769],
    ['no-start-attributes', "observer.start({ kind: 'model', provider: 'openai', operation: 'chat', attributes: {} }, ROOT_CONTEXT);", 2769],
    ['text-parts-required', "observer.start({ kind: 'model', provider: 'openai', operation: 'chat', inputMessages: [{ role: 'user', content: 'raw' }] }, ROOT_CONTEXT);", 2769],
    ['no-cancellation-category', "const invalid: TerminalOutcome = { kind: 'cancelled', category: 'timeout' };", 2353],
    ['fixed-model-operation', "const invalid: GenAiOperation = { kind: 'model', provider: 'openai', operation: 'invoke_agent' };", 2322],
    ['required-finish-reason', "const invalid: ContentObservation = { kind: 'output', messages: [{ role: 'assistant', parts: [{ type: 'text', content: 'response' }] }] };", 2322],
  ];
  const files = cases.map(([name, source]) => {
    const file = `${name}.mts`;
    writeFileSync(join(consumer, file), `${prelude}\n${source}\n`);
    return file;
  });
  writeFileSync(join(consumer, 'invalid.json'), JSON.stringify({ compilerOptions, files }));
  const result = spawnSync(process.execPath, [compiler, '-p', 'invalid.json', '--pretty', 'false'], { cwd: consumer, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stderr, '');
  const diagnostics = [...result.stdout.matchAll(/^([^\n]+)\((\d+),(\d+)\): error TS(\d+):/gm)]
    .map(match => ({ file: match[1], line: Number(match[2]), code: Number(match[4]) }));
  assert.equal(diagnostics.length, (result.stdout.match(/error TS\d+:/g) ?? []).length, result.stdout);
  const expected = cases.map(([name, , code]) => ({ file: `${name}.mts`, line: 2, code }));
  const byFile = (left, right) => left.file.localeCompare(right.file);
  assert.deepEqual(diagnostics.sort(byFile), expected.sort(byFile), result.stdout);
  console.log(`Verified ${cases.length} exact installed observability negative type diagnostics.`);
}
