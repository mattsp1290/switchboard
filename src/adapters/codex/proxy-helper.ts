/**
 * Codex provider `auth.command` helper (proxy.ts): `node proxy-helper.js <socket>`. It reads one token from the
 * host's credential broker and prints it for Codex to send as `Authorization: Bearer`. The token never enters argv,
 * the environment or a file. Any failure prints nothing on stdout, fixed text on stderr and exits non-zero.
 */
import { connect } from 'node:net';

const limit = 65536;
const chunks: Buffer[] = [];
let size = 0;
let failed = false;
const fail = () => {
  if (failed) return;
  failed = true;
  process.exitCode = 3;
  process.stderr.write('switchboard: proxy credential unavailable\n');
};
const path = process.argv[2];
if (process.argv.length !== 3 || !path) fail();
else {
  const socket = connect(path, () => socket.end());
  socket.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) { socket.destroy(); fail(); } else chunks.push(chunk);
  });
  socket.on('error', fail);
  socket.on('end', () => {
    if (size === 0 || size > limit) fail();
    else if (!failed) process.stdout.write(Buffer.concat(chunks));
  });
}
