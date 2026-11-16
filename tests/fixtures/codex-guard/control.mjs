// Inert, mode-switched entry for the guarded command's controls. No mode performs a real effect when
// protection is missing: refusers are called only after their guard marker is confirmed, and bare probes only resolve.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const MARK = Symbol.for('switchboard.codex-guard.refuser');
const [mode, ...bare] = process.argv.slice(2);
const noop = () => {};
const forever = () => new Promise(() => setInterval(noop, 1000));
const pair = (b = noop) => { test('a', noop); test('b', b); };
const refused = (attempt) => assert.rejects(async () => attempt(), { message: /^codex (guard|tripwire) refused / });
const ignore = (attempt) => { try { attempt(); } catch { /* the guard records the refusal */ } };

/** @param {string} name @param {string} key */
function guarded(name, key) {
  const value = process.getBuiltinModule(name)[key];
  assert.equal(value[MARK], true, `${name}.${key} must be the guard's refuser before it is called`);
  return value;
}

async function excluded() {
  const url = new URL('./excluded.mjs', import.meta.url).href;
  await refused(() => import(url));
  await refused(() => require('./excluded.mjs'));
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'switchboard-excluded-file') return { url, shortCircuit: true };
    if (specifier === 'switchboard-excluded-builtin') return { url: 'node:child_process', shortCircuit: true };
    return next(specifier, context);
  } });
  try {
    await refused(() => import('switchboard-excluded-file'));
    await refused(() => import('switchboard-excluded-builtin'));
  } finally {
    hook.deregister();
  }
  await refused(() => registerHooks({ load: (target, context, next) => next(target, context) }));
  assert.equal(globalThis.switchboardCodexGuardExcluded, undefined);
}

const MODES = {
  pass: () => pair(),
  substitute: () => { test('a', noop); test('c', noop); },
  duplicate: () => { test('a', noop); pair(); },
  fail: () => pair(() => assert.fail('control failure')),
  'skip-todo': () => { test('a', { skip: true }, noop); test('b', { todo: true }, noop); },
  nested: () => pair(async (t) => { await t.test('inner', noop); }),
  'early-exit': () => pair(() => process.exit(0)),
  'exit-code': () => { pair(); after(() => { process.exitCode = 1; }); },
  'after-throw': () => { pair(); after(() => { throw new Error('control after hook'); }); },
  crash: () => pair(() => process.kill(process.pid, 'SIGKILL')),
  hang: () => pair(forever),
  flood: () => pair(async () => {
    const chunk = 'x'.repeat(64 << 10);
    for (let index = 0; index < 32; index += 1) process.stdout.write(chunk);
    await forever();
  }),
  'after-refusal': () => {
    const spawn = guarded('child_process', 'spawn');
    pair();
    after(() => ignore(() => spawn('false')));
  },
  'late-refusal': () => {
    const connect = guarded('net', 'connect');
    const execFileSync = guarded('child_process', 'execFileSync');
    pair();
    process.on('exit', () => { ignore(() => connect(9)); ignore(() => execFileSync('false')); });
  },
  alias: () => pair(async () => {
    for (const attempt of [() => import('child_process'), () => require('node:child_process'),
      () => require('net'), () => import('node:net')]) await refused(attempt);
    guarded('child_process', 'spawn');
  }),
  excluded: () => pair(excluded),
  bare: () => pair(async () => {
    assert.equal(bare.length, 7);
    for (const specifier of bare) {
      await refused(() => import.meta.resolve(specifier));
      await refused(() => require.resolve(specifier));
    }
  }),
};

assert.ok(Object.hasOwn(MODES, mode), `unknown control mode ${mode}`);
MODES[mode]();
