import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAguiRun, checkLotelSpans, expectedSpanCounts } from '../scripts/live-baseline-check.mjs';
import {
  ambientCredentialNames, codexHostArgs, credentialNames, engines, formatReason, resolveModel, selectEngines,
} from '../scripts/live-baseline-engines.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/live-baseline.mjs');
const tripwire = join(root, 'tests/support/native-sdk-tripwire.mjs');

async function spawnScript(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_API_KEY|OPENCODE_API_KEY|CURSOR_API_KEY|CURSOR_QUALIFICATION_MODEL|SWITCHBOARD_|LOTEL_SOURCE$)/u.test(name)) continue;
    env[name] = value;
  }
  const directory = await mkdtemp(join(tmpdir(), 'live-baseline-test-'));
  const reportPath = join(directory, 'report.json');
  const result = spawnSync(process.execPath, ['--import', tripwire, script], {
    cwd: root, encoding: 'utf8', env: { ...env, SWITCHBOARD_LIVE_BASELINE_REPORT: reportPath, ...extra },
  });
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined;
  await rm(directory, { recursive: true, force: true });
  return { result, report };
}

test('no gate prints one line, exits 0, and loads no native SDK', async () => {
  const { result, report } = await spawnScript({});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'live-baseline: no engine selected\n');
  assert.equal(result.stderr.includes('native SDK tripwire'), false);
  assert.equal(report, undefined);
});

const canaries = { SWITCHBOARD_ANTHROPIC_API_KEY: 'canary-anthropic-0001', SWITCHBOARD_CURSOR_API_KEY: 'canary-cursor-0002',
  SWITCHBOARD_OPENCODE_API_KEY: 'canary-opencode-0003' };

test('a dry run of every engine prints the resolved plan without lotel, a build, a report, or a credential', async () => {
  const dist = join(root, 'dist');
  const before = existsSync(dist) ? statSync(dist).mtimeMs : undefined;
  const emptyLotel = await mkdtemp(join(tmpdir(), 'live-baseline-nolotel-'));
  const { result, report } = await spawnScript({ SWITCHBOARD_LIVE_ALL: '1', SWITCHBOARD_LIVE_DRY_RUN: '1', ...canaries,
    LOTEL_SOURCE: emptyLotel, PATH: process.env.PATH.split(':').filter((dir) => !existsSync(join(dir, 'lotel'))).join(':') });
  await rm(emptyLotel, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.deepEqual(lines.map((line) => line.split(' ').slice(0, 2).join(' ')), engines.map((engine) => `DRY ${engine.name}`));
  for (const engine of engines) {
    assert(lines.some((line) => line.startsWith(`DRY ${engine.name} model=${engine.defaultModel} runtime=${engine.runtime} `)), engine.name);
  }
  assert.equal(report, undefined);
  assert.equal(existsSync(dist) ? statSync(dist).mtimeMs : undefined, before);
  assert.equal(result.stderr.includes('native SDK tripwire'), false);
  for (const value of Object.values(canaries)) assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
});

test('a gated engine without its credential fails with credential-required and no report', async () => {
  const { result, report } = await spawnScript({ SWITCHBOARD_LIVE_CLAUDE: '1', SWITCHBOARD_LIVE_DRY_RUN: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'FAIL claude credential-required\n');
  assert.equal(report, undefined);
});

test('a live run without its credential fails before any build, import, or lotel call', async () => {
  const dist = join(root, 'dist');
  const before = existsSync(dist) ? statSync(dist).mtimeMs : undefined;
  const { result, report } = await spawnScript({ SWITCHBOARD_LIVE_CURSOR: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL cursor credential-required$/mu);
  assert.equal(result.stderr.includes('native SDK tripwire'), false);
  assert.equal(existsSync(dist) ? statSync(dist).mtimeMs : undefined, before);
  assert.deepEqual(JSON.parse(report).engines.map((item) => [item.engine, item.model, item.pass, item.code]),
    [['cursor', 'composer-2', false, 'credential-required']]);
});

test('credentials alone select nothing, and an ambient key never reaches output', async () => {
  const { result, report } = await spawnScript({ ...canaries, ANTHROPIC_API_KEY: 'canary-ambient-0004' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'live-baseline: no engine selected\n');
  assert.equal(report, undefined);
  assert.equal(`${result.stdout}${result.stderr}`.includes('canary'), false);
});

test('engine selection, model resolution, and the credential lists', () => {
  assert.deepEqual(selectEngines({}), []);
  assert.deepEqual(selectEngines({ SWITCHBOARD_LIVE_CODEX: '1' }).map((engine) => engine.name), ['codex']);
  assert.deepEqual(selectEngines({ SWITCHBOARD_LIVE_CODEX: '' }), []);
  assert.deepEqual(selectEngines({ SWITCHBOARD_LIVE_ALL: '1' }).map((engine) => engine.name),
    ['claude', 'codex', 'cursor', 'pi', 'host/pi', 'host/codex', 'host/opencode']);
  assert.deepEqual(selectEngines({ ...canaries }), []);
  const claude = engines.find((engine) => engine.name === 'claude');
  assert.equal(resolveModel(claude, {}), 'claude-haiku-5-5');
  assert.equal(resolveModel(claude, { SWITCHBOARD_LIVE_CLAUDE_MODEL: '' }), 'claude-haiku-5-5');
  assert.equal(resolveModel(claude, { SWITCHBOARD_LIVE_CLAUDE_MODEL: 'other' }), 'other');
  for (const engine of engines) {
    assert.equal(typeof engine.defaultModel, 'string');
    assert.notEqual(engine.defaultModel, '');
    assert(['text', 'pi', 'host'].includes(engine.runtime));
    assert(['adapter-enforced', 'native-record', 'request-only'].includes(engine.confirmation));
    if (engine.credential !== undefined) assert(credentialNames.includes(engine.credential));
  }
  assert.deepEqual([...ambientCredentialNames], ['ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'OPENCODE_API_KEY']);
});

test('host/codex appends the model, a low reasoning effort, and private sqlite and log directories', () => {
  const paths = { sqliteHome: '/tmp/run/codex-sqlite', logDir: '/tmp/run/codex-logs' };
  assert.deepEqual(codexHostArgs('gpt-6-luna', paths), ['-c', 'model="gpt-6-luna"', '-c', 'model_reasoning_effort="low"',
    '-c', 'sqlite_home="/tmp/run/codex-sqlite"', '-c', 'log_dir="/tmp/run/codex-logs"']);
  assert.equal(codexHostArgs('a"b', paths)[1], 'model="a\\"b"');
});

test('failure reasons are one redacted line of at most 200 characters', () => {
  const secret = 'canary-secret-0005';
  assert.equal(formatReason(`Error: bad ${secret}`, [secret], '/home/me'), 'Error: bad <redacted>');
  assert.equal(formatReason('Authorization: Bearer abc.def-123 rejected', [], ''), 'Authorization: Bearer <redacted> rejected');
  assert.equal(formatReason('key sk-ant-api03-ABCDEFGHIJ leaked', [], ''), 'key <redacted> leaked');
  assert.equal(formatReason('first line\nsecond line', [], ''), 'first line');
  assert.equal(formatReason('read /home/me/x failed', [], '/home/me'), 'read ~/x failed');
  const long = formatReason('x'.repeat(500), [], '');
  assert.equal(long.length, 200);
  assert(long.endsWith('…'));
  assert.equal(formatReason(undefined, [], ''), '');
});

test('the live script is not wired into CI or npm test', () => {
  assert.equal(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').includes('live-baseline'), false);
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:live-baseline'], 'node scripts/live-baseline.mjs');
  assert.equal(scripts.test.includes('live-baseline'), false);
});

const text = { kind: 'text', messageId: 'm', mode: 'delta', text: 'pong' };
const success = { kind: 'terminal', outcome: 'success' };
const started = { kind: 'run-started' };
const mapped = (...types) => ({ kind: 'mapped', events: types });
const textBatch = mapped({ type: 'TEXT_MESSAGE_START' }, { type: 'TEXT_MESSAGE_CONTENT', delta: 'pong' });
const finished = mapped({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
const unqualified = (supported = []) => ({
  families: ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'usage', 'reasoning', 'subagents']
    .map((family) => ({ family, availability: supported.includes(family) ? 'supported' : 'unsupported', qualification: 'unqualified' })),
  baseline: ['text', 'tools', 'steps'].map((family) => ({
    family, availability: supported.includes(family) ? 'supported' : 'unsupported', qualification: 'unqualified' })),
});
const good = () => ({
  batches: [mapped({ type: 'RUN_STARTED' }), textBatch, finished],
  observations: [started, text, success],
  report: unqualified(['text']),
});

test('a successful turn passes the in-process assertions', () => {
  assert.deepEqual(checkAguiRun(good()), { ok: true });
});

test('in-process assertions reject each broken batch', () => {
  const code = (input) => checkAguiRun(input).code;
  assert.equal(code({ ...good(), batches: [textBatch, finished] }), 'run-started-first');
  assert.equal(code({ ...good(), batches: [mapped({ type: 'RUN_STARTED' }), finished] }), 'text-missing');
  assert.equal(code({ ...good(), batches: [mapped({ type: 'RUN_STARTED' }), textBatch] }), 'run-finished-missing');
  assert.equal(code({ ...good(), batches: [good().batches[0], { kind: 'error', error: { code: 'invalid-order' } }] }), 'projection-error');
  const unknown = { ...good(), observations: [started, text, { kind: 'terminal', outcome: 'outcome-unknown' }] };
  assert.equal(code(unknown), 'outcome-unknown-terminated');
  assert.deepEqual(checkAguiRun({ ...unknown, batches: [mapped({ type: 'RUN_STARTED' }), textBatch] }), { ok: true });
  const failed = { ...good(), observations: [started, text, { kind: 'terminal', outcome: 'failed' }] };
  assert.equal(code(failed), 'run-error-missing');
  assert.deepEqual(checkAguiRun({ ...failed, batches: [mapped({ type: 'RUN_STARTED' }), textBatch, mapped({ type: 'RUN_ERROR' })] }), { ok: true });
  assert.equal(code({ ...good(), report: { ...unqualified(['text']), families: unqualified().families.map((row) => ({ ...row, qualification: 'qualified' })) } }), 'family-qualified');
  assert.equal(code({ ...good(), report: unqualified() }), 'family-availability');
});

test('tool payloads must appear in tool events', () => {
  const tool = { kind: 'tool', callId: 'c', name: 'read', phase: 'completed', argumentsJson: '{"a":1}', resultJson: '"ok"' };
  const input = {
    batches: [mapped({ type: 'RUN_STARTED' }), textBatch,
      mapped({ type: 'TOOL_CALL_ARGS', delta: '{"a":1}' }, { type: 'TOOL_CALL_RESULT', content: '"ok"' }), finished],
    observations: [started, text, tool, success], report: unqualified(['text', 'tools']),
  };
  assert.deepEqual(checkAguiRun(input), { ok: true });
  assert.equal(checkAguiRun({ ...input, batches: input.batches.filter((_, index) => index !== 2) }).code, 'tool-arguments-missing');
});

const span = (operation, extra = {}) => ({
  span_id: Math.random().toString(16).slice(2), attributes: { 'switchboard.run_id': 'run-1', 'gen_ai.operation.name': operation, ...extra },
});
const agent = (outcome = 'success') => span('invoke_agent', { 'switchboard.outcome': outcome });
const doneTool = { kind: 'tool', callId: 'c', name: 'read', phase: 'completed' };
const endedTool = { kind: 'tool', callId: 'd', name: 'read', phase: 'arguments-ended', argumentsJson: '{}' };
const endedWithResult = { ...endedTool, resultJson: '1' };
const boundary = { kind: 'model-boundary' };

test('lotel spans pass for matching counts and ignore other runs', () => {
  const other = { attributes: { 'switchboard.run_id': 'run-2', 'gen_ai.operation.name': 'invoke_agent', 'switchboard.outcome': 'error' } };
  const spans = [agent(), span('execute_tool'), span('execute_tool'), span('chat'), other];
  const observations = [started, doneTool, endedWithResult, endedTool, boundary, success];
  const result = checkLotelSpans({ spans, runId: 'run-1', observations });
  assert.deepEqual(result, { ok: true, counts: { agent: 1, tool: 2, model: 1 }, outcome: 'success' });
});

test('lotel assertions reject each mismatch', () => {
  const run = (spans, observations = [started, success]) => checkLotelSpans({ spans, runId: 'run-1', observations }).code;
  assert.equal(run([]), 'agent-span-count');
  assert.equal(run([agent(), agent()]), 'agent-span-count');
  assert.equal(run([agent('error')]), 'agent-outcome');
  assert.equal(run([agent('success')], [started, { kind: 'terminal', outcome: 'failed' }]), 'agent-outcome');
  assert.equal(run([span('invoke_agent', { 'switchboard.outcome': 'success', 'gen_ai.output.messages': '[]' })]), 'content-attribute');
  assert.equal(run([agent(), span('chat', { 'gen_ai.input.messages': '[]' })], [started, boundary, success]), 'content-attribute');
  assert.equal(run([agent()], [started, doneTool, success]), 'tool-span-count');
  assert.equal(run([agent(), span('execute_tool')], [started, success]), 'tool-span-count');
  assert.equal(run([agent()], [started, boundary, success]), 'model-span-count');
  assert.equal(run([agent(), span('chat')], [started, success]), 'model-span-count');
  assert.equal(checkLotelSpans({ spans: {}, runId: 'run-1', observations: [] }).code, 'traces-malformed');
});

test('expected tool spans count each call once however many execution observations it has', () => {
  const tool = (phase, extra = {}) => ({ kind: 'tool', callId: 'c', name: 'add', phase, ...extra });
  assert.deepEqual(expectedSpanCounts([tool('arguments-ended', { resultJson: '1' }), tool('completed', { resultJson: '1' }), tool('failed'),
    { kind: 'tool', callId: 'd', name: 'add', phase: 'arguments-ended' }, { kind: 'model-boundary' }]), { agent: 1, tool: 1, model: 1 });
});
