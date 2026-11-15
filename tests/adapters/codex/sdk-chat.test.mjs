import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexRuntime } from './sdk-runtime.mjs';

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
    'mcp_servers={"fixture.one"={enabled=false,command="switchboard-disabled-mcp"}}']) assert(args.includes(setting), setting);
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

test('SDK error notices can be followed by a successful native completion', async t => {
  const { open } = await fixture(t);
  const runtime = open();
  for (const text of ['retry before admission', 'retry after admission']) {
    const events = [];
    const turn = await runtime.start({ text, onEvent: e => events.push(e) });
    assert.equal((await turn.finished).outcome, 'completed');
    assert.equal(events.at(-1).outcome, 'completed');
    assert.equal(events.filter(e => e.kind === 'ended').length, 1);
  }
});

test('stop and shutdown preserve a native terminal event received before child exit', async t => {
  const { dir, open } = await fixture(t);
  for (const outcome of ['completed', 'failed']) {
    for (const dispose of ['abort', 'close']) {
      const runtime = open();
      const events = [];
      const turn = await runtime.start({ text: outcome + ' waiting', onEvent: e => events.push(e) });
      const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
      await setTimeout(250);
      await (dispose === 'abort' ? turn.abort() : runtime.close());
      assert.equal((await turn.finished).outcome, outcome);
      assert.deepEqual(events, [{ kind: 'ended', outcome }]);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  }
});

test('shutdown waits for stubborn CLI children in every preflight and standalone readiness', async t => {
  const { account, dir, open } = await fixture(t);
  for (const preflight of ['--version', 'login', 'mcp', 'standalone']) {
    await rm(join(dir, 'pid'), { force: true });
    await account({ preflight: preflight === 'standalone' ? '--version' : preflight });
    const runtime = open();
    const pending = (preflight === 'standalone' ? runtime.checkReady() : runtime.start({ text: 'one', onEvent() {} })).catch(() => {});
    let pid;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { pid = Number(await readFile(join(dir, 'pid'), 'utf8')); break; } catch { await setTimeout(10); }
    }
    assert(pid, 'preflight child started');
    await runtime.close();
    await pending;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('relative executable overrides cannot select different preflight and SDK binaries', async t => {
  const { dir } = await fixture(t);
  assert.throws(() => createCodexRuntime({ cwd: dir, model: 'gpt-6.1-sol', codexPathOverride: './cli' }), /Codex operation failed/);
});

test('an early native exit during a large stdin write cannot crash the host', async t => {
  const { account, dir } = await fixture(t);
  await account({ exitBeforeInput: true });
  const program = `
    import { createCodexRuntime } from ${JSON.stringify(new URL('./sdk-runtime.mjs', import.meta.url).href)};
    const runtime = createCodexRuntime(${JSON.stringify({ cwd: dir, model: 'gpt-6.1-sol', codexHome: dir, codexPathOverride: executable })});
    try {
      await runtime.start({ text: 'x'.repeat(1024 * 1024), onEvent() {} });
      process.exitCode = 1;
    } catch { console.log('caught'); }
    finally { await runtime.close(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { timeout: 10000 });
  assert.equal(stdout.trim(), 'caught');
});

test('the pinned native CLI accepts disabled MCP entries without their original credentials', async t => {
  const { dir, open } = await fixture(t);
  const runtime = open();
  assert.equal((await (await runtime.start({ text: 'one', onEvent() {} })).finished).outcome, 'completed');
  const { args } = JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'));
  const override = args.find(arg => arg.startsWith('mcp_servers='));
  await writeFile(join(dir, 'config.toml'), '[mcp_servers."fixture.one"]\ncommand="unused-original-command"\n');
  const cli = fileURLToPath(new URL('../../../node_modules/@openai/codex/bin/codex.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'mcp', 'list', '--json', '-c', override], {
    env: { HOME: dir, CODEX_HOME: dir, PATH: process.env.PATH }, timeout: 10000,
  });
  const servers = JSON.parse(stdout);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'fixture.one');
  assert.equal(servers[0].enabled, false);
  assert.equal(servers[0].transport.command, 'switchboard-disabled-mcp');
});

test('a readiness deadline terminates an uncooperative CLI without shutdown', { timeout: 15000 }, async t => {
  const { account, dir, open } = await fixture(t);
  await account({ preflight: '--version' });
  const runtime = open();
  await assert.rejects(runtime.checkReady(), { message: 'Install Codex CLI 0.169.0 to use Codex chat.' });
  const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('a missing absolute CLI fails readiness without waiting for an exit event', { timeout: 3000 }, async t => {
  const { dir } = await fixture(t);
  const runtime = createCodexRuntime({ cwd: dir, model: 'gpt-6.1-sol', codexPathOverride: join(dir, 'missing-cli') });
  t.after(() => runtime.close());
  await assert.rejects(runtime.checkReady(), { message: 'Install Codex CLI 0.169.0 to use Codex chat.' });
});
