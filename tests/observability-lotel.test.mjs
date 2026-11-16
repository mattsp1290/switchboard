import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('lotel collector configuration matches the exact reviewed upstream default', async () => {
  const configuration = await readFile(join(root, 'scripts/support/lotel-collector.yaml'));
  const { lotel } = JSON.parse(await readFile(join(root, 'docs/observability/qualification-pin.json'), 'utf8'));
  assert.equal(createHash('sha256').update(configuration).digest('hex'), '64e64e247be4579d9896966081951d2ae3e07b98e007f016d9ab3c76d9ffc2bd');
  assert.equal(lotel.collectorConfig.sha256, createHash('sha256').update(configuration).digest('hex'));
  assert.equal(lotel.collectorConfig.source, `https://raw.githubusercontent.com/mattsp1290/lotel/${lotel.commit}/internal/config/config.go`);
});

for (const scenario of ['collision', 'start-failure', 'replacement', 'tampered-config']) {
  test(`lotel command boundary preserves ownership on ${scenario}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'switchboard-lotel-command-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'scripts/support'), { recursive: true });
    await mkdir(join(directory, 'docs/observability'), { recursive: true });
    await mkdir(join(directory, 'bin'));
    await mkdir(join(directory, 'temporary'));
    for (const file of ['scripts/verify-observability-lotel.mjs', 'scripts/support/observability-backends.mjs',
      'scripts/support/observability-fixture.mjs', 'scripts/support/lotel-collector.yaml',
      'docs/observability/qualification-pin.json']) {
      await copyFile(join(root, file), join(directory, file));
    }
    if (scenario === 'tampered-config') await writeFile(join(directory, 'scripts/support/lotel-collector.yaml'), 'changed');
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const boundary = join(root, 'tests/support/lotel-command-boundary.mjs');
    for (const binary of ['docker', 'go', 'lotel']) {
      await writeFile(join(directory, 'bin', binary), `#!${process.execPath}\n${await readFile(boundary, 'utf8')}`, { mode: 0o755 });
    }
    const commandsFile = join(directory, 'commands.jsonl');
    const stateFile = join(directory, 'container');
    const env = { ...process.env, PATH: `${join(directory, 'bin')}:${dirname(process.execPath)}`,
      LOTEL_BIN: join(directory, 'bin/lotel'), TMPDIR: join(directory, 'temporary'),
      LOTEL_TEST_COMMANDS: commandsFile, LOTEL_TEST_STATE: stateFile, LOTEL_TEST_SCENARIO: scenario };
    delete env.LOTEL_SOURCE;
    await assert.rejects(execute(process.execPath, ['--import', boundary, 'scripts/verify-observability-lotel.mjs'],
      { cwd: directory, env, timeout: 20_000 }), error => error.code === 1);
    const report = JSON.parse(await readFile(join(directory, '.audit/llm-observability/lotel.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    const commands = (await readFile(commandsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(!commands.some(({ binary }) => binary === 'lotel'), 'restart-capable upstream startup is never called');
    const docker = commands.filter(({ binary }) => binary === 'docker').map(({ args }) => args);
    if (scenario === 'tampered-config') {
      assert.match(report.failure, /collector configuration differs/);
      assert(!docker.some(args => ['create', 'start', 'stop', 'rm'].includes(args[0])));
      return;
    }
    const acquisition = docker.find(args => args[0] === 'create');
    assert(acquisition, JSON.stringify(report));
    assert.deepEqual(acquisition.slice(0, 3), ['create', '--name', 'lotel-collector']);
    assert.equal(acquisition.at(-1), 'otel/opentelemetry-collector-contrib:0.165.0');
    const configMount = acquisition.find(arg => arg.endsWith(':/etc/otelcol-contrib/config.yaml:ro'));
    assert(configMount, 'reviewed configuration is mounted read-only');
    const temporary = dirname(dirname(configMount.split(':/etc/')[0]));
    if (scenario === 'start-failure') {
      assert.deepEqual(docker.filter(args => ['start', 'stop', 'rm'].includes(args[0])),
        [['start', 'a'.repeat(64)], ['stop', 'a'.repeat(64)], ['rm', 'a'.repeat(64)]]);
      assert.equal(report.cleanup, 'owned collector stopped');
      await assert.rejects(access(stateFile), { code: 'ENOENT' });
      await assert.rejects(access(temporary), { code: 'ENOENT' });
    } else {
      assert.equal(await readFile(stateFile, 'utf8'), 'b'.repeat(64));
      assert(!docker.some(args => ['stop', 'rm'].includes(args[0])), 'no competing container is stopped or removed');
      if (scenario === 'collision') assert(!docker.some(args => args[0] === 'start'));
      assert.equal(report.retainedDirectory, temporary);
      await access(temporary);
    }
  });
}
