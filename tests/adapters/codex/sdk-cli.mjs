#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.CODEX_HOME;
const args = process.argv.slice(2);
const { version, login, id } = JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8'));
if (args[0] === '--version') {
  console.log('codex-cli ' + version);
} else if (args[0] === 'login') {
  console.error(login);
} else if (args[0] === 'mcp') {
  console.log(JSON.stringify([{ name: 'fixture.one', enabled: true }]));
} else {
  const text = readFileSync(0, 'utf8');
  writeFileSync(join(dir, 'pid'), String(process.pid));
  writeFileSync(join(dir, 'args.json'), JSON.stringify({ args, inherited: Object.keys(process.env) }));
  const emit = (event) => console.log(JSON.stringify(event));
  const resume = args.indexOf('resume');
  if (resume >= 0 && args[resume + 1] !== id) process.exit(2);
  emit({ type: 'thread.started', thread_id: text === 'mismatch' ? 'edbb9da5-77f8-4587-82a7-cd191cd7329d' : id });
  emit({ type: 'item.completed', item: { type: 'error', message: 'Native setup notice' } });
  if (text === 'no admission') process.exit(1);
  emit({ type: 'turn.started' });
  if (text === 'stubborn') process.on('SIGTERM', () => {});
  if (text === 'pending' || text === 'stubborn') {
    await new Promise(() => setInterval(() => {}, 1000));
  } else if (text === 'stderr') {
    console.error('sensitive native diagnostic');
    process.exit(1);
  } else if (text === 'truncated') {
    process.exit(0);
  } else {
    const item = { type: 'agent_message', id: 'item_0' };
    emit({ type: 'item.updated', item: { ...item, text: 'first' } });
    emit({ type: 'item.completed', item: { ...item, text: 'first second' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  }
}
