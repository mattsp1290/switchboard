import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexRuntime } from '@mattsp1290/switchboard/codex';

const executable = fileURLToPath(new URL('./sdk-cli.mjs', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sdk-chat-'));
  const id = randomUUID();
  async function account(overrides = {}) {
    await writeFile(join(dir, 'account.json'), JSON.stringify({ id, version: '0.169.0', login: 'Logged in using ChatGPT', ...overrides }));
  }
  await account();
  t.after(() => rm(dir, { recursive: true, force: true }));
  function open() {
    const runtime = createCodexRuntime({ cwd: dir, model: 'gpt-6.1-sol', codexHome: dir, codexPathOverride: executable });
    t.after(() => runtime.close());
    return runtime;
  }
  return { account, dir, id, open };
}

test('native SDK streams message snapshots and resumes with the same subscription and model after restart', async t => {
  const { dir, id, open } = await fixture(t);
  const first = open();
  await first.checkReady();
  const out = [];
  const turn = await first.start({ text: 'one', onEvent: e => out.push(e) });
  assert.equal(turn.threadId, id);
  assert.deepEqual(out, []);
  assert.deepEqual(await turn.finished, { kind: 'ended', outcome: 'completed' });
  assert.deepEqual(out, [{ kind: 'text', itemId: 'item_0', text: 'first' },
    { kind: 'text', itemId: 'item_0', text: 'first second' }, { kind: 'ended', outcome: 'completed' }]);
  await first.close();

  const next = open();
  const continued = await next.start({ text: 'two', threadId: id, onEvent() {} });
  assert.equal((await continued.finished).outcome, 'completed');
  const { args, inherited } = JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('resume') + 1], id);
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol');
  for (const setting of ['forced_login_method="chatgpt"', 'model_provider="openai"', 'approval_policy="never"',
    'openai_base_url="https://chatgpt.com/backend-api/codex"', 'web_search="disabled"', 'features.shell_tool=false',
    'mcp_servers={"fixture.one"={enabled=false}}']) assert(args.includes(setting), setting);
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'NODE_OPTIONS']) assert(!inherited.includes(name));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});

test('alternate login and mismatched CLI are rejected with actionable safe messages before dispatch', async t => {
  const { account, dir, open } = await fixture(t);
  const runtime = open();
  await account({ login: 'Logged in using API key SECRET_FIXTURE' });
  await assert.rejects(runtime.checkReady(), { message: 'Sign in with ChatGPT using codex login to use Codex chat.' });
  await assert.rejects(runtime.start({ text: 'hi', onEvent() {} }), { message: 'Codex operation failed.' });
  await account({ version: '0.168.0' });
  await assert.rejects(runtime.checkReady(), { message: 'Install Codex CLI 0.169.0 to use Codex chat.' });
  await assert.rejects(readFile(join(dir, 'args.json')), { code: 'ENOENT' });
});

test('resume rejects names, missing and mismatched threads, and pre-admission failures', async t => {
  const { id, open } = await fixture(t);
  const runtime = open();
  for (const [text, threadId] of [['one', '--last'], ['one', randomUUID()], ['mismatch', id], ['no admission', id]]) {
    const events = [];
    await assert.rejects(runtime.start({ text, threadId, onEvent: e => events.push(e) }), /Codex operation failed/);
    assert.deepEqual(events, []);
  }
});

test('a writer stays exclusive until abort or close has finished the cooperative native child', async t => {
  const { dir, id, open } = await fixture(t);
  const runtime = open();
  const other = open();
  for (const dispose of ['abort', 'close']) {
    const turn = await runtime.start({ text: dispose === 'abort' ? 'stubborn' : 'pending', threadId: id, onEvent() {} });
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
    await assert.rejects(other.start({ text: 'two', threadId: id, onEvent() {} }), /Codex operation failed/);
    await (dispose === 'abort' ? turn.abort() : runtime.close());
    assert.equal((await turn.finished).outcome, 'interrupted');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  await assert.rejects(runtime.start({ text: 'closed', onEvent() {} }), /Codex operation failed/);
  assert.equal((await (await other.start({ text: 'two', threadId: id, onEvent() {} })).finished).outcome, 'completed');
});

test('a truncated stream, native diagnostic or throwing observer cannot report completion', async t => {
  const { open } = await fixture(t);
  const runtime = open();
  for (const text of ['truncated', 'stderr', 'observer']) {
    const events = [];
    const turn = await runtime.start({ text, onEvent(e) {
      if (e.kind === 'text' && text === 'observer') throw new Error('consumer failure');
      events.push(e);
    } });
    assert.equal((await turn.finished).outcome, 'failed');
    assert.deepEqual(events, [{ kind: 'ended', outcome: 'failed' }]);
  }
});
