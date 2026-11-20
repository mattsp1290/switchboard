import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createClaudeRuntime } from '@mattsp1290/switchboard/claude';
import { assertCoherentReport } from '../adapters/readiness-oracle.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
async function fixture(config, run, model = 'claude-sonnet-4-6') {
  const dir = await mkdtemp(resolve(tmpdir(), 'switchboard-claude-'));
  await writeFile(resolve(dir, 'fixture.json'), JSON.stringify(config));
  const runtime = createClaudeRuntime({ cwd: dir, sessionDirectory: resolve(dir, 'sessions'), apiKey: 'fixture-key', model, claudePathOverride: resolve('tests/adapters/claude/fixture.mjs') });
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
  assert.ok(observed.args.includes('--model=claude-sonnet-4-6'));
  assert.ok(observed.args.includes('--tools='));
  assert.ok(observed.args.includes('--bare'));
}));

test('a caller model id is passed through and admitted unchanged', async () => fixture({}, async (runtime, dir) => {
  const turn = await runtime.start({ text: 'hello', onEvent() {} });
  assert.equal(turn.model, 'claude-haiku-4-5');
  assert.equal((await turn.finished).outcome, 'completed');
  const observed = JSON.parse(await readFile(resolve(dir, 'observed.json'), 'utf8'));
  assert.ok(observed.args.includes('--model=claude-haiku-4-5'));
  assert.ok(!observed.args.includes('--model=sonnet'));
  assert.ok(!observed.args.includes('--model=opus'));
}, 'claude-haiku-4-5'));

test('an init model that differs from the caller id rejects before admission', async () => fixture({ initModel: 'claude-sonnet-4-6' }, async runtime => {
  const events = [];
  await assert.rejects(runtime.start({ text: 'hello', onEvent: event => events.push(event) }), /Claude operation failed/);
  assert.deepEqual(events, []);
}, 'sonnet'));

test('an assistant model that differs from the caller id rejects before admission', async () => fixture({ assistantModel: 'claude-sonnet-4-6' }, async runtime => {
  const events = [];
  await assert.rejects(runtime.start({ text: 'hello', onEvent: event => events.push(event) }), /Claude operation failed/);
  assert.deepEqual(events, []);
}, 'sonnet'));

test('a stream message_start model that differs from the caller id rejects before admission', async () => fixture({ mode: 'stream', streamModel: 'claude-sonnet-4-6' }, async runtime => {
  const events = [];
  await assert.rejects(runtime.start({ text: 'hello', onEvent: event => events.push(event) }), /Claude operation failed/);
  assert.deepEqual(events, []);
}, 'sonnet'));

test('case and null native models reject the caller id before admission', async () => {
  for (const initModel of ['SONNET', 'Sonnet', null]) {
    await fixture({ initModel }, async runtime => {
      const events = [];
      await assert.rejects(runtime.start({ text: 'hello', onEvent: event => events.push(event) }), /Claude operation failed/);
      assert.deepEqual(events, []);
    }, 'sonnet');
  }
});

test('a stream assistant model that changes after admission fails the turn', async () => fixture({ mode: 'stream', assistantModel: 'claude-sonnet-4-6' }, async runtime => {
  const turn = await runtime.start({ text: 'hello', onEvent() {} });
  assert.equal((await turn.finished).outcome, 'failed');
}, 'sonnet'));

test('createClaudeRuntime accepts a one-character and 256-character model id without a child', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'switchboard-claude-'));
  try {
    for (const model of ['a', 'm'.repeat(256), 'modèle-1', 'm\u{1F600}']) {
      const runtime = createClaudeRuntime({ cwd: dir, sessionDirectory: resolve(dir, 'sessions'), apiKey: 'fixture-key', model, claudePathOverride: resolve('tests/adapters/claude/fixture.mjs') });
      await runtime.close();
    }
    await assert.rejects(readFile(resolve(dir, 'observed.json')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('createClaudeRuntime rejects an illegal model id before a child', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'switchboard-claude-'));
  try {
    const base = { cwd: dir, sessionDirectory: resolve(dir, 'sessions'), apiKey: 'fixture-key', claudePathOverride: resolve('tests/adapters/claude/fixture.mjs') };
    assert.throws(() => createClaudeRuntime(base), /Claude operation failed/);
    for (const model of [null, '', '   ', ' id', 'id ', 'x'.repeat(257), '\n', '\u0000', '\u007f', '\u009f', '\uD800', 'id\u0085x', 'id\tx', 1]) {
      assert.throws(() => createClaudeRuntime({ ...base, model }), /Claude operation failed/);
    }
    const legal = { ...base, model: 'claude-sonnet-4-6' };
    for (const input of [
      { ...legal, apiKey: undefined },
      { ...legal, apiKey: null },
      { ...legal, apiKey: 1 },
      { ...legal, apiKey: '' },
      { ...legal, apiKey: '   ' },
      { ...legal, cwd: 1 },
      { ...legal, sessionDirectory: 1 },
      { ...legal, claudePathOverride: 1 },
    ]) assert.throws(() => createClaudeRuntime(input), /Claude operation failed/);
    await assert.rejects(readFile(resolve(dir, 'observed.json')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

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


for (const mode of ['writes-lost-before-hold', 'writes-lost-after-hold']) {
  test(`Stop preserves transcript loss for ${mode}`, {timeout:5000}, async () => fixture({mode}, async (runtime, dir) => {
    const turn = await runtime.start({text:'hello',onEvent() {}});
    const until = Date.now() + 1000;
    while (true) {
      try { await readFile(resolve(dir,'loss-emitted')); break; }
      catch (error) { if (error.code !== 'ENOENT' || Date.now() > until) throw error; }
      await new Promise(resolveDelay => setTimeout(resolveDelay,10));
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay,100));
    await turn.abort();
    assert.equal((await turn.finished).outcome,'failed');
  }));
}

const unsupported = { state: 'unsupported' };
test('Claude readiness reports local paths and the executable override without claiming version or authentication', async () => fixture({}, async (runtime, dir) => {
  const report = assertCoherentReport(await runtime.readinessReport(), ['fixture-key']);
  assert.deepEqual([report.verdict, report.remediation.code, report.checked], ['unverified', 'check_unavailable', ['installation', 'workspace']]);
  assert.deepEqual(report.facts, { installation: { state: 'available' }, version: unsupported, authentication: unsupported, workspace: { state: 'accessible' } });
  const bundled = createClaudeRuntime({ cwd: dir, sessionDirectory: resolve(dir, 'sessions'), apiKey: 'fixture-key', model: 'opus' });
  const plain = assertCoherentReport(await bundled.readinessReport());
  assert.deepEqual([plain.facts.installation, plain.checked], [unsupported, ['workspace']]);
  await bundled.checkReady();
}));

test('Claude readiness separates a missing or non-executable override and an inaccessible directory while checkReady keeps its message', async () => fixture({}, async (runtime, dir) => {
  await writeFile(resolve(dir, 'plain-cli'), '', { mode: 0o644 });
  for (const [cwd, claudePathOverride, fact, state, code] of [
    [dir, resolve(dir, 'missing-cli'), 'installation', 'not_installed', 'install_required'],
    [dir, resolve(dir, 'plain-cli'), 'installation', 'not_executable', 'install_required'],
    [resolve(dir, 'gone'), resolve('tests/adapters/claude/fixture.mjs'), 'workspace', 'inaccessible', 'workspace_unavailable'],
  ]) {
    const other = createClaudeRuntime({ cwd, sessionDirectory: resolve(dir, 'sessions'), apiKey: 'SECRET_CLAUDE_KEY', model: 'sonnet', claudePathOverride });
    const report = assertCoherentReport(await other.readinessReport(), ['SECRET_CLAUDE_KEY', dir]);
    assert.deepEqual([report.verdict, report.facts[fact].state, report.remediation.code], ['blocked', state, code]);
    await assert.rejects(other.checkReady(), { message: 'Claude operation failed.' });
  }
}));

test('Claude readiness honours a pre-aborted signal and reports a closed runtime', async () => fixture({}, async runtime => {
  const cancelled = assertCoherentReport(await runtime.readinessReport({ signal: AbortSignal.abort() }));
  assert.deepEqual([cancelled.facts.installation.state, cancelled.facts.workspace.state, cancelled.remediation.code], ['cancelled', 'cancelled', 'check_cancelled']);
  await assert.rejects(runtime.readinessReport({ signal: 'abort' }), /Claude operation failed/);
  await runtime.close();
  const closed = assertCoherentReport(await runtime.readinessReport());
  assert.deepEqual([closed.checked, closed.facts.workspace.state, closed.remediation.code], [[], 'not_checked', 'runtime_closed']);
  await assert.rejects(runtime.checkReady(), /Claude operation failed/);
}));
