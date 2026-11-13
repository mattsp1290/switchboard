import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.HOME, undefined);
assert.equal(process.env.CODEX_HOME, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.throws(() => readFileSync('/etc/passwd'), { code: 'ERR_ACCESS_DENIED' });
assert.throws(() => spawnSync('/bin/true'), { code: 'ERR_ACCESS_DENIED' });
await new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port: 9 });
  socket.once('connect', () => { socket.destroy(); reject(new Error('network allowed')); });
  socket.once('error', error => {
    socket.destroy();
    if (error.code === 'EPERM' || error.code === 'EACCES') resolve();
    else reject(error);
  });
});
let input = '';
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.TRACE, JSON.stringify({ args: process.argv.slice(2), input,
  key: process.env.CODEX_API_KEY, fixtureRoot: process.env.SWITCHBOARD_FIXTURE_ROOT }) + '\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'thread.started', thread_id: 'native-fixture-id' });
if (input === 'malformed') process.stdout.write('{\n');
else if (input === 'exit') { process.stderr.write('fixture interrupted'); process.exitCode = 9; }
else if (input === 'abort') { emit({ type: 'turn.started' }); setInterval(() => {}, 1000); }
else if (input === 'failure') emit({ type: 'turn.failed', error: { message: 'fixture failed' } });
else if (input === 'fatal') emit({ type: 'error', message: 'fixture fatal' });
else {
  emit({ type: 'future.event', opaque: { nested: ['preserve', 7] } });
  emit({ type: 'item.completed', item: { type: 'agent_message', id: 'item-1', text: 'fixture answer' } });
  if (input !== 'eof') emit({ type: 'turn.completed', usage: {
    input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0,
  } });
}
