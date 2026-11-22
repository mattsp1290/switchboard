import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
const source = new URL('../../../src/adapters/codex/turn-monitor.ts', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === source && specifier === './execution.js') return { url: new URL('../../../src/adapters/codex/execution.ts', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { monitorCodexTurn } = await import(source);
hook.deregister();
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('public and segment waits detach without adding native promise reactions', async () => {
  const completion = Promise.withResolvers(); let registrations = 0;
  const original = completion.promise.then.bind(completion.promise);
  completion.promise.then = (...args) => { registrations++; return original(...args); };
  const monitor = monitorCodexTurn(completion.promise);
  for (let i = 0; i < 1000; i++) {
    monitor.segment(() => {})();
    const remove = monitor.interruptWaiter(() => {}); assert(remove); remove();
  }
  assert.equal(registrations, 1);
  const held = Array.from({ length: 63 }, () => monitor.interruptWaiter(() => {}));
  assert(held.every(Boolean)); assert.equal(monitor.interruptWaiter(() => {}), undefined);
  let segment = 0; const detachSegment = monitor.segment(() => { segment++; });
  held.forEach((remove) => remove());
  const terminal = { kind: 'terminal', terminal: { turnId: 'turn', status: 'completed', error: null, turn: {} } };
  completion.resolve(terminal); await tick(); assert.equal(segment, 1); assert.equal(monitor.result(), terminal); detachSegment();
});
test('written interrupts are observed once while unwritten attempts permit a later explicit call', async () => {
  const completion = Promise.withResolvers(); const monitor = monitorCodexTurn(completion.promise);
  let calls = 0; const native = Promise.withResolvers(); const start = () => { calls++; return native.promise; };
  const first = monitor.interrupt(start);
  for (let i = 0; i < 1000; i++) assert.equal(monitor.interrupt(start), first);
  await tick(); assert.equal(calls, 1);
  native.resolve({ step: 'not-sent', turnId: 'turn', rejection: null }); await tick();
  const accepted = monitor.interrupt(async () => { calls++; return { step: 'replied', turnId: 'turn', rejection: null }; });
  await tick(); assert.equal(calls, 2); assert.equal(accepted.result().step, 'replied');
  for (let i = 0; i < 1000; i++) assert.equal(monitor.interrupt(start), accepted);
  assert.equal(calls, 2); completion.resolve({ kind: 'not-dispatched' });
});
