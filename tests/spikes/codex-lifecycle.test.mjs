import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { clientWireSource } from './codex-wire-source.mjs';
import { fileURLToPath } from 'node:url';

const hook = registerHooks({ resolve(specifier, context, next) {
  const wire = clientWireSource(specifier, context);
  if (wire) return wire;
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
  child.stdout.once('end', () => { child.stderr.end(); setImmediate(() => child.emit('close')); });
  child.kill = (signal) => {
    child.signals.push(signal);
    child.signalCode = signal;
    setImmediate(() => { if (!child.stdout.writableEnded) child.stdout.end(); });
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
test('client captures asynchronous spawn, stdin and stdout errors during pending calls', async () => {
  for (const emitter of ['child', 'stdin', 'stdout']) {
    const child = transport(() => undefined);
    const client = nativeClient({}, () => {}, () => child);
    const request = client.rpc('thread/read', {});
    const failure = new Error(`synthetic ${emitter} failure`);
    queueMicrotask(() => (emitter === 'child' ? child : child[emitter]).emit('error', failure));
    await assert.rejects(request, (error) => error === failure);
    await assert.rejects(client.rpc('thread/read', {}), (error) => error === failure);
    assert.equal(child.sent.length, 1);
    if (emitter !== 'child') assert(child.signals.includes('SIGKILL'));
    await assert.rejects(client.stop(), (error) => error === failure);
    await assert.rejects(client.stop(), (error) => error === failure);
  }
});
test('actual client wire faults reach exact terminal assertions after stdout and codec entry', async () => {
  for (const scenario of ['malformed', 'ambiguous', 'oversize', 'utf8', 'truncated']) {
    const child = transport();
    let delivered = 0;
    child.stdout.on('data', (bytes) => { delivered += bytes.length; });
    const progress = [];
    const client = nativeClient({}, (entry) => progress.push(entry), () => child);
    child.stdout.write('{"method":"codec-entered"}\n');
    assert.equal(progress[0].notification.method, 'codec-entered', 'actual-wire-codec-entered');
    const enteredBytes = delivered;
    if (scenario === 'oversize') {
      for (let remaining = 1048577; remaining > 0; remaining -= 32768) {
        child.stdout.write(Buffer.alloc(Math.min(32768, remaining), 120));
      }
    } else if (scenario === 'truncated') {
      child.stdout.end('{"method":"unfinished"}');
      await new Promise((resolve) => setImmediate(resolve));
    } else child.stdout.write(scenario === 'utf8' ? Buffer.from([0xff, 10])
      : scenario === 'ambiguous' ? '{"id":1,"result":null,"error":{"code":1,"message":"x"}}\n' : '{bad\n');
    assert(delivered > enteredBytes && delivered < 2097152, 'actual-wire-stdout-delivered-below-total-budget');
    if (scenario === 'oversize') assert.equal(delivered - enteredBytes, 1048577, 'actual-wire-oversize-delivered');
    const expected = scenario === 'oversize' ? 'Native frame byte budget exceeded'
      : scenario === 'ambiguous' ? 'Invalid native envelope' : 'Malformed native JSON';
    const oracle = scenario === 'oversize' ? 'actual-wire-frame-budget-terminal' : `actual-wire-${scenario}-terminal`;
    let failure;
    assert.throws(() => client.initialized(), (error) => {
      assert.equal(error.message, expected, oracle);
      failure = error;
      return true;
    }, oracle);
    assert.equal(child.sent.length, 0);
    await assert.rejects(client.stop(), (error) => error === failure);
    await assert.rejects(client.stop(), (error) => error === failure);
    assert(child.signals.includes('SIGKILL'));
  }
});
test('actual client refuses outgoing invalid envelopes without writing and retains the owned failure', async () => {
  for (const [method, params] of [['', {}], ['x', { toJSON: () => 1n }], ['x', 'x'.repeat(1048576)]]) {
    const child = transport();
    const progress = [];
    const client = nativeClient({}, (entry) => progress.push(entry), () => child);
    let failure;
    await assert.rejects(client.rpc(method, params), (error) => {
      assert.equal(error.message, 'Invalid native outgoing envelope');
      failure = error;
      return true;
    });
    assert.equal(child.sent.length, 0);
    assert.equal(client.transcript.length, 0);
    assert.deepEqual(progress, []);
    assert(child.signals.includes('SIGKILL'));
    await assert.rejects(client.stop(), (error) => error === failure);
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
test('client retains exact leading stderr bytes with an explicit total and truncation after drain', async () => {
  for (const [chunks, truncated] of [[[Buffer.from([0xe2, 0x82]), Buffer.from([0xac, 0x0a])], false], [[Buffer.alloc(40 * 1024, 1), Buffer.alloc(40 * 1024, 2)], true]]) {
    const child = transport();
    const client = nativeClient({}, () => {}, () => child);
    for (const chunk of chunks) child.stderr.write(chunk);
    await client.stop();
    const { closed, signal, stderr } = client.drain();
    const all = Buffer.concat(chunks);
    assert.deepEqual([closed, signal, stderr.bytes, stderr.truncated], [true, 'SIGTERM', all.length, truncated]);
    assert(Buffer.from(stderr.base64, 'base64').equals(all.subarray(0, 64 * 1024)), 'Exact leading bytes, split UTF-8 intact');
  }
});
test('client rejects final-drain faults after close and keeps failed repeated stop observable', async () => {
  const faults = [
    ['malformed', (child) => child.stdout.write('{bad\n')],
    ['truncated', (child) => child.stdout.write('{"method":"unfinished"}')],
    ['stdout', (child) => child.stdout.emit('error', new Error('synthetic final stdout failure'))],
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
    let closes = 0;
    child.on('close', () => { closes++; });
    let failure;
    await assert.rejects(client.stop(), (error) => {
      assert.equal(closes, 1, name);
      if (name === 'truncated') assert.equal(error.message, 'Malformed native JSON');
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
        ...(!fault ? ['after drained shutdown'] : []), 'after final shutdown attempts']);
      assert(progress.some((entry) => entry.sourcePreservation === report.preservation.at(-1)));
      if (fault) {
        assert.match(report.failure.message, /Malformed native JSON/);
        assert(report.shutdownFailures.every((failure) => /Malformed native JSON/.test(failure)));
        assert.equal(report.preservationSummary, undefined);
        assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
      } else {
        assert.equal(report.failure.code, -32603);
        assert.equal(report.shutdownFailures, undefined);
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
    if (!closes) child.stdout.end();
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
    for (const fault of ['unknown-empty', 'late', 'daemon', 'removed', 'success', 'legacy-creator', 'legacy-pin', 'leaf-mismatch', 'leaf-missing', 'compile-failure', 'source-drift', 'compiled-missing']) {
      const work = realpathSync(mkdtempSync(join(tmpdir(), 'codex-lifecycle-')));
      const archive = join(work, 'inert.tgz');
      writeFileSync(archive, 'inert archive');
      const calls = [];
      const legacyCalls = [];
      const errors = [];
      const output = [];
      let failed = false;
      let name;
      const wireSource = 'inert wire source\n';
      const compiledWire = 'inert compiled wire\n';
      const codec = join(work, 'codec/adapters/codex/wire.js');
      const legacyResult = fault === 'legacy-pin' ? JSON.parse(readFileSync(new URL('../../spikes/codex-native/legacy-tail-result.json', import.meta.url), 'utf8')) : { outcome: null };
      globalThis.codexQualification = { work, wireSource, legacyResult, run(command, args) {
        calls.push([command, ...args]);
        if (command !== 'docker') {
          assert(command === 'tar' || command === process.execPath);
          if (args.includes('--outDir')) {
            assert.equal(calls.filter((call) => call.includes('--outDir')).length, 1, 'Compile owned codec once');
            assert(calls.some((call) => call.some((arg) => arg.includes('/probe.mjs,'))), 'Compile after probe');
            assert.equal(calls.filter((call) => call[0] === process.execPath).length, 2, 'Strict consumer precedes codec');
            assert.deepEqual(args, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)),
              '-p', fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), '--outDir', join(work, 'codec')]);
            if (fault === 'compile-failure') throw new Error('inert codec compiler failure');
            if (fault === 'source-drift') globalThis.codexQualification.wireSource += 'changed';
            if (fault !== 'compiled-missing') { mkdirSync(dirname(codec), { recursive: true }); writeFileSync(codec, compiledWire); }
          }
          return '';
        }
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
        if (!args.some((arg) => arg.includes('/discovery.mjs,'))) {
          assert(!args.some((arg) => arg.includes('target=/dist/')), 'Only discovery receives codec mounts');
        }
        if (args.includes('--version')) return 'codex-cli 0.169.0';
        if (args.some((arg) => arg.includes('/bindings.mjs,'))) {
          const leaf = readFileSync(new URL('../../src/adapters/codex/protocol/RequestId.ts', import.meta.url), 'utf8');
          return JSON.stringify({
            'a.ts': fault.startsWith('leaf-') ? 'import unexpected syntax;' : 'import type { RequestId } from "./RequestId";',
            ...(fault === 'leaf-missing' ? {} : { 'RequestId.ts': fault === 'leaf-mismatch' ? `// different generator header\n${leaf}` : leaf }),
          });
        }
        if (args.some((arg) => arg.includes('/probe.mjs,'))) return JSON.stringify({ node: process.versions.node, architecture: 'arm64' });
        assert.equal(new URL('../../dist/adapters/codex/wire.js', 'file:///opt/client.mjs').pathname, '/dist/adapters/codex/wire.js');
        assert.equal(readFileSync(codec, 'utf8'), compiledWire, 'Mounted bytes come from owned compilation');
        for (const [source, target] of [[codec, '/dist/adapters/codex/wire.js'],
          [fileURLToPath(new URL('../../package.json', import.meta.url)), '/dist/package.json']]) {
          const mount = `type=bind,source=${source},target=${target},readonly`;
          assert(args.some((arg, index) => arg === '--mount' && args[index + 1] === mount), 'Exact compiled wire and ESM scope mounts');
        }
        if (args.at(-1) === 'prepare') return JSON.stringify({ records: ['first', 'second', 'unauthorized'].map((name) => ({ name, path: `sessions/${name}.jsonl` })),
          files: Object.fromEntries(['first', 'second', 'unauthorized'].map((name) => [`sessions/${name}.jsonl`, Buffer.from('synthetic opaque bytes').toString('base64')])) });
        if (args.at(-1) === 'prepare-accounts') return JSON.stringify({ records: ['accountA', 'accountB', 'apiKey', 'corrupt'].map((name) => ({ name, path: `sessions/${name}.jsonl` })),
          files: { 'thread_history_1.sqlite': Buffer.from('opaque cold history').toString('base64'),
            ...Object.fromEntries(['accountA', 'accountB', 'apiKey', 'corrupt'].map((name) => [`sessions/${name}.jsonl`, Buffer.from('synthetic opaque bytes').toString('base64')])) } });
        if (args.at(-1) === 'prepare-legacy' && fault === 'legacy-creator') {
          throw Object.assign(new Error('inert creator exit'), { stdout: JSON.stringify({ mode: 'prepare-legacy', failure: { message: 'Creator read-back keeps Legacy history' } }) });
        }
        if (args.at(-1) === 'prepare-legacy') return JSON.stringify({ record: { name: 'legacy', id: 'legacy-id', path: 'sessions/2026/rollout-legacy.jsonl' },
          rollout: Buffer.from('{"opaque":"native"}\n').toString('base64'), rolloutModifiedMs: 1794882250043, creator: {}, drain: [] });
        if (args.at(-2) === 'legacy-read') {
          const control = args.at(-1);
          assert(!args.some((arg) => /\.sqlite|thread_history/.test(arg)), 'Legacy readers receive no SQLite or projection');
          const expected = { healthy: '{"opaque":"native"}\n', tail: '{"opaque":"native"}\n{invalid-json\n', whole: '{invalid-json\n',
            'absent-id': '{"opaque":"native"}\n' }[control];
          const file = join(work, `legacy-${control}/sessions/2026/rollout-legacy.jsonl`);
          assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : undefined, expected, `Frozen ${control} source bytes`);
          if (expected) assert.equal(Math.round(statSync(file).mtimeMs), 1794882250043, `${control} home shares the native rollout mtime`);
          legacyCalls.push(control);
          if (fault === 'success' && control === 'tail') throw Object.assign(new Error('inert reader exit'), { stdout: JSON.stringify({ mode: 'legacy-read', failure: { message: 'inert' } }) });
        }
        if (['success', 'legacy-creator', 'legacy-pin'].includes(fault)) return JSON.stringify({ mode: args.at(-1) });
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
        if (fault.startsWith('leaf-')) {
          await assert.rejects(import(`../../spikes/codex-native/qualify.mjs?${fault}`), (error) =>
            fault === 'leaf-mismatch' ? /Selected RequestId byte mismatch/.test(error.message)
              && error.message.includes('different generator header') : /Selected binding sources must be strings/.test(error.message));
          assert(!calls.some((call) => call[0] === process.execPath), 'No compilation after leaf refusal');
          assert(!calls.some((call) => call.some((arg) => /\/(probe|discovery)\.mjs,/.test(arg))), 'No probe or discovery after leaf refusal');
          assert(!existsSync(work), 'Owned work removed after leaf refusal');
          assert.equal(output.length, 0);
          assert.equal(errors.length, 0);
          continue;
        }
        if (['compile-failure', 'source-drift', 'compiled-missing'].includes(fault)) {
          await assert.rejects(import(`../../spikes/codex-native/qualify.mjs?${fault}`),
            fault === 'compile-failure' ? /inert codec compiler failure/ : fault === 'source-drift' ? /Wire source unchanged/ : /ENOENT/);
          assert.equal(calls.filter((call) => call.includes('--outDir')).length, 1);
          assert(!calls.some((call) => call.some((arg) => arg.includes('/discovery.mjs,'))), 'No discovery after codec refusal');
          assert(!existsSync(work), 'Owned work removed after codec refusal');
          assert.equal(output.length, 0);
          assert.equal(errors.length, 0);
          continue;
        }
        if (fault === 'legacy-pin') {
          await assert.rejects(import(`../../spikes/codex-native/qualify.mjs?${fault}`), (error) => error.code === 'ERR_ASSERTION'
            && /successful-reads-uncertified/.test(error.message) && /inconclusive/.test(error.message), 'A native result that differs from the pin fails');
          assert.deepEqual(legacyCalls, ['healthy', 'tail', 'whole', 'absent-id', 'absent-path']);
          assert(!existsSync(work), 'Owned work removed after a pin mismatch');
          assert.equal(output.length, 0);
          continue;
        }
        if (['success', 'legacy-creator'].includes(fault)) {
          await import(`../../spikes/codex-native/qualify.mjs?${fault}`);
          assert(!existsSync(work));
          const report = JSON.parse(output[0]);
          const hash = (value) => createHash('sha256').update(value).digest('hex');
          assert.deepEqual(report.wireCodec, { sourceSha256Before: hash(wireSource), sourceSha256After: hash(wireSource), compiledSha256: hash(compiledWire) });
          assert.deepEqual(report.discovery.map((entry) => entry.mode), ['indexed', 'unindexed', 'malformed', 'inaccessible', 'symlink']);
          assert.equal(report.legacyTail.conclusion.outcome, 'inconclusive', 'Fake readers never promote a Legacy outcome');
          if (fault === 'legacy-creator') {
            assert.deepEqual(legacyCalls, [], 'No reader home without genuine Legacy history');
            assert.deepEqual(report.legacyTail.conclusion.precondition, { stage: 'creator', acquisition: 'partial', failure: 'Creator read-back keeps Legacy history' });
          } else {
            assert.deepEqual(legacyCalls, ['healthy', 'tail', 'whole', 'absent-id', 'absent-path']);
            assert.equal(report.legacyTail.readers.tail.acquisition, 'partial', 'A cleanly removed failed reader keeps its partial report');
            assert.equal(errors.at(-1).stdout, JSON.stringify({ mode: 'legacy-read', failure: { message: 'inert' } }));
          }
          assert.equal(report.transformedImports, 1);
          assert.equal(report.bindingIdentity.generatedSha256, 'beeb38dfd0b050b171141bd66d51663786a50a81cbe904ba9b006289a101fd39');
          assert.equal(report.bindingIdentity.selectedSha256, report.bindingIdentity.generatedSha256);
          assert.match(report.bindingIdentity.sourceSha256, /^[0-9a-f]{64}$/);
          assert.match(report.bindingIdentity.consumedSha256, /^[0-9a-f]{64}$/);
          assert.notEqual(report.bindingIdentity.sourceSha256, report.bindingIdentity.consumedSha256);
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
