import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [, , sdkPath, scratch] = process.argv;
assert.ok(process.permission, 'Run through run.mjs');
assert.equal(process.permission.has('child'), false);
const sdk = await import(pathToFileURL(join(sdkPath, 'sdk.mjs')).href);
const manifest = JSON.parse(readFileSync(join(sdkPath, 'package.json'), 'utf8'));
assert.equal(manifest.version, '0.3.323');
assert.equal(manifest.claudeCodeVersion, '2.1.323');
for (const name of ['query', 'listSessions', 'getSessionInfo', 'getSessionMessages',
  'listSubagents', 'getSubagentMessages', 'forkSession', 'importSessionToStore']) {
  assert.equal(typeof sdk[name], 'function', `public root export ${name}`);
}
const dir = join(scratch, 'project');
const project = join(scratch, 'config', 'projects', 'fixture');
mkdirSync(dir, { recursive: true });
mkdirSync(project, { recursive: true });
const session = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const assistant = '33333333-3333-4333-8333-333333333333';
const absent = '44444444-4444-4444-8444-444444444444';
const broken = '55555555-5555-4555-8555-555555555555';
const entries = [
  { type: 'user', uuid: user, parentUuid: null, sessionId: session, cwd: dir,
    timestamp: '2026-11-13T00:00:00.000Z', version: '2.1.323',
    message: { role: 'user', content: 'Synthetic external session' } },
  { type: 'assistant', uuid: assistant, parentUuid: user, sessionId: session,
    timestamp: '2026-11-13T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }] } },
];
const transcript = join(project, `${session}.jsonl`);
const before = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
writeFileSync(transcript, before);
writeFileSync(join(project, `${broken}.jsonl`), '{invalid-json}\n');
const listed = await sdk.listSessions({ dir, includeWorktrees: false });
assert.ok(listed.some((entry) => entry.sessionId === session));
assert.equal((await sdk.getSessionInfo(session, { dir })).sessionId, session);
assert.deepEqual((await sdk.getSessionMessages(session, { dir })).map((entry) => entry.uuid),
  [user, assistant]);
assert.deepEqual(await sdk.getSessionMessages(absent, { dir }), []);
assert.deepEqual(await sdk.getSessionMessages(broken, { dir }), []);
assert.equal(await sdk.getSessionInfo(absent, { dir }), undefined);
assert.equal(await sdk.getSessionInfo(broken, { dir }), undefined);
assert.equal(readFileSync(transcript, 'utf8'), before);
const store = new sdk.InMemorySessionStore();
await sdk.importSessionToStore(session, store, { dir, includeSubagents: false, batchSize: 1 });
const key = { projectKey: 'fixture', sessionId: session };
assert.deepEqual(await store.load(key), entries);
assert.deepEqual((await sdk.getSessionMessages(session, { dir, sessionStore: store }))
  .map((entry) => entry.uuid), [user, assistant]);
const opaque = { type: 'future_extension', payload: { nested: ['preserved', 7] } };
await store.append(key, [opaque]);
assert.deepEqual((await store.load(key)).at(-1), opaque);

const wire = [];
let spawnOptions;
const child = new EventEmitter();
child.stdin = new PassThrough();
child.stdout = new PassThrough();
child.killed = false;
child.exitCode = null;
child.kill = () => { child.killed = true; finish(); return true; };
function finish() {
  if (child.exitCode !== null) return;
  child.exitCode = 0;
  child.stdout.end();
  child.emit('exit', 0, null);
}
child.stdin.on('finish', finish);
function emit(frame) { child.stdout.write(JSON.stringify(frame) + '\n'); }
let buffered = '';
child.stdin.on('data', (chunk) => {
  buffered += chunk.toString();
  let end;
  while ((end = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    wire.push(frame);
    if (frame.type === 'control_request') {
      emit({ type: 'control_response', response: {
        subtype: 'success', request_id: frame.request_id, response: {},
      } });
    }
  }
});
const pendingInput = new PassThrough({ objectMode: true });
const permissions = [];
const query = sdk.query({ prompt: pendingInput, options: {
  cwd: dir,
  resume: session,
  resumeSessionAt: assistant,
  enableFileCheckpointing: true,
  permissionMode: 'default',
  settingSources: [],
  settings: { apiKeyHelper: '/fixture/host-owned-credential-command' },
  includePartialMessages: true,
  forwardSubagentText: true,
  env: { CLAUDE_CONFIG_DIR: join(scratch, 'config'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '1000' },
  pathToClaudeCodeExecutable: join(scratch, 'never-executed'),
  spawnClaudeCodeProcess: (options) => { spawnOptions = options; return child; },
  canUseTool: async (tool, input, options) => {
    permissions.push({ tool, input, requestId: options.requestId, toolUseID: options.toolUseID });
    return { behavior: 'deny', message: 'fixture denial' };
  },
} });
try {
  await query.initializationResult();
  assert.equal(spawnOptions.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
  assert.equal(spawnOptions.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, '1000');
  assert.equal(spawnOptions.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.ok(spawnOptions.args.includes(`--resume=${session}`));
  assert.ok(spawnOptions.args.includes(`--resume-session-at=${assistant}`));
  const settingsIndex = spawnOptions.args.indexOf('--settings');
  assert.ok(settingsIndex >= 0);
  assert.equal(JSON.parse(spawnOptions.args[settingsIndex + 1]).apiKeyHelper,
    '/fixture/host-owned-credential-command');
  emit({ type: 'control_request', request_id: 'fixture-permission', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'never executed' },
    tool_use_id: 'fixture-tool',
  } });
  const nativeEvent = { type: 'system', subtype: 'future_fixture_event',
    session_id: session, uuid: user, extra: { preserved: true } };
  emit(nativeEvent);
  assert.deepEqual((await query.next()).value, nativeEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(permissions, [{ tool: 'Bash', input: { command: 'never executed' },
    requestId: 'fixture-permission', toolUseID: 'fixture-tool' }]);
  assert.equal(wire.find((frame) => frame.type === 'control_response'
    && frame.response.request_id === 'fixture-permission').response.response.behavior, 'deny');
  await query.reinitialize();
  await query.rewindFiles(user, { dryRun: true });
  assert.ok(wire.some((frame) => frame.request?.subtype === 'rewind_files'));
} finally {
  query.close();
  pendingInput.destroy();
  finish();
}
assert.equal(readFileSync(transcript, 'utf8'), before);
process.stdout.write(JSON.stringify({ evidence: 'fixture-only', sdk: manifest.version,
  nativeProcessLaunched: false, providerRequests: 0,
  checks: ['root exports', 'synthetic external history unchanged', 'missing/malformed ambiguity',
    'store import and opaque entry', 'mock resume/settings transport', 'permission request identity',
    'unknown event pass-through', 'reinitialize and rewind control serialization'],
}) + '\n');
