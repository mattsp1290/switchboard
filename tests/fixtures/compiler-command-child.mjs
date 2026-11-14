import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, root] = process.argv.slice(2);
if (mode === 'ignored' || mode === 'ordinary') {
  if (mode === 'ignored') process.on('SIGTERM', () => {});
  process.stdout.write('partial stdout\n');
  process.stderr.write('partial stderr\n');
  let ticks = 0;
  writeFileSync(join(root, 'heartbeat'), '0');
  setInterval(() => writeFileSync(join(root, 'heartbeat'), String(++ticks)), 20);
} else if (mode === 'diagnostic') {
  process.stdout.write('fixture.ts(1,1): error TS2322: synthetic diagnostic\n');
  process.exitCode = 1;
} else if (mode === 'nonzero') {
  process.exitCode = 2;
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'success') {
  process.stdout.write('inert stdout\n');
  process.stderr.write('inert stderr\n');
} else {
  throw new Error('Unknown inert command mode');
}
