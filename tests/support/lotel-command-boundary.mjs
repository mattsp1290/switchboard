import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { basename } from 'node:path';

const binary = basename(process.argv[1]);
if (!['docker', 'go', 'lotel'].includes(binary)) {
  net.createServer = () => Object.assign(new EventEmitter(), {
    listen(_options, ready) { queueMicrotask(ready); },
    close(done) { done(); },
  });
  syncBuiltinESMExports();
} else {
  const args = process.argv.slice(2);
  const state = process.env.LOTEL_TEST_STATE;
  const owned = 'a'.repeat(64);
  const competing = 'b'.repeat(64);
  appendFileSync(process.env.LOTEL_TEST_COMMANDS, JSON.stringify({ binary, args }) + '\n');
  if (binary === 'go') {
    assert.deepEqual(args.slice(0, 2), ['version', '-m']);
    console.log('lotel: go1.26.0\n build vcs.revision=8b7023e08d317cf079b7a63f93d1f17e67a0083d\n build vcs.modified=false');
  } else if (binary === 'docker') {
    switch (args[0]) {
      case 'info': console.log('synthetic-docker'); break;
      case 'ps': console.log(existsSync(state) ? readFileSync(state, 'utf8') : ''); break;
      case 'create':
        assert(!existsSync(state), 'preflight observed an empty daemon');
        if (process.env.LOTEL_TEST_SCENARIO === 'collision') {
          writeFileSync(state, competing);
          console.error('Conflict: container name already acquired by competing runner');
          process.exitCode = 1;
        } else {
          writeFileSync(state, owned);
          console.log(owned);
        }
        break;
      case 'start':
        assert.deepEqual(args, ['start', owned]);
        if (process.env.LOTEL_TEST_SCENARIO === 'replacement') writeFileSync(state, competing);
        console.error('Synthetic startup failure after successful name acquisition');
        process.exitCode = 1;
        break;
      case 'inspect': console.log(readFileSync(state, 'utf8')); break;
      case 'logs': console.log('Synthetic collector diagnostics'); break;
      case 'stop':
      case 'rm':
        assert.deepEqual(args, [args[0], owned], 'only the full acquired ID may be mutated');
        assert.equal(readFileSync(state, 'utf8'), owned, 'competing containers must be preserved');
        if (args[0] === 'rm') rmSync(state);
        console.log(owned);
        break;
      default: throw new Error(`Unexpected Docker command: ${args[0]}`);
    }
  } else {
    throw new Error(`No lotel command should execute before successful startup: ${args[0]}`);
  }
}
