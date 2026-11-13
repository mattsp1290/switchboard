import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.versions.node, '24.22.3', 'Use the repository-pinned Node version');
const tarball = process.argv[2];
assert.ok(tarball, 'Usage: node spikes/claude/run.mjs /absolute/path/claude.tgz');
const integrity = 'GXIczMzzceNWB+bIImK59hWOQoBWZtSw+AESPc/qbAWmmHM8Wrqb5KvTwWZ07CmjyC/KcPC47nOLxxyHlWqKPA==';
assert.equal(createHash('sha512').update(readFileSync(tarball)).digest('base64'), integrity);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'switchboard-claude-selection-')));
const probe = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', scratch], { timeout: 10_000 });
  const sdk = join(scratch, 'package');
  for (const [file, hash] of Object.entries({
    'sdk.mjs': '9350483cd0434c18c13745d7ca2630acd4ef29c6c2f0038b5a061f7e8c0fdb78',
    'sdk.d.ts': '65199eafa1a4f93bb9cff5316b19144ebb9986211497aded56fccd821bcd33c9',
  })) {
    assert.equal(createHash('sha256').update(readFileSync(join(sdk, file))).digest('hex'), hash);
  }
  const output = execFileSync(process.execPath, [
    '--permission', `--allow-fs-read=${scratch}`, `--allow-fs-read=${probe}`,
    `--allow-fs-write=${scratch}`, probe, sdk, scratch,
  ], {
    cwd: scratch,
    env: {
      CLAUDE_CONFIG_DIR: join(scratch, 'config'),
      CLAUDE_CODE_PROJECT_DIR_NAME: 'fixture',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  process.stdout.write(output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
