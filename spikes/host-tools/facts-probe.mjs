import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Container side of probe A7. It re-reads, in the installed packages, each place that Crew's record of SDK facts
// (crew:docs/member-capabilities.md, "SDK assumptions", read at Claude SDK 0.3.306 and Codex 0.167.1) cites, and
// generates the installed Codex app-server protocol with the experimental API. It records the text it finds, with line
// numbers; the qualification document compares that with the record. A package missing from the volume is recorded as
// absent, so the same probe also reads a volume that holds only an older Claude SDK.
const NM = '/node_modules';
const arch = process.arch;
const codexTarget = { arm64: ['codex-linux-arm64', 'aarch64-unknown-linux-musl'], x64: ['codex-linux-x64', 'x86_64-unknown-linux-musl'] }[arch];
const CODEX = join(NM, '@openai', codexTarget[0], 'vendor', codexTarget[1], 'bin', 'codex');
const CLAUDE = join(NM, '@anthropic-ai', `claude-agent-sdk-linux-${arch}`, 'claude');
const env = { PATH: '/usr/bin:/bin', HOME: '/home/probe' };
const section = (fn) => { try { return fn(); } catch (error) { return { absent: String(error.message).slice(0, 300) }; } };
const version = (name) => section(() => JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8')).version);
const lines = (path, pattern) => readFileSync(path, 'utf8').split('\n').flatMap((text, index) =>
  (pattern.test(text) ? [{ line: index + 1, text: text.trim() }] : []));
// The matched text itself, with its line, for a pattern inside a long generated line.
const matches = (path, pattern) => readFileSync(path, 'utf8').split('\n').flatMap((text, index) =>
  [...text.matchAll(new RegExp(pattern, 'g'))].map((match) => ({ line: index + 1, text: match[0] })));
const strings = (path, needles) => {
  const bytes = readFileSync(path);
  return Object.fromEntries(needles.map((needle) => [needle, bytes.indexOf(needle) >= 0]));
};
const window = (path, needle, before, after) => {
  const text = readFileSync(path, 'utf8');
  const at = text.indexOf(needle);
  return at < 0 ? null : text.slice(Math.max(0, at - before), at + needle.length + after);
};
const report = { node: process.version, arch, environmentKeys: Object.keys(process.env).sort(), versions: {
  claudeSdk: version('@anthropic-ai/claude-agent-sdk'),
  claudeCli: section(() => execFileSync(CLAUDE, ['--version'], { env, encoding: 'utf8' }).trim()),
  codexSdk: version('@openai/codex-sdk'),
  codex: section(() => execFileSync(CODEX, ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()),
  piCodingAgent: version('@earendil-works/pi-coding-agent'), piAgentCore: version('@earendil-works/pi-agent-core') } };

const sdkDir = join(NM, '@anthropic-ai/claude-agent-sdk');
const sdk = join(sdkDir, 'sdk.d.ts');
report.claudeTypes = section(() => ({
  hookPermissionDecision: lines(sdk, /export declare type HookPermissionDecision =/),
  preToolUseInput: lines(sdk, /export declare type PreToolUseHookInput =|mcp_server\?: McpServerProvenance/),
  mcpServerProvenance: lines(sdk, /export declare type McpServerProvenance =/),
  sdkServerConfig: lines(sdk, /type: 'sdk';/),
  mcpToolNaming: lines(sdk, /mcp__server__tool_name/),
  deferredToolUse: lines(sdk, /deferred_tool_use\?: SDKDeferredToolUse|export declare type SDKDeferredToolUse =/),
  terminalReason: lines(sdk, /export declare type TerminalReason =/),
}));
// When the SDK adds --await-initialize on its own: the minified condition and its use, as the bundle has them.
report.claudeAwaitInitialize = section(() => ({
  condition: window(join(sdkDir, 'sdk.mjs'), '.pathToClaudeCodeExecutable&&!', 60, 120),
  use: window(join(sdkDir, 'sdk.mjs'), '{"await-initialize":null}', 80, 0),
}));
report.claudeBinary = section(() => strings(CLAUDE, [
  'returned permissionDecision=defer in interactive mode; ignoring (defer is print-mode only)',
  'tool calls are in this batch; ignoring (defer is solo-only \\u2014 siblings would be orphaned on resume)',
  'tool calls are in this batch; ignoring (defer is solo-only — siblings would be orphaned on resume)',
  'returned permissionDecision=defer for a served call; refusing (no resume machinery)',
  'tool_deferred_unavailable',
  'Auto-resuming deferred tool',
]));

report.codexProtocol = section(() => {
  execFileSync(CODEX, ['app-server', 'generate-ts', '--experimental', '--out', '/tmp/codex-protocol'], { env, stdio: 'ignore' });
  const protocol = (file) => join('/tmp/codex-protocol', file);
  const files = readdirSync('/tmp/codex-protocol', { recursive: true }).map(String).filter((file) => file.endsWith('.ts')).sort();
  const digest = createHash('sha256');
  for (const file of files) digest.update(file).update('\0').update(readFileSync(protocol(file))).update('\0');
  return {
    command: 'codex app-server generate-ts --experimental --out /tmp/codex-protocol', files: files.length, sha256: digest.digest('hex'),
    serverRequestToolCall: matches(protocol('ServerRequest.ts'), '\\{ "method": "item/tool/call"[^}]*\\}'),
    dynamicToolCallParams: lines(protocol('v2/DynamicToolCallParams.ts'), /export type/),
    dynamicToolCallResponse: lines(protocol('v2/DynamicToolCallResponse.ts'), /export type/),
    dynamicToolSpec: lines(protocol('v2/DynamicToolSpec.ts'), /export type/),
    dynamicToolFunctionSpec: lines(protocol('v2/DynamicToolFunctionSpec.ts'), /export type/),
    dynamicToolNamespaceSpec: lines(protocol('v2/DynamicToolNamespaceSpec.ts'), /export type/),
    threadStartDynamicTools: matches(protocol('v2/ThreadStartParams.ts'), 'dynamicTools\\?: [^,]*'),
    threadResumeDynamicTools: lines(protocol('v2/ThreadResumeParams.ts'), /dynamicTools/),
    turnStartDynamicTools: lines(protocol('v2/TurnStartParams.ts'), /dynamicTools/),
    timeoutFieldsInDynamicTypes: files.filter((file) => /Dynamic/.test(file))
      .flatMap((file) => lines(protocol(file), /timeout/i).map((hit) => ({ file, ...hit }))),
    experimentalCapability: lines(protocol('InitializeCapabilities.ts'), /experimentalApi/),
  };
});
report.codexBinary = section(() => strings(CODEX, ['dynamic tool calls are not supported in exec mode',
  'dynamic tool call was cancelled before receiving a response']));
report.codexSdk = section(() => lines(join(NM, '@openai/codex-sdk/dist/index.js'), /experimental-json/));

const pi = join(NM, '@earendil-works/pi-coding-agent');
report.pi = section(() => ({
  toolCallHook: lines(join(pi, 'dist/core/extensions/types.d.ts'), /Fired before a tool executes|interface ToolCallEventResult|on\(event: "tool_call"/),
  docsBlock: existsSync(join(pi, 'docs/extensions.md')) ? lines(join(pi, 'docs/extensions.md'), /errors block the tool|\*\*Can block\.\*\*/) : 'missing',
  beforeToolCall: lines(join(NM, '@earendil-works/pi-agent-core/dist/types.d.ts'), /beforeToolCall/),
}));
process.stdout.write(JSON.stringify(report), () => process.exit(0));
