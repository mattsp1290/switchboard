// Control for `npm run test:native-isolated`: launches a program outside the allowlist and exits 0.
import { spawnSync } from 'node:child_process';

spawnSync('/bin/true');
