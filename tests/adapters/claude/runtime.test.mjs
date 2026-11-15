import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createClaudeRuntime } from '../../../adapters/claude/src/index.ts';

const id = '12345678-1234-1234-1234-123456789abc';
async function fixture(config, run) {
  const dir = await mkdtemp(resolve(tmpdir(), 'switchboard-claude-'));
  await writeFile(resolve(dir, 'fixture.json'), JSON.stringify(config));
  const runtime = createClaudeRuntime({ cwd: dir, sessionDirectory: resolve(dir, 'sessions'), apiKey: 'fixture-key', model: 'sonnet', claudePathOverride: resolve('tests/adapters/claude/fixture.mjs') });
  try { await run(runtime, dir); } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
}

test('SDK creates and resumes a session and retains text blocks', async () => fixture({}, async (runtime, dir) => {
  await runtime.checkReady();
  for (const threadId of [undefined, id]) {
    const events = [];
    const turn = await runtime.start({ text: 'hello', ...(threadId ? { threadId } : {}), onEvent: event => events.push(event) });
    assert.equal(turn.threadId, id);
    assert.equal(turn.model, 'claude-sonnet-4-6');
    assert.equal((await turn.finished).outcome, 'completed');
    assert.deepEqual(events.map(event => event.kind === 'text' ? event.text : event.outcome), ['hello', 'hello world', 'completed']);
  }
  const observed = JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8'));
  assert.equal(observed.env.ANTHROPIC_API_KEY, 'fixture-key');
  assert.equal(observed.env.CLAUDE_CONFIG_DIR, resolve(dir, 'sessions'));
  assert.equal(observed.env.ANTHROPIC_BASE_URL, undefined);
  assert.ok(observed.args.includes(`--resume=${id}`));
  assert.ok(observed.args.includes('--model=sonnet'));
  assert.ok(observed.args.includes('--tools='));
  assert.ok(observed.args.includes('--bare'));
}));

test('SDK error frames are suppressed and do not admit the turn', async () => fixture({mode:'error'}, async runtime => {
  const events = [];
  await assert.rejects(runtime.start({text:'hello',onEvent:event => events.push(event)}), /Claude operation failed/);
  assert.deepEqual(events, []);
}));

test('SDK error result fails an admitted turn', async () => fixture({mode:'result-error'}, async runtime => {
  const turn = await runtime.start({text:'hello',onEvent() {}});
  assert.equal((await turn.finished).outcome, 'failed');
}));

test('stop waits for the native process and reports interruption', async () => fixture({mode:'stream-hold'}, async (runtime, dir) => {
  const turn = await runtime.start({text:'hello',onEvent() {}});
  const observed = JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8'));
  await turn.abort();
  assert.equal((await turn.finished).outcome, 'interrupted');
  assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' });
}));

test('a mismatched native resume ID is rejected', async () => fixture({}, async runtime => {
  await assert.rejects(runtime.start({text:'hello',threadId:'87654321-4321-4321-4321-cba987654321',onEvent() {}}), /Claude operation failed/);
}));


test('initialization alone does not admit a turn', async () => fixture({mode:'init-only'}, async runtime => {
  let settled = false;
  const start = runtime.start({text:'hello',onEvent() {}}).finally(() => { settled = true; });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
  assert.equal(settled, false);
  await runtime.close();
  await assert.rejects(start, /Claude operation failed/);
}));


test('partial text is published once and final assistant frames do not duplicate it', async () => fixture({mode:'stream'}, async runtime => {
  const events = [];
  const turn = await runtime.start({text:'hello',onEvent:event => events.push(event)});
  assert.equal((await turn.finished).outcome, 'completed');
  assert.deepEqual(events.filter(event => event.kind === 'text').map(event => [event.itemId, event.text]), [['stream-1:0', 'hello'], ['stream-1:1', ' world']]);
}));


test('a missing resumed session is rejected without starting a new turn', async () => fixture({mode:'missing'}, async runtime => {
  await assert.rejects(runtime.start({text:'hello',threadId:id,onEvent() {}}), /Claude operation failed/);
}));

test('independent sessions can run at the same time', async () => fixture({mode:'stream-hold'}, async first => fixture({mode:'stream-hold', id:'87654321-4321-4321-4321-cba987654321'}, async second => {
  const [one, two] = await Promise.all([first.start({text:'one',onEvent() {}}), second.start({text:'two',onEvent() {}})]);
  assert.notEqual(one.threadId, two.threadId);
  await Promise.all([one.abort(), two.abort()]);
  assert.equal((await one.finished).outcome, 'interrupted');
  assert.equal((await two.finished).outcome, 'interrupted');
})));


test('informational system frames after a result preserve the native outcome', async () => fixture({mode:'post-result-system'}, async runtime => {
  const turn = await runtime.start({text:'hello',onEvent() {}});
  assert.equal((await turn.finished).outcome, 'completed');
}));


test('lost active transcripts fail the turn and cannot be resumed in this runtime', async () => fixture({mode:'writes-lost'}, async runtime => {
  const events = [];
  const turn = await runtime.start({text:'hello',onEvent:event => events.push(event)});
  assert.equal((await turn.finished).outcome, 'failed');
  assert.deepEqual(events.at(-1), {kind:'ended',outcome:'failed'});
  assert(!JSON.stringify(events).includes('secret diagnostic'));
  await assert.rejects(runtime.start({text:'again',threadId:id,onEvent() {}}), /Claude operation failed/);
}));

test('unrelated transcript and configuration losses preserve completion', async () => {
  for (const mode of ['writes-lost-other', 'writes-lost-config']) await fixture({mode}, async runtime => {
    const turn = await runtime.start({text:'hello',onEvent() {}});
    assert.equal((await turn.finished).outcome, 'completed');
  });
});

test('child excludes seeded ambient credentials and routing settings', async () => {
  const names = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'ARBITRARY_SECRET'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'sentinel-secret';
    await fixture({}, async (runtime, dir) => {
      const turn = await runtime.start({text:'hello',onEvent() {}});
      await turn.finished;
      const observed = JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8'));
      for (const name of names) assert.equal(observed.env[name], undefined, name);
      assert(!observed.args.some(arg => arg.includes('fixture-key')));
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});


test('stop reaps a child that ignores SIGTERM and keeps stdout open', {timeout: 5000}, async () => fixture({mode:'stubborn'}, async (runtime, dir) => {
  const turn = await runtime.start({text:'hello',onEvent() {}});
  const observed = JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8'));
  await turn.abort();
  assert.equal((await turn.finished).outcome, 'interrupted');
  assert.throws(() => process.kill(observed.pid, 0), {code:'ESRCH'});
}));


test('case variants cannot bypass the same-session writer guard', async () => fixture({mode:'stream-hold'}, async (runtime, dir) => {
  const turn = await runtime.start({text:'hello',onEvent() {}});
  const before = JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8'));
  await assert.rejects(runtime.start({text:'again',threadId:id.toUpperCase(),onEvent() {}}), /Claude operation failed/);
  assert.equal(JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8')).pid, before.pid);
  await turn.abort();
}));

for (const mode of ['stubborn', 'stubborn-init']) {
  test(`runtime shutdown reaps ${mode} children`, {timeout:5000}, async () => fixture({mode}, async (runtime, dir) => {
    const started = runtime.start({text:'hello',onEvent() {}});
    const rejected = started.catch(() => null);
    if (mode === 'stubborn') await started;
    else await new Promise(resolveDelay => setTimeout(resolveDelay,150));
    const observed = JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8'));
    await runtime.close();
    await rejected;
    assert.throws(() => process.kill(observed.pid,0), {code:'ESRCH'});
  }));
}
