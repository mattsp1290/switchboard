import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Container side of probes A5 and A6 with the real Claude CLI that the pinned Agent SDK bundles. The orchestrator holds
// the synthetic Messages service and runs each SDK host phase as its own Node process, so nothing but the files under
// CLAUDE_CONFIG_DIR carries from the deferring process to the resuming one. Each phase starts its own loopback HTTP
// MCP server with a fresh port and bearer. The probe records; it never asserts.
const HOME = '/home/probe';
const CONFIG = join(HOME, 'claude-config');
const PROJECT = join(HOME, 'project');
const STATE = join(HOME, 'state');
const self = fileURLToPath(import.meta.url);
const t0 = Number(process.env.PROBE_T0 ?? Date.now());
const now = () => Date.now() - t0;
// `gated` names the calls the first phase's hook defers; every other call it allows, or denies when `others` says so. The model emits `calls` in one
// assistant message, in that order.
const PROBE = 'mcp__host__host_probe';
const ECHO = 'mcp__host__host_echo';
const SCENARIOS = {
  solo: { calls: [{ id: 'toolu_01HostProbeSolo00000001', name: PROBE }], gated: [PROBE], allowedTools: [] },
  // As solo, but the resuming process omits --await-initialize, which the SDK does not add for a host spawn function.
  'solo-no-await': { calls: [{ id: 'toolu_01HostProbeSolo00000002', name: PROBE }], gated: [PROBE], allowedTools: [], noAwait: true },
  batch: { calls: [{ id: 'toolu_01HostProbeBatch0000001', name: PROBE }, { id: 'toolu_01HostEchoBatch00000001', name: ECHO }],
    gated: [PROBE], allowedTools: [] },
  'batch-reversed': { calls: [{ id: 'toolu_01HostEchoBatch00000003', name: ECHO }, { id: 'toolu_01HostProbeBatch0000003', name: PROBE }],
    gated: [PROBE], allowedTools: [] },
  'batch-preallowed': { calls: [{ id: 'toolu_01HostProbeBatch0000002', name: PROBE }, { id: 'toolu_01HostEchoBatch00000002', name: ECHO }],
    gated: [PROBE], allowedTools: [PROBE, ECHO] },
  'batch-deny-sibling': { calls: [{ id: 'toolu_01HostProbeBatch0000006', name: PROBE }, { id: 'toolu_01HostEchoBatch00000006', name: ECHO }],
    gated: [PROBE], others: 'deny', allowedTools: [] },
  'batch-both-gated': { calls: [{ id: 'toolu_01HostProbeBatch0000004', name: PROBE }, { id: 'toolu_01HostEchoBatch00000004', name: ECHO }],
    gated: [PROBE, ECHO], allowedTools: [] },
  'batch-both-gated-preallowed': { calls: [{ id: 'toolu_01HostProbeBatch0000005', name: PROBE }, { id: 'toolu_01HostEchoBatch00000005', name: ECHO }],
    gated: [PROBE, ECHO], allowedTools: [PROBE, ECHO] },
};
const blockSummary = (block) => ({ type: block?.type, ...(block?.id && { id: block.id }), ...(block?.name && { name: block.name }),
  ...(block?.tool_use_id && { tool_use_id: block.tool_use_id }), ...(block?.is_error !== undefined && { is_error: block.is_error }),
  ...(block?.type === 'text' && { text: String(block.text).slice(0, 160) }),
  ...(block?.type === 'tool_result' && { content: typeof block.content === 'string' ? block.content
    : (block.content ?? []).map((part) => part?.text ?? `(${part?.type})`).join('') }),
  ...(block?.type === 'tool_use' && { input: block.input }) });

if (process.argv[2] === '--phase') await phase(process.argv[3], process.argv[4], process.argv[5]);
else await orchestrate(process.argv[2]);

async function orchestrate(scenario) {
  if (!SCENARIOS[scenario]) throw new Error(`Unknown scenario ${scenario}`);
  for (const dir of [CONFIG, PROJECT, STATE]) mkdirSync(dir, { recursive: true });
  const pkg = (name) => JSON.parse(readFileSync(`/node_modules/${name}/package.json`, 'utf8')).version;
  const report = { scenario, node: process.version, arch: process.arch, environmentKeys: Object.keys(process.env).sort(),
    versions: { sdk: pkg('@anthropic-ai/claude-agent-sdk'), cli: pkg(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}`),
      mcp: pkg('@modelcontextprotocol/sdk') }, model: [], phases: [] };
  // Synthetic Messages service: a request whose last message carries tool results gets text; a request whose tools
  // include the scenario's tool names gets those tool calls in one assistant message; anything else gets text.
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/v1/messages/count_tokens') {
      report.model.push({ at: now(), path });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}');
      return;
    }
    if (request.method !== 'POST' || path !== '/v1/messages') {
      report.model.push({ at: now(), method: request.method, path, status: 404 });
      response.writeHead(404).end();
      return;
    }
    const input = JSON.parse(body);
    const messages = (input.messages ?? []).map((message) => ({ role: message.role,
      blocks: typeof message.content === 'string' ? [{ type: 'text', text: message.content.slice(0, 160) }] : message.content.map(blockSummary) }));
    const tools = (input.tools ?? []).map((tool) => tool.name ?? `(${tool.type})`);
    const last = messages.at(-1);
    const results = last?.role === 'user' ? last.blocks.filter((block) => block.type === 'tool_result') : [];
    const resultCounts = {};
    for (const message of messages) for (const block of message.blocks) {
      if (block.type === 'tool_result') resultCounts[block.tool_use_id] = (resultCounts[block.tool_use_id] ?? 0) + 1;
    }
    const entry = { n: report.model.filter((item) => item.n).length + 1, at: now(), phase: report.currentPhase ?? null, path, tools,
      stream: input.stream === true, messages, resultCounts };
    report.model.push(entry);
    const calls = SCENARIOS[scenario].calls;
    const reply = results.length ? { text: `done after ${results.map((block) => block.tool_use_id).join(',')}` }
      : calls.every((call) => tools.includes(call.name)) ? { calls } : { text: 'no scenario tool offered' };
    entry.reply = reply;
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: input.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (reply.calls) {
      reply.calls.forEach((call, index) => {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ note: scenario }) } });
        send('content_block_stop', { index });
      });
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text } });
      send('content_block_stop', { index: 0 });
    }
    send('message_delta', { delta: { stop_reason: reply.calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    send('message_stop', {});
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const provider = `http://127.0.0.1:${server.address().port}`;
  const runPhase = (number) => new Promise((resolve) => {
    report.currentPhase = number;
    const child = spawn(process.execPath, [self, '--phase', String(number), scenario, provider],
      { env: { PATH: process.env.PATH, HOME, PROBE_T0: String(t0) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4096); });
    child.once('close', (code, signal) => {
      let result;
      try { result = JSON.parse(Buffer.concat(out).toString()); } catch { result = { unparsed: Buffer.concat(out).toString().slice(-4096) }; }
      resolve({ phase: number, hostExit: { code, signal }, hostStderrTail: err, ...result });
    });
  });
  try {
    const first = await runPhase(1);
    report.phases.push(first);
    if (first.result?.deferred_tool_use) report.phases.push(await runPhase(2));
  } finally {
    delete report.currentPhase;
    server.close();
    server.closeAllConnections();
  }
  process.stdout.write(JSON.stringify(report));
}

async function phase(number, scenario, provider) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const out = { hooks: [], mcp: [], handlers: [], sdk: [], cli: [] };
  const statePath = join(STATE, `${scenario}.json`);
  const saved = number === '2' ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

  // The loopback MCP server, built as Crew's vendored AG-UI adapter builds its own (src/loopback-mcp.ts in
  // @ag-ui/claude-agent-sdk 0.0.8): a bearer compared in constant time, the Host header checked, one path.
  const bearer = `Bearer ${randomBytes(32).toString('hex')}`;
  const mcp = new Server({ name: 'host', version: '0.0.0' }, { capabilities: { tools: {} } });
  const schema = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false };
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'host_probe', description: 'Host-run tool that the host gates.', inputSchema: schema },
    { name: 'host_echo', description: 'Host-run tool that the host does not gate.', inputSchema: schema },
  ] }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const text = `host result for ${request.params.name} in phase ${number}`;
    out.handlers.push({ at: now(), name: request.params.name, arguments: request.params.arguments ?? null, text,
      toolUseId: extra?._meta?.['claudecode/toolUseId'] ?? request.params._meta?.['claudecode/toolUseId'] ?? null });
    return { content: [{ type: 'text', text }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(transport);
  let host;
  const http = createServer((request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(bearer);
    const authorized = authorization.length === expected.length && timingSafeEqual(authorization, expected);
    out.mcp.push({ at: now(), method: request.method, url: request.url, authorized, hostHeader: request.headers.host === host });
    if (request.headers.host !== host || request.url !== '/mcp' || !authorized) { response.writeHead(403).end(); return; }
    transport.handleRequest(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${http.address().port}`;

  const hook = async (input) => {
    const entry = { at: now(), event: input.hook_event_name, tool_name: input.tool_name, tool_use_id: input.tool_use_id,
      tool_input: input.tool_input, mcp_server: input.mcp_server ?? null };
    let decision = null;
    if (input.hook_event_name === 'PreToolUse') {
      const original = SCENARIOS[scenario].calls.find((call) => call.id === input.tool_use_id && call.name === input.tool_name);
      if (number === '1') decision = SCENARIOS[scenario].gated.includes(input.tool_name) ? 'defer' : SCENARIOS[scenario].others ?? 'allow';
      else decision = original ? 'allow' : 'deny';
      entry.savedDeferral = number === '2' && input.tool_use_id === saved.deferred.id;
    }
    entry.decision = decision;
    out.hooks.push(entry);
    return decision ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision,
      ...(decision === 'deny' && { permissionDecisionReason: 'denied by the probe host' }) } } : {};
  };
  let release;
  const resultSeen = new Promise((resolve) => { release = resolve; });
  // On resume the input stays open and empty until a result arrives, so no new user turn is queued (as the vendored
  // adapter does); the first phase sends one prompt.
  const prompt = number === '1' ? `scenario:${scenario} please call the host tool`
    : (async function* held() { await resultSeen; yield* []; })();
  const abortController = new AbortController();
  const deadline = setTimeout(() => { out.phaseTimeout = now(); abortController.abort(); release(); }, 90_000);
  const options = {
    abortController,
    cwd: PROJECT, model: 'claude-sonnet-4-6', tools: [], allowedTools: SCENARIOS[scenario].allowedTools, strictMcpConfig: true,
    settingSources: [], plugins: [], permissionMode: 'dontAsk',
    mcpServers: { host: { type: 'http', url: `http://${host}/mcp`, headers: { Authorization: bearer }, alwaysLoad: true } },
    hooks: { PreToolUse: [{ hooks: [hook] }], PostToolUse: [{ hooks: [async (input) => {
      out.hooks.push({ at: now(), event: input.hook_event_name, tool_name: input.tool_name, tool_use_id: input.tool_use_id });
      return {};
    }] }] },
    // The only provider settings in the probe; they reach the CLI child through the SDK and nowhere else.
    env: { PATH: process.env.PATH, HOME, CLAUDE_CONFIG_DIR: CONFIG, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: provider,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' },
    stderr: (data) => { out.cliStderrTail = ((out.cliStderrTail ?? '') + data).slice(-4096); },
    debugFile: join(HOME, `debug-${scenario}-${number}.log`),
    spawnClaudeCodeProcess({ command, args, env, signal }) {
      const cli = spawn(command, args, { cwd: PROJECT, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
      const record = { at: now(), pid: cli.pid, command: command.replace(/.*node_modules\//, '<node_modules>/'),
        args: args.map((arg) => arg.replace(/Bearer [0-9a-f]+/g, 'Bearer <redacted>')), exit: null };
      out.cli.push(record);
      cli.stderr?.on('data', (data) => { out.cliStderrTail = ((out.cliStderrTail ?? '') + data).slice(-4096); });
      cli.once('close', (code, sig) => { record.exit = { code, signal: sig, at: now() }; });
      return cli;
    },
    ...(number === '2' && { resume: saved.sessionId, forkSession: false,
      ...(!SCENARIOS[scenario].noAwait && { extraArgs: { 'await-initialize': null } }) }),
  };
  try {
    for await (const message of query({ prompt, options })) {
      const entry = { at: now(), type: message.type, subtype: message.subtype ?? null, session_id: message.session_id ?? null };
      if (message.type === 'assistant' || message.type === 'user') entry.blocks = (message.message?.content ?? []).map?.(blockSummary) ?? null;
      if (message.type === 'system' && message.subtype === 'init') Object.assign(entry, { tools: message.tools, mcp_servers: message.mcp_servers,
        permissionMode: message.permissionMode, claude_code_version: message.claude_code_version ?? null });
      if (message.type === 'result') {
        Object.assign(entry, { is_error: message.is_error, stop_reason: message.stop_reason, terminal_reason: message.terminal_reason ?? null,
          deferred_tool_use: message.deferred_tool_use ?? null, num_turns: message.num_turns, result: message.result ?? null,
          permission_denials: message.permission_denials ?? null, errors: message.errors ?? null });
        out.result = entry;
        release();
      }
      if (out.sdk.length < 200) out.sdk.push(entry);
    }
  } catch (error) {
    out.queryError = String(error?.message ?? error).slice(0, 2000);
  } finally {
    clearTimeout(deadline);
    release();
  }
  // Give the CLI a moment to leave after its stdin closes, then report whether it did.
  for (let i = 0; i < 100 && out.cli.some((record) => record.exit === null); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  // The CLI's own account of each call, from its debug log, and the transcript it leaves for the next process.
  try {
    out.debugLines = readFileSync(join(HOME, `debug-${scenario}-${number}.log`), 'utf8').split('\n')
      .filter((line) => /defer|orphan|solo|PreToolUse|sibling/i.test(line))
      .map((line) => line.replace(/Bearer [0-9a-f]+/g, 'Bearer <redacted>').slice(0, 400)).slice(0, 80);
  } catch (error) { out.debugLines = [`unreadable: ${error.code}`]; }
  if (out.result?.session_id) {
    const files = readdirSync(join(CONFIG, 'projects'), { recursive: true }).filter((file) => file.endsWith(`${out.result.session_id}.jsonl`));
    out.transcript = files.length !== 1 ? { files: files.length } : readFileSync(join(CONFIG, 'projects', files[0]), 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line)).map((entry) => ({ type: entry.type, uuid: entry.uuid ?? null, parentUuid: entry.parentUuid ?? null,
        role: entry.message?.role ?? null, blocks: Array.isArray(entry.message?.content) ? entry.message.content.map((block) => ({
          type: block.type, id: block.id ?? block.tool_use_id ?? null })) : null,
        attachment: entry.attachment ? { type: entry.attachment.type, toolUseID: entry.attachment.toolUseID ?? null } : null }));
  }
  if (number === '1' && out.result?.deferred_tool_use) {
    writeFileSync(statePath, JSON.stringify({ sessionId: out.result.session_id, deferred: out.result.deferred_tool_use }));
  }
  out.mcpPort = Number(host.split(':')[1]);
  await transport.close().catch(() => {});
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
