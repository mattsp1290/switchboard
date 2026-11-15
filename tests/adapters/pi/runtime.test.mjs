import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { basename, join } from 'node:path';
import test from 'node:test';
import { terminalOutcome } from '../../../adapters/pi/src/terminal.ts';

const source = new URL('../../../adapters/pi/src/index.ts', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === source && specifier === './terminal.js') {
    return { url: new URL('../../../adapters/pi/src/terminal.ts', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createPiRuntime } = await import(source);
hook.deregister();

const key = 'fixture-key-never-log';
const frame = (content, finish_reason = null) => `data: ${JSON.stringify({
  id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3',
  choices: [{ index: 0, delta: content === null ? {} : { role: 'assistant', content }, finish_reason }],
})}\n\n`;

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-pi-'));
  const requests = [];
  const runtimes = [];
  let respond = () => new Response(frame('Hello') + frame(' world') + frame(null, 'stop') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${key}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'glm-5.3');
    assert.equal(body.tools?.length ?? 0, 0);
    requests.push(body);
    return respond(init);
  };
  const options = { cwd: directory, sessionDirectory: join(directory, 'sessions'), apiKey: key, provider: 'opencode-go', model: 'glm-5.3' };
  const runtime = async (extra = {}) => {
    const value = await createPiRuntime({ ...options, ...extra });
    runtimes.push(value);
    return value;
  };
  try { await run({ directory, options, requests, runtime, respond: value => { respond = value; } }); }
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
    await writeFile(join(directory, 'outside.jsonl'), '{"type":"session","id":"x"}\n');
    await symlink(join(directory, 'outside.jsonl'), join(directory, 'sessions', 'link.jsonl'));
    for (const sessionFile of ['missing.jsonl', 'empty.jsonl', 'bad.jsonl', '../outside.jsonl', 'link.jsonl']) {
      await assert.rejects(current.open({ sessionFile }), /Pi operation failed/);
    }
  });
});

test('native admission resolves before the streamed answer and Stop drains ownership', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, respond }) => {
    const requestStarted = Promise.withResolvers();
    respond(init => {
      let stream;
      const body = new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(frame('partial'))); } });
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
    await session.abort();
    assert.equal((await accepted.finished).outcome, 'interrupted');
    await session.close();
    const reopened = await current.open({ sessionFile: session.sessionFile });
    assert.equal(reopened.id, session.id);
  });
});

test('provider errors become failed terminals without retries or credential text', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, requests, respond }) => {
    respond(() => new Response(JSON.stringify({ error: { message: key } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const current = await runtime();
    const result = await prompt(await current.open());
    assert.equal(result.terminal.outcome, 'failed');
    assert(!JSON.stringify(result).includes(key));
    assert.equal(requests.length, 1);
  });
});

test('runtime closes sessions, enforces its limit and rejects unsupported configuration', { timeout: 10_000 }, async () => {
  await fixture(async ({ runtime, options }) => {
    await assert.rejects(createPiRuntime({ ...options, model: 'glm-5.3-flash' }), /Pi operation failed/);
    const current = await runtime();
    const sessions = await Promise.all(Array.from({ length: 32 }, () => current.open()));
    await assert.rejects(current.open(), /limit/);
    await current.close();
    await assert.rejects(current.open(), /closed/);
    await assert.rejects(sessions[0].prompt('Closed', () => {}), /closed/);
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
