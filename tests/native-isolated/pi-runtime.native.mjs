import { qualificationImage } from '../../scripts/support/qualification-image.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { AgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createPiRuntime } from '@operatorworks/switchboard/pi';
import { assertCoherentReport } from '../adapters/readiness-oracle.mjs';

// The terminal mapping is internal to the packed entry, so it is loaded by file URL past the exports map.
const { terminalOutcome } = await import(new URL('terminal.js', import.meta.resolve('@operatorworks/switchboard/pi')).href);

const key = 'fixture-key-never-log';
const frame = (content, finish_reason = null, model = 'glm-5.3') => `data: ${JSON.stringify({
  id: 'fixture', object: 'chat.completion.chunk', created: 1, model,
  choices: [{ index: 0, delta: content === null ? {} : { role: 'assistant', content }, finish_reason }],
})}\n\n`;

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-pi-'));
  const requests = [];
  const runtimes = [];
  let expectedModel = 'glm-5.3';
  const sse = (content, finish_reason = null) => frame(content, finish_reason, expectedModel);
  let respond = () => new Response(sse('Hello') + sse(' world') + sse(null, 'stop') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${key}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, expectedModel);
    assert.equal(body.tools?.length ?? 0, 0);
    requests.push(body);
    return respond(init);
  };
  const options = { cwd: directory, sessionDirectory: join(directory, 'sessions'), apiKey: key, provider: 'opencode-go', model: 'glm-5.3' };
  const runtime = async (extra = {}) => {
    const merged = { ...options, ...extra };
    expectedModel = merged.model;
    const value = await createPiRuntime(merged);
    runtimes.push(value);
    return value;
  };
  try { await run({ directory, options, requests, runtime, sse, respond: value => { respond = value; } }); }
  finally {
    await Promise.all(runtimes.map(value => value.close()));
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
}

async function prompt(session, text = 'Hello') {
  const events = [];
  const accepted = await session.prompt(text, event => events.push(event));
  const terminal = await accepted.finished;
  return { events, terminal };
}

test('Pi SDK streams text, follows up, persists and resumes without config discovery', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime, requests }) => {
    await writeFile(join(directory, 'AGENTS.md'), 'SECRET CONTEXT MUST NOT BE SENT');
    const first = await runtime();
    assert.equal(requests.length, 0, 'Runtime and catalog startup stay offline.');
    const session = await first.open();
    assert.equal(session.sessionFile, basename(session.sessionFile));
    const one = await prompt(session);
    const snapshots = one.events.filter(event => event.kind === 'text').map(event => event.text);
    assert.equal(snapshots.at(-1), 'Hello world');
    assert(snapshots.every((text, index) => index === 0 || text.startsWith(snapshots[index - 1])));
    assert.deepEqual(one.events.at(-1), { kind: 'ended', outcome: 'completed' });
    assert.equal(one.terminal.outcome, 'completed');
    assert.equal((await prompt(session, 'Follow up')).terminal.outcome, 'completed');
    const id = session.id;
    const sessionFile = session.sessionFile;
    const saved = await readFile(join(directory, 'sessions', sessionFile), 'utf8');
    assert.equal(JSON.parse(saved.split('\n')[0]).id, id);
    await first.close();
    const second = await runtime();
    const resumed = await second.open({ sessionFile });
    assert.equal(resumed.id, id);
    await prompt(resumed, 'After restart');
    assert.equal(requests.length, 3);
    assert.equal(requests[2].messages.filter(message => message.role === 'user').length, 3);
    assert(!JSON.stringify(requests).includes('SECRET CONTEXT'));
  });
});

test('the observation listener sees admission, text snapshots, unsupported families and one terminal', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, respond, sse }) => {
    const current = await runtime();
    const session = await current.open();
    const observed = [];
    const events = [];
    const accepted = await session.prompt('Hello', event => events.push(event), observation => observed.push(observation));
    assert.deepEqual(await accepted.finished, { kind: 'ended', outcome: 'completed' });
    assert.deepEqual(events.at(-1), { kind: 'ended', outcome: 'completed' });
    assert.equal(observed[0].kind, 'run-started');
    assert.deepEqual(observed.filter(o => o.kind === 'unsupported').map(o => o.family),
      ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents', 'reasoning']);
    assert.equal(observed.findLastIndex(o => o.kind === 'unsupported'), observed.length - (observed.some(o => o.kind === 'usage') ? 3 : 2));
    const texts = observed.filter(o => o.kind === 'text');
    assert(texts.length > 0 && texts.every(o => o.mode === 'snapshot' && o.messageId === texts[0].messageId));
    assert.equal(texts.at(-1).text, 'Hello world');
    assert(texts.every((o, index) => index === 0 || o.text.startsWith(texts[index - 1].text)));
    const usage = observed.filter(o => o.kind === 'usage');
    assert(usage.length <= 1);
    for (const row of usage.flatMap(o => o.rows)) {
      assert(Object.keys(row).every(k => ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens'].includes(k)));
      assert(row.inputTokens !== undefined && row.outputTokens !== undefined);
      assert((row.inputTokens) >= (row.cachedInputTokens ?? 0) + (row.cacheWriteInputTokens ?? 0));
    }
    assert.deepEqual(observed.at(-1), { kind: 'terminal', outcome: 'success' });
    assert.equal(observed.filter(o => o.kind === 'terminal').length, 1);
    assert(!observed.some(o => o.kind === 'tool' || o.kind === 'reasoning' || o.kind === 'model-boundary'));
    assert(observed.every(Object.isFrozen));

    const throwing = await session.prompt('Again', () => {}, () => { throw new Error('listener failure'); });
    assert.equal((await throwing.finished).outcome, 'completed');
    await assert.rejects(session.prompt('Bad', () => {}, 'nope'), /Pi operation failed/);

    respond(() => new Response(JSON.stringify({ error: { message: key } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const failed = [];
    assert.equal((await (await session.prompt('Fail', () => {}, o => failed.push(o))).finished).outcome, 'failed');
    assert.deepEqual(failed.at(-1), { kind: 'terminal', outcome: 'failed' });
    assert(!JSON.stringify(failed).includes(key));

    const requestStarted = Promise.withResolvers();
    respond(init => {
      let stream;
      const body = new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(sse('partial'))); } });
      init.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      requestStarted.resolve();
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const cancelled = [];
    const waiting = await session.prompt('Wait', () => {}, o => cancelled.push(o));
    await requestStarted.promise;
    await session.abort();
    assert.equal((await waiting.finished).outcome, 'interrupted');
    assert.deepEqual(cancelled.at(-1), { kind: 'terminal', outcome: 'cancelled' });
    assert.equal(cancelled.filter(o => o.kind === 'terminal').length, 1);
  });
});

test('unprompted sessions leave no journal and cannot be resumed', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime }) => {
    const current = await runtime();
    const session = await current.open();
    await session.close();
    await assert.rejects(access(join(directory, 'sessions', session.sessionFile)), { code: 'ENOENT' });
    await assert.rejects(current.open({ sessionFile: session.sessionFile }), /Pi operation failed/);
  });
});

test('the first prompt stopped during preflight records a resumable user message', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime, requests }) => {
    const current = await runtime();
    const session = await current.open();
    const pending = session.prompt('Stop the first prompt', () => {});
    await session.abort();
    assert.equal((await (await pending).finished).outcome, 'interrupted');
    await session.close();
    const entries = (await readFile(join(directory, 'sessions', session.sessionFile), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(entries.some(entry => entry.type === 'message' && entry.message.role === 'user'));
    assert.equal(requests.length, 0);
    assert.equal((await current.open({ sessionFile: session.sessionFile })).id, session.id);
  });
});

test('writer reservation survives rejected duplicate opens and releases after close', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime }) => {
    const first = await runtime();
    const second = await runtime();
    const session = await first.open();
    await prompt(session);
    for (let index = 0; index < 2; index++) await assert.rejects(second.open({ sessionFile: session.sessionFile }), /Pi operation failed/);
    const independent = await second.open();
    assert.notEqual(independent.id, session.id);
    await session.close();
    assert.equal((await second.open({ sessionFile: session.sessionFile })).id, session.id);
  });
});

test('resume rejects missing, empty, malformed, traversing and symlink session files', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime }) => {
    const current = await runtime();
    await writeFile(join(directory, 'sessions', 'empty.jsonl'), '');
    await writeFile(join(directory, 'sessions', 'bad.jsonl'), '{}\n');
    await writeFile(join(directory, 'sessions', 'oversized.jsonl'), ' '.repeat(64 * 1024) + '\n');
    await writeFile(join(directory, 'outside.jsonl'), '{"type":"session","id":"x"}\n');
    await symlink(join(directory, 'outside.jsonl'), join(directory, 'sessions', 'link.jsonl'));
    for (const sessionFile of ['missing.jsonl', 'empty.jsonl', 'bad.jsonl', 'oversized.jsonl', '../outside.jsonl', 'link.jsonl']) {
      await assert.rejects(current.open({ sessionFile }), /Pi operation failed/);
    }
  });
});

test('native admission resolves before the streamed answer and Stop drains ownership', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, respond, sse }) => {
    const requestStarted = Promise.withResolvers();
    respond(init => {
      let stream;
      const body = new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(sse('partial'))); } });
      init.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      requestStarted.resolve();
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const current = await runtime();
    const session = await current.open();
    const partial = Promise.withResolvers();
    const accepted = await session.prompt('Wait', event => { if (event.kind === 'text') partial.resolve(event.text); });
    await requestStarted.promise;
    assert.equal(await partial.promise, 'partial');
    await assert.rejects(session.prompt('Overlap', () => {}), /busy/);
    await assert.rejects(session.prompt(' ', () => {}), /busy/);
    await session.abort();
    assert.equal((await accepted.finished).outcome, 'interrupted');
    await session.close();
    const reopened = await current.open({ sessionFile: session.sessionFile });
    assert.equal(reopened.id, session.id);
  });
});

test('native admission persists the first user message before any provider frame', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime, respond }) => {
    const requestStarted = Promise.withResolvers();
    respond(init => {
      const body = new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } });
      requestStarted.resolve();
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const current = await runtime();
    const session = await current.open();
    const events = [];
    const accepted = await session.prompt('Persist before the first token', event => events.push(event));
    const entries = readFileSync(join(directory, 'sessions', session.sessionFile), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(entries.some(entry => entry.type === 'message' && entry.message.role === 'user'
      && entry.message.content.some(part => part.type === 'text' && part.text === 'Persist before the first token')));
    await requestStarted.promise;
    assert.deepEqual(events, []);
    await session.abort();
    assert.deepEqual(await accepted.finished, { kind: 'ended', outcome: 'interrupted' });
    assert.deepEqual(events, [{ kind: 'ended', outcome: 'interrupted' }]);
  });
});

test('provider errors become failed terminals without retries or credential text', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime, requests, respond }) => {
    respond(() => new Response(JSON.stringify({ error: { message: key } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const current = await runtime();
    const session = await current.open();
    const result = await prompt(session);
    assert.equal(result.terminal.outcome, 'failed');
    assert(!(await readFile(join(directory, 'sessions', session.sessionFile), 'utf8')).includes(key), 'Provider diagnostics must not persist credentials.');
    assert(!JSON.stringify(result).includes(key));
    assert.equal(requests.length, 1);
  });
});

test('runtime closes sessions and enforces its limit', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime }) => {
    const current = await runtime();
    const sessions = await Promise.all(Array.from({ length: 32 }, () => current.open()));
    await assert.rejects(current.open(), /limit/);
    await current.close();
    await assert.rejects(current.open(), /closed/);
    await assert.rejects(sessions[0].prompt('Closed', () => {}), /closed/);
    await assert.rejects(sessions[0].prompt(' ', () => {}), /closed/);
  });
});

test('glm-5.3-flash is forwarded as the provider request model', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, requests }) => {
    const current = await runtime({ model: 'glm-5.3-flash' });
    const session = await current.open();
    await prompt(session);
    assert.equal(requests.at(-1).model, 'glm-5.3-flash');
  });
});

test('a resumed session uses the runtime model, not the model that wrote the journal', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, requests }) => {
    const first = await runtime({ model: 'glm-5.3' });
    const session = await first.open();
    await prompt(session);
    const sessionFile = session.sessionFile;
    await first.close();
    const second = await runtime({ model: 'glm-5.3-flash' });
    const resumed = await second.open({ sessionFile });
    await prompt(resumed, 'After a different model');
    assert.equal(requests[0].model, 'glm-5.3');
    assert.equal(requests.at(-1).model, 'glm-5.3-flash');
  });
});

test('createPiRuntime rejects an illegal model id before a session directory or fetch', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, options, requests }) => {
    const withoutModel = { ...options };
    delete withoutModel.model;
    const cases = [
      withoutModel,
      { ...options, model: null },
      { ...options, model: '' },
      { ...options, model: '   ' },
      { ...options, model: ' id' },
      { ...options, model: 'id ' },
      { ...options, model: 'x'.repeat(257) },
      { ...options, model: '\n' },
      { ...options, model: '\u0000' },
      { ...options, model: '\u007f' },
      { ...options, model: '\u009f' },
      { ...options, model: '\uD800' },
      { ...options, model: 'id\u0085x' },
      { ...options, model: 'id\tx' },
      { ...options, model: 1 },
    ];
    for (const [index, input] of cases.entries()) {
      const sessionDirectory = join(directory, `illegal-${index}`);
      await assert.rejects(createPiRuntime({ ...input, sessionDirectory }), /Pi operation failed/);
      await assert.rejects(access(sessionDirectory), { code: 'ENOENT' });
    }
    assert.equal(requests.length, 0);
  });
});

test('catalog misses fail after the session directory exists and do not fetch', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, options, requests }) => {
    for (const model of ['a', 'm'.repeat(256), 'unsupported', 'modèle-1', 'm\u{1F600}']) {
      const sessionDirectory = join(directory, `catalog-${model.length}`);
      await assert.rejects(createPiRuntime({ ...options, sessionDirectory, model }), /Pi operation failed/);
      await access(sessionDirectory);
    }
    assert.equal(requests.length, 0);
  });
});


test('Stop during native preflight drains before follow-up and restart', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime }) => {
    const current = await runtime();
    const session = await current.open();
    const pending = session.prompt('Stop immediately', () => {});
    await session.abort();
    const accepted = await pending;
    assert.equal((await accepted.finished).outcome, 'interrupted');
    assert.equal((await prompt(session, 'Continue')).terminal.outcome, 'completed');
    await session.close();
    assert.equal((await current.open({ sessionFile: session.sessionFile })).id, session.id);
  });
});

test('runtime close drains an opening session and releases its reservation', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime }) => {
    const current = await runtime();
    const pending = current.open();
    const rejected = assert.rejects(pending, /Pi operation failed/);
    await current.close();
    await rejected;
    await assert.rejects(current.open(), /closed/);
  });
});


test('late Stop preserves the completed native assistant stop reason', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime }) => {
    const current = await runtime();
    const session = await current.open();
    let stopping;
    const accepted = await session.prompt('Complete before cleanup', event => {
      if (event.kind === 'ended') stopping = session.abort();
    });
    const terminal = await accepted.finished;
    await stopping;
    const entries = (await readFile(join(directory, 'sessions', session.sessionFile), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const last = entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
    assert.equal(last.message.stopReason, 'stop');
    assert.equal(terminal.outcome, 'completed');
  });
});

test('terminal observer failure makes the returned result fail', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime }) => {
    const current = await runtime();
    const session = await current.open();
    const accepted = await session.prompt('Hello', event => {
      if (event.kind === 'ended') throw new Error(key);
    });
    assert.deepEqual(await accepted.finished, { kind: 'ended', outcome: 'failed' });
  });
});


test('native terminal facts win over an abort intent during delayed cleanup', () => {
  assert.equal(terminalOutcome('stop', true), 'completed');
  assert.equal(terminalOutcome('length', true), 'completed');
  assert.equal(terminalOutcome('error', true), 'failed');
  assert.equal(terminalOutcome('aborted', false), 'interrupted');
  assert.equal(terminalOutcome(undefined, true), 'interrupted');
  assert.equal(terminalOutcome(undefined, false), 'failed');
});


test('rejected native admission emits no terminal or private diagnostics', { timeout: 10_000 }, async t => {
  await fixture(async ({ runtime }) => {
    const current = await runtime();
    const session = await current.open();
    t.mock.method(AgentSession.prototype, 'prompt', async () => { throw new Error(key); });
    const events = [];
    await assert.rejects(session.prompt('Rejected', event => events.push(event)), /^Error: Pi operation failed\.$/);
    assert.deepEqual(events, []);
  });
});

test('started native preflight without a persisted user message rejects admission', { timeout: 10_000 }, async t => {
  await fixture(async ({ runtime }) => {
    const current = await runtime();
    const session = await current.open();
    t.mock.method(AgentSession.prototype, 'prompt', async (_text, options) => {
      options.preflightResult('started');
      throw new Error(key);
    });
    const events = [];
    await assert.rejects(session.prompt('Rejected', event => events.push(event)), /^Error: Pi operation failed\.$/);
    assert.deepEqual(events, []);
  });
});

test('missing native journal rejects admission and drains without observer terminals', { timeout: 10_000 }, async t => {
  await fixture(async ({ runtime, requests }) => {
    const current = await runtime();
    const session = await current.open();
    t.mock.method(SessionManager.prototype, 'appendMessage', () => 'unpersisted');
    const events = [];
    await assert.rejects(session.prompt('Rejected', event => events.push(event)), /^Error: Pi operation failed\.$/);
    await session.abort();
    assert.deepEqual(events, []);
    assert.equal(requests.length, 0);
  });
});

test('runtime close releases drained writers and scrubs credentials even when native dispose throws', { timeout: 10_000 }, async t => {
  await fixture(async ({ options, runtime }) => {
    const current = await createPiRuntime(options);
    const one = await current.open();
    const two = await current.open();
    await prompt(one);
    await prompt(two);
    const disposed = [];
    const deleted = [];
    const realDispose = AgentSession.prototype.dispose;
    const realDelete = InMemoryCredentialStore.prototype.delete;
    t.mock.method(AgentSession.prototype, 'dispose', function () {
      realDispose.call(this);
      disposed.push(this.sessionId);
      if (disposed.length === 1) throw new Error(key);
    });
    t.mock.method(InMemoryCredentialStore.prototype, 'delete', async function (provider) {
      await realDelete.call(this, provider);
      deleted.push(await this.read(provider));
    });
    try {
      await assert.rejects(current.close(), /^Error: Pi operation failed\.$/);
      assert.deepEqual(disposed.sort(), [one.id, two.id].sort(), 'Every session must be disposed despite a sibling failure.');
      assert.deepEqual(deleted, [undefined], 'The runtime credential is removed even when close rejects.');
      const next = await runtime();
      assert.equal((await next.open({ sessionFile: one.sessionFile })).id, one.id);
      assert.equal((await next.open({ sessionFile: two.sessionFile })).id, two.id);
    } finally { await current.close().catch(() => {}); }
  });
});

test('failed native drain retains the writer reservation', { timeout: 10_000 }, async t => {
  await fixture(async ({ options, runtime }) => {
    const current = await createPiRuntime(options);
    const session = await current.open();
    await prompt(session);
    const realWait = AgentSession.prototype.waitForIdle;
    t.mock.method(AgentSession.prototype, 'waitForIdle', async function () {
      if (this.sessionId === session.id) throw new Error(key);
      return realWait.call(this);
    });
    try {
      await assert.rejects(current.close(), /^Error: Pi operation failed\.$/);
      const next = await runtime();
      await assert.rejects(next.open({ sessionFile: session.sessionFile }), /Pi operation failed/);
    } finally { await current.close().catch(() => {}); }
  });
});

test('opening cleanup releases a drained writer when native dispose throws', { timeout: 10_000 }, async t => {
  await fixture(async ({ runtime }) => {
    const first = await runtime();
    const session = await first.open();
    await prompt(session);
    await session.close();
    const realDispose = AgentSession.prototype.dispose;
    let thrown = false;
    t.mock.method(AgentSession.prototype, 'dispose', function () {
      realDispose.call(this);
      if (!thrown) { thrown = true; throw new Error(key); }
    });
    const closing = await runtime();
    const pending = closing.open({ sessionFile: session.sessionFile });
    const rejected = assert.rejects(pending, /^Error: Pi operation failed\.$/);
    await closing.close();
    await rejected;
    assert(thrown);
    const next = await runtime();
    assert.equal((await next.open({ sessionFile: session.sessionFile })).id, session.id);
  });
});


test('case aliases never admit a second writer for one native journal', async () => {
  await fixture(async ({ runtime }) => {
    const first = await runtime();
    const second = await runtime();
    const session = await first.open();
    await prompt(session, 'Original turn');
    const alias = session.sessionFile.replace(/[A-Za-z]/, character => character === character.toUpperCase() ? character.toLowerCase() : character.toUpperCase());
    assert.notEqual(alias, session.sessionFile);
    await assert.rejects(second.open({ sessionFile: alias }), /Pi operation failed/);
    assert.equal((await prompt(session, 'Original writer continues')).terminal.outcome, 'completed');
    await session.close();
    const reopened = await second.open({ sessionFile: session.sessionFile });
    assert.equal(reopened.id, session.id);
    assert.equal((await prompt(reopened, 'Reopened writer continues')).terminal.outcome, 'completed');
  });
});


test('admission rejects an unwritable follow-up journal instead of trusting the old file', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime, requests }) => {
    const current = await runtime();
    const session = await current.open();
    await prompt(session, 'Saved first prompt');
    const path = join(directory, 'sessions', session.sessionFile);
    await chmod(path, 0o400);
    try {
      await assert.rejects(session.prompt('Unwritten follow-up must not be admitted', () => {}), /Pi operation failed/);
      await session.abort();
      assert.equal(requests.length, 1);
      assert(!(await readFile(path, 'utf8')).includes('Unwritten follow-up'));
    } finally { await chmod(path, 0o600); }
    await session.close();
    const reopened = await current.open({ sessionFile: session.sessionFile });
    assert.equal((await prompt(reopened, 'Continue original history')).terminal.outcome, 'completed');
    assert.equal(requests.at(-1).messages.filter(message => message.role === 'user').length, 2);
  });
});

test('Pi readiness reports its directories but never installation, version or authentication', { timeout: 10_000 }, async () => {
  await fixture(async ({ directory, runtime, requests }) => {
    const pi = await runtime();
    const unsupported = { state: 'unsupported' };
    const report = assertCoherentReport(await pi.readinessReport(), [key]);
    assert.deepEqual([report.verdict, report.remediation.code, report.checked], ['unverified', 'check_unavailable', ['workspace']]);
    assert.deepEqual(report.facts, { installation: unsupported, version: unsupported, authentication: unsupported, workspace: { state: 'accessible' } });
    const cancelled = assertCoherentReport(await pi.readinessReport({ signal: AbortSignal.abort() }));
    assert.deepEqual([cancelled.facts.workspace.state, cancelled.remediation.code], ['cancelled', 'check_cancelled']);
    await assert.rejects(pi.readinessReport({ signal: 'abort' }), /Pi operation failed/);
    await rm(join(directory, 'sessions'), { recursive: true });
    const missing = assertCoherentReport(await pi.readinessReport(), [key, directory]);
    assert.deepEqual([missing.verdict, missing.facts.workspace.state, missing.remediation.code], ['blocked', 'inaccessible', 'workspace_unavailable']);
    await pi.close();
    const closed = assertCoherentReport(await pi.readinessReport());
    assert.deepEqual([closed.checked, closed.facts.workspace.state, closed.remediation.code], [[], 'not_checked', 'runtime_closed']);
    assert.equal(requests.length, 0);
  });
});

function imageModel(t) {
  const original = ModelRuntime.prototype.getModel;
  t.mock.method(ModelRuntime.prototype, 'getModel', function(provider, id) {
    const native = original.call(this, provider, id === 'fixture-image' ? 'glm-5.3' : id);
    return id === 'fixture-image' && native ? { ...native, id, input: ['text', 'image'] } : native;
  });
}

test('Pi transports exact 4 MiB image bytes and preserves them through native history and reopen', { timeout: 10000 }, async (t) => {
  imageModel(t);
  await fixture(async ({ runtime, directory, requests }) => {
    const current = await runtime({ model: 'fixture-image' });
    const session = await current.open();
    assert.equal(session.imageInput.kind, 'supported');
    const base64 = qualificationImage().toString('base64');
    const images = [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${base64}` }];
    const started = session.prompt({ text: 'Describe', images }, () => {});
    images[0].dataUrl = 'mutated';
    assert.equal((await (await started).finished).outcome, 'completed');
    const user = requests[0].messages.find((m) => m.role === 'user');
    assert.deepEqual(user.content, [{ type: 'text', text: 'Describe' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }]);
    const saved = JSON.parse((await readFile(join(directory, 'sessions', session.sessionFile), 'utf8')).split('\n').find((line) => line.includes('"role":"user"')));
    assert.deepEqual(saved.message.content, [{ type: 'text', text: 'Describe' }, { type: 'image', data: base64, mimeType: 'image/png' }]);
    const file = session.sessionFile; await current.close();
    const second = await runtime({ model: 'fixture-image' });
    const resumed = await second.open({ sessionFile: file });
    assert.equal(resumed.imageInput.kind, 'supported');
    await prompt(resumed, { text: 'Follow up', images: [{ mediaType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,YQ==' }] });
    assert.deepEqual(requests[1].messages.find((m) => m.role === 'user').content, user.content);
    assert.equal(requests[1].messages.filter((m) => m.role === 'user').at(-1).content[1].image_url.url, 'data:image/jpeg;base64,YQ==');
  });
});

test('Pi refuses images for the real text-only model before provider dispatch or history append', { timeout: 10000 }, async () => {
  await fixture(async ({ runtime, directory, requests }) => {
    const current = await runtime(); const session = await current.open();
    assert.equal(session.imageInput.kind, 'unavailable');
    assert.throws(() => { session.imageInput.kind = 'supported'; }, TypeError);
    await prompt(session, 'legacy text');
    const path = join(directory, 'sessions', session.sessionFile);
    const before = await readFile(path, 'utf8');
    const image = { mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' };
    for (const images of [[image], null, {}, [{ ...image, dataUrl: 'data:image/png;base64,YR==' }],
      [{ ...image, dataUrl: `data:image/png;base64,${Buffer.alloc(4194305).toString('base64')}` }]]) {
      await assert.rejects(session.prompt({ text: 'invalid', images }, () => {}), /Pi operation failed/);
    }
    assert.equal(requests.length, 1);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal((await prompt(session, { text: 'empty', images: [] })).terminal.outcome, 'completed');
  });
});

test('disabling Pi image resize preserves text-only requests and observable settings', { timeout: 10000 }, async (t) => {
  await fixture(async ({ runtime, requests, directory }) => {
    const original = SettingsManager.inMemory;
    const settings = [];
    const observed = t.mock.method(SettingsManager, 'inMemory', function(options) {
      const manager = original.call(this, options); settings.push(manager.getImageAutoResize()); return manager;
    });
    const one = await runtime(); const first = await one.open();
    await prompt(first, 'same text'); await one.close();
    const firstHistory = JSON.parse((await readFile(join(directory, 'sessions', first.sessionFile), 'utf8')).split('\n').find((line) => line.includes('"role":"user"'))).message.content;
    observed.mock.restore();
    t.mock.method(SettingsManager, 'inMemory', function(options) {
      const { images: _images, ...legacy } = options;
      const manager = original.call(this, legacy); settings.push(manager.getImageAutoResize()); return manager;
    });
    const two = await runtime(); const second = await two.open(); await prompt(second, 'same text');
    assert.deepEqual(requests[0], requests[1]);
    const secondHistory = JSON.parse((await readFile(join(directory, 'sessions', second.sessionFile), 'utf8')).split('\n').find((line) => line.includes('"role":"user"'))).message.content;
    assert.deepEqual(firstHistory, secondHistory);
    assert.deepEqual(settings, [false, true]);
  });
});

test('Pi validates malformed and over-limit media for an image-capable model before persistence', { timeout: 10000 }, async (t) => {
  imageModel(t);
  await fixture(async ({ runtime, directory, requests }) => {
    const current = await runtime({ model: 'fixture-image' }); const session = await current.open();
    await prompt(session, 'initial');
    const path = join(directory, 'sessions', session.sessionFile); const before = await readFile(path, 'utf8');
    for (const images of [null, {}, [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YR=\n' }],
      [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(4194305).toString('base64')}` }]]) {
      await assert.rejects(session.prompt({ text: 'refuse', images }, () => {}), /Pi operation failed/);
    }
    assert.equal(requests.length, 1); assert.equal(await readFile(path, 'utf8'), before);
  });
});

test('Pi reserves a writer after caller image getters finish', { timeout: 10000 }, async (t) => {
  imageModel(t);
  await fixture(async ({ runtime }) => {
    const current = await runtime({ model: 'fixture-image' }); const session = await current.open();
    let inner;
    const outer = session.prompt({ text: 'outer', get images() { inner = session.prompt('inner', () => {}); return []; } }, () => {});
    await assert.rejects(outer, /busy/); await (await inner).finished;
  });
});
