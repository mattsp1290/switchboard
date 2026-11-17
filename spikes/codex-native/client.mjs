import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createWireReader, encodeEnvelope } from '../../dist/adapters/codex/wire.js';

async function until(predicate, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}
export function nativeClient(config, retainProgress, spawnNative = spawn) {
  const args = Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  const events = [];
  const transcript = [];
  const replies = new Map();
  let closed = false;
  let stopping = false;
  let failure;
  let sequence = 0;
  let bytes = 0;
  const stderrLimit = 64 * 1024;
  const stderrChunks = [];
  let stderrBytes = 0;
  const maxFrameBytes = 1048576;
  const faultMessages = {
    'malformed-frame': 'Malformed native JSON',
    'invalid-envelope': 'Invalid native envelope',
    'oversized-frame': 'Native frame byte budget exceeded',
    'input-overflow': 'Native chunk byte budget exceeded',
  };
  const fail = (error) => { failure ??= error; reader.close(); child.kill('SIGKILL'); };
  const reader = createWireReader({ maxFrameBytes, maxChunkBytes: 2097151,
    onFault: (fault) => fail(new Error(faultMessages[fault] ?? `Native wire fault: ${fault}`)),
    onEnvelope: (envelope) => {
      if (envelope.kind === 'reply') replies.set(envelope.envelope.id, envelope.envelope.raw);
      else if (envelope.kind === 'request') fail(new Error('Unexpected native request'));
      else {
        const value = envelope.notification.raw;
        events.push(value);
        retainProgress({ notification: value });
      }
    },
  });
  const child = spawnNative('/opt/codex', ['app-server', ...args], { cwd: '/tmp/project', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  child.once('close', () => { closed = true; reader.close(); });
  child.once('error', (error) => { failure ??= error; reader.close(); });
  child.stdin.on('error', fail);
  // Exact leading stderr bytes with a total count: truncation is explicit, never a silent tail.
  child.stderr.on('data', (chunk) => { if (stderrBytes < stderrLimit) stderrChunks.push(chunk.subarray(0, stderrLimit - stderrBytes)); stderrBytes += chunk.length; });
  const stderr = () => Buffer.concat(stderrChunks);
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes >= 2 * 1024 * 1024) fail(new Error('Native stdout budget exceeded'));
    else if (!failure) reader.push(chunk);
  });
  child.stdout.once('end', () => reader.end());
  child.stdout.once('error', fail);
  const encode = (value) => {
    const frame = encodeEnvelope(value, maxFrameBytes);
    if (!frame) { fail(new Error('Invalid native outgoing envelope')); throw failure; }
    return frame;
  };
  const send = (value) => child.stdin.write(encode(value));
  const ready = () => {
    if (failure) throw failure;
    if (stopping || closed || child.exitCode !== null || child.signalCode !== null) assert.fail(stderr().subarray(0, 8192).toString() || 'Native process closed');
  };
  const rpc = async (method, params) => {
    ready();
    assert(sequence < 128, 'Bounded protocol request count');
    const id = sequence + 1;
    const observation = { request: { id, method, params } };
    const frame = encode(observation.request);
    sequence = id;
    transcript.push(observation);
    retainProgress({ request: observation.request });
    child.stdin.write(frame);
    observation.reply = await until(() => { ready(); return replies.get(id); }, method);
    retainProgress({ reply: observation.reply });
    return observation.reply;
  };
  const call = async (method, params) => { const reply = await rpc(method, params); assert(!reply.error, JSON.stringify(reply)); return reply.result; };
  // Empty stderr builds no base64 string, so the creator export-cap refusal still proves no base64 precedes it.
  const drain = () => ({ closed, code: child.exitCode, signal: child.signalCode,
    stderr: { bytes: stderrBytes, truncated: stderrBytes > stderrLimit, base64: stderrBytes ? stderr().toString('base64') : '' } });
  return { events, transcript, call, rpc, drain, initialized: () => { ready(); send({ method: 'initialized' }); }, stop: async () => {
    stopping = true;
    try {
      if (!closed) child.kill('SIGTERM');
      try { await until(() => closed, 'Native shutdown and output drain'); }
      catch {
        child.kill('SIGKILL');
        await until(() => closed, 'Forced native shutdown and output drain');
      }
    } finally { reader.close(); }
    if (failure) throw failure;
  } };
}
