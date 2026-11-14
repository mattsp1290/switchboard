import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

async function until(predicate, label) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}
export function nativeClient(config, retainProgress, spawnNative = spawn) {
  const args = Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  const child = spawnNative('/opt/codex', ['app-server', ...args], { cwd: '/tmp/project', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  const events = [];
  const transcript = [];
  const replies = new Map();
  let closed = false;
  let stopping = false;
  let failure;
  let sequence = 0;
  let bytes = 0;
  let stderr = '';
  const fail = (error) => { failure ??= error; child.kill('SIGKILL'); };
  child.once('close', () => { closed = true; });
  child.once('error', (error) => { failure ??= error; });
  child.stdin.on('error', fail);
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes >= 2 * 1024 * 1024) fail(new Error('Native stdout budget exceeded'));
  });
  const lines = createInterface({ input: child.stdout });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  lines.on('line', (line) => {
    if (failure) return;
    let value;
    try { value = JSON.parse(line); }
    catch { fail(new Error('Malformed native JSON')); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(new Error('Invalid native envelope')); return; }
    if (Object.hasOwn(value, 'id') && !value.method) replies.set(value.id, value);
    else {
      if (Object.hasOwn(value, 'id')) { fail(new Error('Unexpected native request')); return; }
      events.push(value);
      retainProgress({ notification: value });
    }
  });
  const ready = () => {
    if (failure) throw failure;
    assert(!stopping && !closed && child.exitCode === null && child.signalCode === null, stderr || 'Native process closed');
  };
  const rpc = async (method, params) => {
    ready();
    assert(sequence < 128, 'Bounded protocol request count');
    const id = ++sequence;
    const observation = { request: { id, method, params } };
    transcript.push(observation);
    retainProgress({ request: observation.request });
    send(observation.request);
    observation.reply = await until(() => { ready(); return replies.get(id); }, method);
    retainProgress({ reply: observation.reply });
    return observation.reply;
  };
  const call = async (method, params) => { const reply = await rpc(method, params); assert(!reply.error, JSON.stringify(reply)); return reply.result; };
  return { events, transcript, call, rpc, initialized: () => { ready(); send({ method: 'initialized' }); }, stop: async () => {
    stopping = true;
    try {
      if (!closed) child.kill('SIGTERM');
      try { await until(() => closed, 'Native shutdown and output drain'); }
      catch {
        child.kill('SIGKILL');
        await until(() => closed, 'Forced native shutdown and output drain');
      }
    } finally { lines.close(); }
    if (failure) throw failure;
  } };
}
