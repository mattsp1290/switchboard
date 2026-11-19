// Control for `npm run test:native-isolated`: attempts a TCP connection, swallows the failure and exits 0.
import { connect } from 'node:net';

await new Promise((resolve) => {
  const socket = connect(443, '192.0.2.1');
  socket.once('error', resolve).once('connect', () => { socket.destroy(); resolve(); });
});
