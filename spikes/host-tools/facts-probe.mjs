import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Container side of probe A7. It re-reads, in the pinned packages, each place that Crew's record of SDK facts
// (crew:docs/member-capabilities.md, "SDK assumptions", read at Claude SDK 0.3.306 and Codex 0.167.1) cites, and
// generates the pinned Codex app-server protocol with the experimental API. It records what it finds, with line numbers
// in the pinned files; the qualification document compares that with the record.
const NM = '/node_modules';
const version = (name) => JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8')).version;
const arch = process.arch;
const codexTarget = { arm64: ['codex-linux-arm64', 'aarch64-unknown-linux-musl'], x64: ['codex-linux-x64', 'x86_64-unknown-linux-musl'] }[arch];
const CODEX = join(NM, '@openai', codexTarget[0], 'vendor', codexTarget[1], 'bin', 'codex');
const CLAUDE = join(NM, '@anthropic-ai', `claude-agent-sdk-linux-${arch}`, 'claude');
const lines = (path, pattern) => readFileSync(path, 'utf8').split('\n').flatMap((text, index) =>
  (pattern.test(text) ? [{ line: index + 1, text: text.trim().slice(0, 300) }] : []));
const strings = (path, needles) => {
  const bytes = readFileSync(path);
  return Object.fromEntries(needles.map((needle) => [needle, bytes.indexOf(needle) >= 0]));
};
const report = { node: process.version, arch, environmentKeys: Object.keys(process.env).sort(), versions: { claudeSdk: version('@anthropic-ai/claude-agent-sdk'),
  claudeCli: execFileSync(CLAUDE, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: '/home/probe' }, encoding: 'utf8' }).trim(),
  codexSdk: version('@openai/codex-sdk'), codex: execFileSync(CODEX, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: '/home/probe' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), piCodingAgent: version('@earendil-works/pi-coding-agent'),
  piAgentCore: version('@earendil-works/pi-agent-core') } };

const sdk = join(NM, '@anthropic-ai/claude-agent-sdk/sdk.d.ts');
report.claudeTypes = {
  hookPermissionDecision: lines(sdk, /export declare type HookPermissionDecision =/),
  preToolUseInput: lines(sdk, /export declare type PreToolUseHookInput =|mcp_server\?: McpServerProvenance/),
  mcpServerProvenance: lines(sdk, /export declare type McpServerProvenance =/),
  sdkServerConfig: lines(sdk, /type: 'sdk';/),
  mcpToolNaming: lines(sdk, /mcp__[a-z<{]/).slice(0, 5),
  deferredToolUse: lines(sdk, /deferred_tool_use\?: SDKDeferredToolUse|export declare type SDKDeferredToolUse =/),
  terminalReason: lines(sdk, /export declare type TerminalReason =/),
  resultStopReason: lines(sdk, /stop_reason: string \| null;/),
};
report.claudeBinary = strings(CLAUDE, [
  'returned permissionDecision=defer in interactive mode; ignoring (defer is print-mode only)',
  'tool calls are in this batch; ignoring (defer is solo-only',
  'returned permissionDecision=defer for a served call; refusing (no resume machinery)',
  'tool_deferred_unavailable',
  'Auto-resuming deferred tool',
]);

execFileSync(CODEX, ['app-server', 'generate-ts', '--experimental', '--out', '/tmp/codex-protocol'],
  { env: { PATH: '/usr/bin:/bin', HOME: '/home/probe' }, stdio: 'ignore' });
const protocol = (file) => join('/tmp/codex-protocol', file);
const files = readdirSync('/tmp/codex-protocol', { recursive: true }).map(String).filter((file) => file.endsWith('.ts')).sort();
const digest = createHash('sha256');
for (const file of files) digest.update(file).update('\0').update(readFileSync(protocol(file))).update('\0');
report.codexProtocol = {
  command: 'codex app-server generate-ts --experimental --out /tmp/codex-protocol', files: files.length, sha256: digest.digest('hex'),
  serverRequestToolCall: lines(protocol('ServerRequest.ts'), /item\/tool\/call/).map(({ line }) => ({ line, text: '"item/tool/call", id: RequestId, params: DynamicToolCallParams' })),
  dynamicToolCallParams: lines(protocol('v2/DynamicToolCallParams.ts'), /export type/),
  dynamicToolCallResponse: lines(protocol('v2/DynamicToolCallResponse.ts'), /export type/),
  dynamicToolSpec: lines(protocol('v2/DynamicToolFunctionSpec.ts'), /export type/),
  threadStartDynamicTools: lines(protocol('v2/ThreadStartParams.ts'), /dynamicTools/),
  threadResumeDynamicTools: lines(protocol('v2/ThreadResumeParams.ts'), /dynamicTools/),
  turnStartDynamicTools: lines(protocol('v2/TurnStartParams.ts'), /dynamicTools/),
  timeoutFieldsInDynamicTypes: files.filter((file) => /Dynamic/.test(file))
    .flatMap((file) => lines(protocol(file), /timeout/i).map((hit) => ({ file, ...hit }))),
  experimentalCapability: lines(protocol('InitializeCapabilities.ts'), /experimentalApi/),
};
report.codexBinary = strings(CODEX, ['dynamic tool calls are not supported in exec mode',
  'dynamic tool call was cancelled before receiving a response']);
report.codexSdk = lines(join(NM, '@openai/codex-sdk/dist/index.js'), /experimental-json/);

const pi = join(NM, '@earendil-works/pi-coding-agent');
report.pi = {
  toolCallHook: existsSync(join(pi, 'dist/core/extensions/types.d.ts'))
    ? lines(join(pi, 'dist/core/extensions/types.d.ts'), /Fired before a tool executes|interface ToolCallEventResult|on\(event: "tool_call"/) : 'missing',
  docsBlock: existsSync(join(pi, 'docs/extensions.md')) ? lines(join(pi, 'docs/extensions.md'), /errors block the tool|\*\*Can block\.\*\*/) : 'missing',
  beforeToolCall: lines(join(NM, '@earendil-works/pi-agent-core/dist/types.d.ts'), /beforeToolCall/),
};
process.stdout.write(JSON.stringify(report));
