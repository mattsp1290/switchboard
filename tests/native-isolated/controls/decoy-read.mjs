// Control for `npm run test:native-isolated`: reads a decoy credential, swallows any error and exits 0.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

try { readFileSync(join(homedir(), '.codex', 'auth.json')); } catch { /* the gate must still reject the attempt */ }
