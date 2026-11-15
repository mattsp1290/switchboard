import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Codex } from '@openai/codex-sdk';
import { withSdkProcess } from './process.js';
import type { ThreadOptions } from '@openai/codex-sdk';

export interface CodexRuntimeOptions {
  readonly cwd: string;
  readonly model: 'gpt-6.1-sol';
  readonly codexHome?: string;
  readonly codexPathOverride?: string;
}
export interface CodexTerminal {
  readonly kind: 'ended';
  readonly outcome: 'completed' | 'failed' | 'interrupted';
}
export type CodexEvent = { readonly kind: 'text'; readonly itemId: string; readonly text: string } | CodexTerminal;
export interface CodexTurn {
  readonly threadId: string;
  readonly finished: Promise<CodexTerminal>;
  abort(): Promise<void>;
}
export interface CodexRequest {
  readonly text: string;
  readonly threadId?: string;
  readonly onEvent: (event: CodexEvent) => void;
}
export interface CodexRuntime {
  checkReady(): Promise<void>;
  start(request: CodexRequest): Promise<CodexTurn>;
  close(): Promise<void>;
}

const run = promisify(execFile);
const writers = new Set<string>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = () => new Error('Codex operation failed.');

function nativeEnvironment(codexHome: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'USERPROFILE', 'SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'CODEX_HOME']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  return env;
}

export function createCodexRuntime(options: CodexRuntimeOptions): CodexRuntime {
  if (options.model !== 'gpt-6.1-sol' || !isAbsolute(options.cwd)
    || (options.codexHome !== undefined && !isAbsolute(options.codexHome))) throw failure();
  const cwd = resolve(options.cwd);
  const executable = options.codexPathOverride ?? 'codex';
  const env = nativeEnvironment(options.codexHome);
  async function checkReady(signal?: AbortSignal): Promise<void> {
    if (closed) throw failure();
    const check = { env, cwd, signal, timeout: 10_000, maxBuffer: 16_384, encoding: 'utf8' } as const;
    try {
      const version = await run(executable, ['--version'], check);
      if (version.stdout.trim() !== 'codex-cli 0.169.0') throw failure();
    } catch { throw new Error('Install Codex CLI 0.169.0 to use Codex chat.'); }
    // Enforcing a mismatched forced_login_method in exec can log the user out.
    try {
      const login = await run(executable, ['login', 'status'], check);
      if (login.stderr.trim() !== 'Logged in using ChatGPT') throw failure();
    } catch { throw new Error('Sign in with ChatGPT using codex login to use Codex chat.'); }
  }

  async function disableMcpServers(signal: AbortSignal): Promise<string> {
    // An empty CLI config table merges with the user's servers. Disable each server by name.
    const { stdout } = await run(executable, ['mcp', 'list', '--json'], {
      env, cwd, signal, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    });
    const servers: unknown = JSON.parse(stdout);
    if (!Array.isArray(servers) || servers.length > 512) throw failure();
    const disabled = servers.map((server: unknown) => {
      if (!server || typeof server !== 'object' || !('name' in server)
        || typeof server.name !== 'string' || !server.name || server.name.length > 256) throw failure();
      return JSON.stringify(server.name) + '={enabled=false}';
    });
    return 'mcp_servers={' + disabled.join(',') + '}';
  }

  const threadOptions: ThreadOptions = {
    model: options.model, modelReasoningEffort: 'low', workingDirectory: cwd,
    sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false,
    webSearchMode: 'disabled', skipGitRepoCheck: true,
  };
  const active = new Map<AbortController, Promise<CodexTerminal>>();
  let closed = false;

  function start(request: CodexRequest): Promise<CodexTurn> {
    const { threadId: requested, text, onEvent } = request;
    if (closed || active.size >= 32 || typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text) > 1024 * 1024 || typeof onEvent !== 'function'
      || (requested !== undefined && (!uuid.test(requested) || writers.has(requested)))) return Promise.reject(failure());
    let reserved = requested;
    if (reserved !== undefined) writers.add(reserved);
    const controller = new AbortController();
    const admission = Promise.withResolvers<CodexTurn>();
    let admitted = false;
    let streamFault = false;

    async function consume(): Promise<CodexTerminal> {
      let outcome: CodexTerminal['outcome'] = 'failed';
      try {
        await checkReady(controller.signal);
        controller.signal.throwIfAborted();
        const sdk = new Codex({
          codexPathOverride: executable, env, configOverrides: [await disableMcpServers(controller.signal)],
          config: {
            forced_login_method: 'chatgpt', model_provider: 'openai',
            chatgpt_base_url: 'https://chatgpt.com/backend-api', openai_base_url: 'https://chatgpt.com/backend-api/codex',
            project_doc_max_bytes: 0,
            features: { shell_tool: false, unified_exec: false, apps: false, plugins: false, hooks: false,
              js_repl: false, image_generation: false, multi_agent_v2: false, skip_host_skill_discovery: true },
          },
        });
        const thread = requested === undefined ? sdk.startThread(threadOptions) : sdk.resumeThread(requested, threadOptions);
        const { events } = await thread.runStreamed(text, { signal: controller.signal });
        let observedId: string | undefined;
        let terminal: CodexTerminal['outcome'] | undefined;
        await withSdkProcess(controller.signal, async () => {
          for await (const event of events) {
            if (controller.signal.aborted) continue;
            try {
              if (terminal !== undefined) throw failure();
              switch (event.type) {
                case 'thread.started': {
                  const id = event.thread_id;
                  if (typeof id !== 'string' || !uuid.test(id) || observedId !== undefined
                    || (requested !== undefined ? id !== requested : writers.has(id))) throw failure();
                  observedId = id;
                  reserved = id;
                  writers.add(id);
                  break;
                }
                case 'turn.started':
                  if (observedId === undefined || admitted) throw failure();
                  admitted = true;
                  admission.resolve({ threadId: observedId, finished, async abort() { controller.abort(); await finished; } });
                  break;
                case 'item.started':
                case 'item.updated':
                case 'item.completed': {
                  if (event.item.type === 'agent_message') {
                    if (!admitted) throw failure();
                    const { id, text: snapshot } = event.item;
                    if (typeof id !== 'string' || !id || id.length > 512 || typeof snapshot !== 'string'
                      || Buffer.byteLength(snapshot) > 4 * 1024 * 1024) throw failure();
                    onEvent({ kind: 'text', itemId: id, text: snapshot });
                  }
                  break;
                }
                case 'turn.completed':
                  if (!admitted) throw failure();
                  terminal = 'completed';
                  break;
                case 'turn.failed':
                case 'error':
                  terminal = 'failed';
                  break;
              }
            } catch {
              streamFault = true;
              controller.abort();
            }
          }
        });
        outcome = terminal ?? 'failed';
      } catch {
        outcome = 'failed';
      } finally {
        if (streamFault) outcome = 'failed';
        else if (controller.signal.aborted && outcome !== 'completed') outcome = 'interrupted';
        if (reserved !== undefined) writers.delete(reserved);
        active.delete(controller);
      }
      const end: CodexTerminal = { kind: 'ended', outcome };
      if (admitted) {
        try { onEvent(end); } catch { /* A consumer exception cannot change the native outcome. */ }
      } else admission.reject(failure());
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
    await Promise.all(pending.map(([, finished]) => finished));
  } };
}
