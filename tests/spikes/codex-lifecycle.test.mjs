import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:child_process' && /codex-native\/(client|qualify)\.mjs/.test(context.parentURL)) {
    return { url: new URL('./codex-lifecycle-transport.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === 'node:fs' && context.parentURL.includes('/codex-native/qualify.mjs')) {
    return { url: new URL('./codex-lifecycle-fs.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (['node:fs', 'node:http'].includes(specifier) && context.parentURL.includes('/codex-native/discovery.mjs')) {
    return { url: new URL('./codex-discovery-boundary.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { nativeClient } = await import('../../spikes/codex-native/client.mjs');
const { ownedContainer } = await import('../../spikes/codex-native/lifecycle.mjs');
test('helper imports perform no native or daemon operation', () => {
  assert.equal(globalThis.codexQualification, undefined);
});
function transport(answer = (request) => ({ id: request.id, result: {} })) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, sent: [], signals: [] });
  child.stdin = new Writable({ write(chunk, _, done) {
    const request = JSON.parse(chunk);
    child.sent.push(request);
    const reply = request.id && answer(request);
    if (reply) child.stdout.write(`${JSON.stringify(reply)}\n`);
    done();
  } });
  child.kill = (signal) => {
    child.signals.push(signal);
    child.signalCode = signal;
    setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close'); });
    return true;
  };
  return child;
}
test('client preserves initialization, replies, events, transcript and refusal before dispatch', async () => {
  const child = transport();
  const progress = [];
  const client = nativeClient({}, (entry) => progress.push(entry), () => child);
  await client.call('initialize', {});
  client.initialized();
  child.stdout.write('{"method":"notice","params":{}}\n');
  for (let count = 1; count < 128; count++) await client.rpc('thread/read', {});
  await assert.rejects(client.rpc('thread/read', {}), /request count/);
  assert.equal(child.sent.length, 129);
  assert.equal(client.transcript.length, 128);
  assert(client.transcript.every((entry) => entry.reply.id === entry.request.id));
  assert.equal(progress.filter((entry) => entry.reply).length, 128);
  assert.equal(child.sent[1].method, 'initialized');
  assert.equal(client.events[0].method, 'notice');
  await client.stop();
  await assert.rejects(client.rpc('thread/read', {}));
  assert.equal(child.sent.length, 129);
});
test('client rejects malformed, null, array, unexpected-request and oversized output before dispatch', async () => {
  for (const output of ['{bad', 'null', '[]', '{"id":1,"method":"unexpected"}', 'x'.repeat(2 * 1024 * 1024)]) {
    const child = transport();
    const client = nativeClient({}, () => {}, () => child);
    child.stdout.write(`${output}\n`);
    await assert.rejects(client.rpc('thread/read', {}), /JSON|envelope|Unexpected|budget/);
    assert.equal(child.sent.length, 0);
    assert(child.signals.includes('SIGKILL'));
    await assert.rejects(client.stop(), /JSON|envelope|Unexpected|budget/);
  }
});
test('client captures asynchronous spawn and stdin errors during pending calls', async () => {
  for (const emitter of ['child', 'stdin']) {
    const child = transport(() => undefined);
    const client = nativeClient({}, () => {}, () => child);
    const request = client.rpc('thread/read', {});
    queueMicrotask(() => (emitter === 'child' ? child : child.stdin).emit('error', new Error(`synthetic ${emitter} failure`)));
    await assert.rejects(request, /synthetic/);
    await assert.rejects(client.rpc('thread/read', {}), /synthetic/);
    assert.equal(child.sent.length, 1);
    await assert.rejects(client.stop(), /synthetic/);
  }
});
test('client waits for graceful stdio drain and repeated stop is harmless', async () => {
  const child = transport();
  const kill = child.kill;
  child.kill = (signal) => { child.stdout.write('{"method":"last-notice"}\n'); return kill(signal); };
  const client = nativeClient({}, () => {}, () => child);
  let closed = false;
  child.once('close', () => { closed = true; });
  await client.stop();
  assert(closed);
  assert.equal(client.events.at(-1).method, 'last-notice');
  await client.stop();
  assert.deepEqual(child.signals, ['SIGTERM']);
});
test('client rejects final-drain faults after close and keeps failed repeated stop observable', async () => {
  const faults = [
    ['malformed', (child) => child.stdout.write('{bad\n')],
    ['null', (child) => child.stdout.write('null\n')],
    ['array', (child) => child.stdout.write('[]\n')],
    ['request', (child) => child.stdout.write('{"id":100,"method":"unexpected"}\n')],
    ['overflow', (child) => child.stdout.write('x'.repeat(2 * 1024 * 1024))],
    ['spawn', (child) => child.emit('error', new Error('synthetic final spawn failure'))],
    ['stdin', (child) => child.stdin.emit('error', new Error('synthetic final stdin failure'))],
  ];
  for (const [name, inject] of faults) {
    const child = transport();
    const kill = child.kill;
    child.kill = (signal) => {
      const sent = kill(signal);
      if (signal === 'SIGTERM') queueMicrotask(() => inject(child));
      return sent;
    };
    const client = nativeClient({}, () => {}, () => child);
    await client.call('thread/list', {});
    let closed = false;
    child.once('close', () => { closed = true; });
    let failure;
    await assert.rejects(client.stop(), (error) => {
      assert(closed, name);
      assert.match(error.message, /JSON|envelope|Unexpected|budget|synthetic final/);
      failure = error;
      return true;
    });
    await assert.rejects(client.stop(), (error) => error === failure);
    await assert.rejects(client.rpc('thread/list', {}), (error) => error === failure);
    assert.equal(child.sent.length, 1, name);
    assert.deepEqual(child.signals, name === 'spawn' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
  }
});
test('actual discovery retains a final-drain failure and exits nonzero through inert boundaries', async () => {
  const argv = process.argv;
  const log = console.log;
  const stderrWrite = process.stderr.write;
  const exitCode = process.exitCode;
  try {
    for (const fault of [false, true]) {
      const child = transport((request) => request.method === 'thread/list'
        ? { id: request.id, error: { code: -32603, message: 'Not a directory' } }
        : { id: request.id, result: request.method === 'config/read' ? { config: { sqlite_home: '/tmp/private-index' } } : {} });
      const kill = child.kill;
      child.kill = (signal) => {
        const sent = kill(signal);
        if (fault && signal === 'SIGTERM') child.stdout.write('{bad\n');
        return sent;
      };
      globalThis.codexDiscovery = child;
      const reports = [];
      const progress = [];
      process.argv = [process.execPath, 'discovery.mjs', 'inaccessible'];
      process.exitCode = undefined;
      console.log = (value) => reports.push(JSON.parse(value));
      process.stderr.write = (value) => { progress.push(JSON.parse(value)); return true; };
      await import(`../../spikes/codex-native/discovery.mjs?shutdown=${fault}`);
      assert.equal(reports.length, 1);
      const report = reports[0];
      assert.equal(process.exitCode ?? 0, fault ? 1 : 0);
      assert.equal(report.inferenceRequests, 0);
      assert.equal(report.transcript.at(-1).reply.error.code, -32603);
      assert.deepEqual(report.transcript.map((entry) => entry.request.method), ['initialize', 'config/read', 'thread/list']);
      assert.deepEqual(report.preservation, ['before startup', 'after initialization', 'after requests',
        fault ? 'after failed drained shutdown' : 'after drained shutdown']);
      assert(progress.some((entry) => entry.sourcePreservation === report.preservation.at(-1)));
      if (fault) {
        assert.match(report.failure.message, /Malformed native JSON/);
        assert.match(report.shutdownFailure, /Malformed native JSON/);
        assert.equal(report.preservationSummary, undefined);
        assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
      } else {
        assert.equal(report.failure.code, -32603);
        assert.equal(report.shutdownFailure, undefined);
        assert.match(report.preservationSummary, /unchanged/);
        assert.deepEqual(child.signals, ['SIGTERM']);
      }
      log(JSON.stringify({ inertDiscovery: fault ? 'final-drain-failure' : 'graceful-control', exitCode: process.exitCode ?? 0, report }));
    }
  } finally {
    process.argv = argv;
    console.log = log;
    process.stderr.write = stderrWrite;
    process.exitCode = exitCode;
    delete globalThis.codexDiscovery;
  }
});
test('client bounds ignored TERM, escalates to KILL, and rejects failed close', async () => {
  for (const closes of [true, false]) {
    const child = transport();
    const kill = child.kill;
    child.kill = (signal) => {
      if (closes && signal === 'SIGKILL') return kill(signal);
      child.signals.push(signal);
      return true;
    };
    const client = nativeClient({}, () => {}, () => child);
    if (closes) await client.stop();
    else await assert.rejects(client.stop(), /Forced native shutdown and output drain/);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    if (!closes) { child.stdout.end(); child.stderr.end(); child.emit('close'); }
  }
});
test('owner separates operation acknowledgement from exact inventory and never retries uncertain creation', () => {
  for (const fault of ['none', 'auto-removed', 'lost-run-reply', 'unknown-empty', 'late', 'daemon', 'inventory-failure', 'present']) {
    const calls = [];
    const failure = Object.assign(new Error('unacknowledged operation'), { stdout: 'partial stdout', stderr: 'partial stderr' });
    const run = (_, args, options) => {
      calls.push(args[0]);
      if (args[0] !== 'run') assert.equal(options.timeout, 5000);
      if (args[0] === 'run' && ['lost-run-reply', 'unknown-empty', 'late', 'daemon'].includes(fault)) throw failure;
      if (args[0] === 'rm' && ['auto-removed', 'unknown-empty', 'late', 'daemon'].includes(fault)) throw failure;
      if (args[0] === 'ps' && ['daemon', 'inventory-failure'].includes(fault)) throw failure;
      return args[0] === 'ps' ? (['late', 'present'].includes(fault) ? 'owned\n' : 'owned-neighbor\n') : 'result';
    };
    if (['none', 'auto-removed'].includes(fault)) assert.equal(ownedContainer(run, ['run'], 'owned'), 'result');
    else assert.throws(() => ownedContainer(run, ['run'], 'owned'), (error) => {
      assert.equal(error.cleanupUncertain, fault !== 'lost-run-reply');
      if (['lost-run-reply', 'unknown-empty', 'late', 'daemon'].includes(fault)) {
        assert.equal(error.stdout, failure.stdout);
        assert.equal(error.stderr, failure.stderr);
      } else assert.equal(error.stdout, 'result');
      return true;
    });
    assert.deepEqual(calls, ['run', 'rm', 'ps']);
  }
});
test('owner keeps never-observed uncertainty when creation appears after empty inventory', () => {
  const calls = [];
  let appeared = false;
  const run = (_, args) => {
    calls.push(args[0]);
    if (args[0] === 'ps') return appeared ? 'owned\n' : '';
    throw new Error('unacknowledged operation');
  };
  assert.throws(() => ownedContainer(run, ['run'], 'owned'), (error) => error.cleanupUncertain);
  appeared = true;
  assert.equal(run('docker', ['ps']), 'owned\n');
  assert.deepEqual(calls, ['run', 'rm', 'ps', 'ps']);
});
test('actual qualifier retains frozen source on uncertainty and removes it only after confirmed absence', async () => {
  const argv = process.argv;
  const log = console.log;
  const errorLog = console.error;
  try {
    for (const fault of ['unknown-empty', 'late', 'daemon', 'removed', 'success']) {
      const work = realpathSync(mkdtempSync(join(tmpdir(), 'codex-lifecycle-')));
      const archive = join(work, 'inert.tgz');
      writeFileSync(archive, 'inert archive');
      const calls = [];
      const errors = [];
      const output = [];
      let failed = false;
      let name;
      globalThis.codexQualification = { work, run(command, args) {
        calls.push([command, ...args]);
        if (command !== 'docker') { assert(command === 'tar' || command === process.execPath); return ''; }
        if (args[0] === 'rm') {
          if (failed && fault !== 'removed') throw new Error('unacknowledged removal');
          return '';
        }
        if (args[0] === 'ps') {
          if (failed && fault === 'daemon') throw new Error('daemon unavailable');
          return failed && fault === 'late' ? `${name}\n` : '';
        }
        assert.equal(args[0], 'run');
        name = args[args.indexOf('--name') + 1];
        if (args.includes('--version')) return 'codex-cli 0.169.0';
        if (args.some((arg) => arg.includes('/bindings.mjs,'))) return JSON.stringify({ 'a.ts': 'import { b } from "./b";', 'b.ts': 'export const b = 1;' });
        if (args.some((arg) => arg.includes('/probe.mjs,'))) return JSON.stringify({ node: process.versions.node, architecture: 'arm64' });
        if (args.at(-1) === 'prepare') return JSON.stringify({ records: ['first', 'second', 'unauthorized'].map((name) => ({ name, path: `sessions/${name}.jsonl` })),
          files: Object.fromEntries(['first', 'second', 'unauthorized'].map((name) => [`sessions/${name}.jsonl`, Buffer.from('synthetic opaque bytes').toString('base64')])) });
        if (fault === 'success') return JSON.stringify({ mode: args.at(-1) });
        assert.equal(args.at(-1), 'indexed');
        assert(args.some((arg) => arg.includes('/client.mjs,')));
        assert.equal(readFileSync(join(work, 'indexed/sessions/first.jsonl'), 'utf8'), 'synthetic opaque bytes');
        failed = true;
        throw Object.assign(new Error('unacknowledged creation'), { stdout: 'bounded partial output', stderr: 'bounded partial progress' });
      } };
      process.argv = [process.execPath, 'qualify.mjs', archive, 'arm64'];
      console.log = (value) => { assert(!existsSync(work), 'Success output follows work cleanup'); output.push(value); };
      console.error = (value) => errors.push(JSON.parse(value));
      try {
        if (fault === 'success') {
          await import(`../../spikes/codex-native/qualify.mjs?${fault}`);
          assert(!existsSync(work));
          assert.deepEqual(JSON.parse(output[0]).discovery.map((entry) => entry.mode), ['indexed', 'unindexed', 'malformed', 'inaccessible', 'symlink']);
          continue;
        }
        await assert.rejects(import(`../../spikes/codex-native/qualify.mjs?${fault}`), (error) => {
          assert.equal(error.cleanupUncertain, fault !== 'removed');
          return true;
        });
        assert.equal(output.length, 0);
        assert.equal(calls.filter((call) => call.at(-1) === 'indexed').length, 1);
        assert.equal(errors[0].stdout, 'bounded partial output');
        if (fault === 'removed') assert(!existsSync(work));
        else {
          assert.deepEqual(errors.at(-1), { cleanupUncertain: true, container: name, retainedWork: work });
          assert.equal(readFileSync(join(work, 'indexed/sessions/first.jsonl'), 'utf8'), 'synthetic opaque bytes');
        }
        log(JSON.stringify({ inertQualifier: fault, ...errors.at(-1), retainedSourceVerified: fault !== 'removed', retried: false }));
      } finally { rmSync(work, { recursive: true, force: true }); }
    }
  } finally { process.argv = argv; console.log = log; console.error = errorLog; delete globalThis.codexQualification; hook.deregister(); }
});
