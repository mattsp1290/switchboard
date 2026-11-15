import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeRuntimeOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly model: 'opus' | 'sonnet';
  readonly claudePathOverride?: string;
}
export type ClaudeTerminal = { readonly kind: 'ended'; readonly outcome: 'completed' | 'failed' | 'interrupted' };
export type ClaudeEvent = { readonly kind: 'text'; readonly itemId: string; readonly text: string } | ClaudeTerminal;
export interface ClaudeTurn {
  readonly threadId: string;
  readonly model: string;
  readonly finished: Promise<ClaudeTerminal>;
  abort(): Promise<void>;
}
export interface ClaudeRequest {
  readonly text: string;
  readonly threadId?: string;
  readonly onEvent: (event: ClaudeEvent) => void;
}
export interface ClaudeRuntime {
  checkReady(): Promise<void>;
  start(request: ClaudeRequest): Promise<ClaudeTurn>;
  close(): Promise<void>;
}

const failure = () => new Error('Claude operation failed.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const writers = new Set<string>();

export function createClaudeRuntime(options: ClaudeRuntimeOptions): ClaudeRuntime {
  if (!isAbsolute(options.cwd) || !isAbsolute(options.sessionDirectory) || !options.apiKey.trim()
    || (options.model !== 'opus' && options.model !== 'sonnet')
    || (options.claudePathOverride !== undefined && !isAbsolute(options.claudePathOverride))) throw failure();
  const cwd = resolve(options.cwd);
  const config = resolve(options.sessionDirectory);
  const env: Record<string, string> = { ANTHROPIC_API_KEY: options.apiKey, CLAUDE_CONFIG_DIR: config };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'SystemRoot']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const active = new Map<AbortController, Promise<ClaudeTerminal>>();
  const lostSessions = new Set<string>();
  let closed = false;
  async function checkReady(): Promise<void> {
    if (closed) throw failure();
    try {
      await access(cwd, constants.R_OK);
      await mkdir(config, { recursive: true, mode: 0o700 });
      await access(config, constants.R_OK | constants.W_OK);
      if (options.claudePathOverride !== undefined) await access(options.claudePathOverride, constants.X_OK);
    } catch { throw failure(); }
  }
  function start(request: ClaudeRequest): Promise<ClaudeTurn> {
    const { text, threadId: requested, onEvent } = request;
    if (closed || active.size >= 32 || typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text) > 1024 * 1024 || typeof onEvent !== 'function'
      || (requested !== undefined && (!uuid.test(requested) || writers.has(requested) || lostSessions.has(requested)))) return Promise.reject(failure());
    let reserved = requested;
    if (reserved) writers.add(reserved);
    const controller = new AbortController();
    const admission = Promise.withResolvers<ClaudeTurn>();
    let admitted = false;
    let fault = false;
    let stopping = false;
    controller.signal.addEventListener('abort', () => { if (!fault) stopping = true; });
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    const timeout = setTimeout(() => { fault = true; controller.abort(); }, 30_000);
    async function consume(): Promise<ClaudeTerminal> {
      let outcome: ClaudeTerminal['outcome'] = 'failed';
      let terminal: ClaudeTerminal['outcome'] | undefined;
      let native: ReturnType<typeof query> | undefined;
      try {
        await checkReady();
        controller.signal.throwIfAborted();
        native = query({ prompt: text, options: {
          cwd, env, model: options.model, abortController: controller, tools: [], settingSources: [],
          mcpServers: {}, strictMcpConfig: true, permissionMode: 'dontAsk', verbatimPrompts: true,
          persistSession: true, includePartialMessages: true, extraArgs: { bare: null }, ...(requested ? { resume: requested } : {}),
          ...(options.claudePathOverride ? { pathToClaudeCodeExecutable: options.claudePathOverride } : {}),
          spawnClaudeCodeProcess(spawnOptions) {
            const running = spawn(spawnOptions.command, spawnOptions.args, {
              cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ['pipe', 'pipe', 'ignore'],
            });
            child = running;
            running.stdin.on('error', () => {});
            exited = new Promise(resolveExit => {
              running.once('exit', () => resolveExit());
              running.once('error', () => resolveExit());
            });
            return running;
          },
        } });
        let session: { id: string; model: string } | undefined;
        let streamId: string | undefined;
        const streamed = new Set<string>();
        const blocks = new Map<number, string>();
        function admit(): void {
          if (!session || admitted) return;
          admitted = true;
          clearTimeout(timeout);
          admission.resolve({ threadId: session.id, model: session.model, finished,
            async abort() { stopping = true; controller.abort(); native?.close(); await finished; } });
        }
        function publish(id: string, snapshot: string): void {
          if (Buffer.byteLength(snapshot) > 4 * 1024 * 1024) throw failure();
          onEvent({ kind: 'text', itemId: id, text: snapshot });
        }
        const snapshots = new Map<string, string>();
        for await (const message of native) {
          if (controller.signal.aborted) continue;
          if (message.type === 'system' && message.subtype === 'session_writes_lost'
            && session && message.lost.includes('transcript') && message.transcript_session_ids?.includes(session.id)) {
            lostSessions.add(session.id);
            fault = true;
            continue;
          }
          if (terminal) {
            if (message.type === 'system' && message.subtype !== 'init') continue;
            throw failure();
          }
          if (message.type === 'system' && message.subtype === 'init') {
            if (session || !uuid.test(message.session_id) || (requested && message.session_id !== requested)
              || (!requested && writers.has(message.session_id)) || message.apiKeySource !== 'ANTHROPIC_API_KEY'
              || !message.model.toLowerCase().includes(options.model) || message.tools.length || message.mcp_servers.length) throw failure();
            reserved = message.session_id;
            writers.add(reserved);
            session = { id: message.session_id, model: message.model };
          } else if (message.type === 'stream_event') {
            if (!session || message.session_id !== session.id || message.parent_tool_use_id !== null) throw failure();
            const event = message.event;
            if (event.type === 'message_start') {
              if (!event.message.id || event.message.id.length > 512
                || !event.message.model.toLowerCase().includes(options.model)) throw failure();
              session.model = event.message.model;
              streamId = event.message.id;
              streamed.add(streamId);
              blocks.clear();
              admit();
            } else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
              if (!streamId) throw failure();
              blocks.set(event.index, event.content_block.text);
              if (event.content_block.text) publish(`${streamId}:${event.index}`, event.content_block.text);
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              if (!streamId || !blocks.has(event.index)) throw failure();
              const snapshot = (blocks.get(event.index) ?? '') + event.delta.text;
              blocks.set(event.index, snapshot);
              publish(`${streamId}:${event.index}`, snapshot);
            }
          } else if (message.type === 'assistant') {
            if (!session || message.session_id !== session.id || message.error || message.parent_tool_use_id !== null) throw failure();
            if (!message.message.model.toLowerCase().includes(options.model)) throw failure();
            if (!admitted) session.model = message.message.model;
            else if (session.model !== message.message.model) throw failure();
            admit();
            const id = message.message.id;
            if (!id || id.length > 512) throw failure();
            if (streamed.has(id)) continue;
            for (const block of message.message.content) {
              if (block.type !== 'text') continue;
              const snapshot = (snapshots.get(id) ?? '') + block.text;
              snapshots.set(id, snapshot);
              publish(id, snapshot);
            }
          } else if (message.type === 'result') {
            if (!session || message.session_id !== session.id) throw failure();
            terminal = message.subtype === 'success' && !message.is_error ? 'completed' : 'failed';
          }
        }
        outcome = terminal ?? 'failed';
      } catch { fault = !stopping; }
      finally {
        clearTimeout(timeout);
        native?.close();
        const exitedNaturally = child !== undefined && (child.exitCode !== null || child.signalCode !== null);
        if (exitedNaturally && child?.exitCode !== 0 && !stopping) fault = true;
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          const force = setTimeout(() => child?.kill('SIGKILL'), 1_000);
          await exited;
          clearTimeout(force);
        } else if (exited) await exited;
        if (reserved) writers.delete(reserved);
        active.delete(controller);
      }
      if (fault) outcome = 'failed';
      else if (terminal) outcome = terminal;
      else if (stopping) outcome = 'interrupted';
      const end: ClaudeTerminal = { kind: 'ended', outcome };
      if (admitted) { try { onEvent(end); } catch {} } else admission.reject(failure());
      return end;
    }
    const finished = consume();
    active.set(controller, finished);
    return admission.promise;
  }
  return { checkReady, start, async close() {
    closed = true;
    const pending = [...active.entries()];
    for (const [controller] of pending) controller.abort();
    await Promise.allSettled(pending.map(([, finished]) => finished));
  } };
}
