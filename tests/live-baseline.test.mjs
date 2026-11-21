import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAguiRun, checkLotelSpans } from '../scripts/live-baseline-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/live-baseline.mjs');
const tripwire = join(root, 'tests/support/native-sdk-tripwire.mjs');

async function spawnScript(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_API_KEY|OPENCODE_API_KEY|CURSOR_API_KEY|CURSOR_QUALIFICATION_MODEL|SWITCHBOARD_LIVE_)/u.test(name)) continue;
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

test('a selected engine without a model fails with model-required before any build or import', async () => {
  const dist = join(root, 'dist');
  const before = existsSync(dist);
  const { result, report } = await spawnScript({ SWITCHBOARD_LIVE_CODEX: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL codex model-required$/mu);
  assert.equal(result.stderr.includes('native SDK tripwire'), false);
  assert.equal(existsSync(dist), before);
  assert.deepEqual(JSON.parse(report).engines.map((item) => [item.engine, item.pass, item.code]), [['codex', false, 'model-required']]);
});

test('a credential value never reaches output or the report', async () => {
  const { result, report } = await spawnScript({ ANTHROPIC_API_KEY: 'canary-live-key' });
  assert.match(result.stdout, /^FAIL claude model-required$/mu);
  assert.equal(`${result.stdout}${result.stderr}${report}`.includes('canary-live-key'), false);
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
