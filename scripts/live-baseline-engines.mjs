// Pure engine selection for scripts/live-baseline.mjs. Imports nothing, so tests can load it under the native SDK
// tripwire and the live script can resolve its plan before loading any adapter.

/**
 * One row per engine. A turn runs only when its `gate` (or SWITCHBOARD_LIVE_ALL) is non-empty; a credential in the
 * environment never selects an engine. Each default is the lowest listed paid input+output price for its provider,
 * excluding free tiers, using a canonical (non-alias) id. `runtime` names the dispatch path in the live script.
 * `confirmation` says how a live run proves the model that actually ran.
 */
export const engines = Object.freeze([
  { name: 'claude', provider: 'claude', gate: 'SWITCHBOARD_LIVE_CLAUDE', credential: 'SWITCHBOARD_ANTHROPIC_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_CLAUDE_MODEL', defaultModel: 'claude-haiku-5-5', runtime: 'text',
    confirmation: 'adapter-enforced' },
  { name: 'codex', provider: 'codex', gate: 'SWITCHBOARD_LIVE_CODEX', credential: undefined,
    modelVariable: 'SWITCHBOARD_LIVE_CODEX_MODEL', defaultModel: 'gpt-6-luna', runtime: 'text',
    confirmation: 'native-record' },
  // Cursor.models.list lists no prices. Third-party models (gpt-5.4-nano, gemini-3-flash) failed live with "not
  // included in your weekly usage" on 2026-11-21, so the default is Cursor's own composer-2, which passed.
  { name: 'cursor', provider: 'cursor', gate: 'SWITCHBOARD_LIVE_CURSOR', credential: 'SWITCHBOARD_CURSOR_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_CURSOR_MODEL', defaultModel: 'composer-2', runtime: 'text',
    confirmation: 'request-only' },
  // mimo-v2.5 is still in the bundled Pi catalog but OpenCode Go returns 410 ModelDeprecated (2026-11-21).
  { name: 'pi', provider: 'pi', gate: 'SWITCHBOARD_LIVE_PI', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_PI_MODEL', defaultModel: 'mimo-v2.6-flash', runtime: 'pi',
    confirmation: 'request-only' },
  { name: 'host/pi', provider: 'pi', gate: 'SWITCHBOARD_LIVE_HOST_PI', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_HOST_PI_MODEL', defaultModel: 'mimo-v2.6-flash', runtime: 'host',
    confirmation: 'adapter-enforced' },
  { name: 'host/codex', provider: 'codex', gate: 'SWITCHBOARD_LIVE_HOST_CODEX', credential: undefined,
    modelVariable: 'SWITCHBOARD_LIVE_HOST_CODEX_MODEL', defaultModel: 'gpt-6-luna', runtime: 'host',
    confirmation: 'native-record' },
  // OpenCode's stored login may be stale, so the run hands it the OpenCode Go key through OPENCODE_AUTH_CONTENT.
  { name: 'host/opencode', provider: 'opencode', gate: 'SWITCHBOARD_LIVE_OPENCODE', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_OPENCODE_MODEL', defaultModel: 'opencode-go/mimo-v2.6-flash', runtime: 'host',
    confirmation: 'adapter-enforced' },
].map((engine) => Object.freeze(engine)));

/** Captured into the script, then deleted from the environment before any adapter loads. */
export const credentialNames = Object.freeze(['SWITCHBOARD_ANTHROPIC_API_KEY', 'SWITCHBOARD_CURSOR_API_KEY', 'SWITCHBOARD_OPENCODE_API_KEY']);
/** Deleted without capture, so a stale ambient key can never reach a child process. */
export const ambientCredentialNames = Object.freeze(['ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'OPENCODE_API_KEY']);

const present = (env, name) => typeof env[name] === 'string' && env[name] !== '';

/** Gated engines in table order, or every engine when SWITCHBOARD_LIVE_ALL is set. */
export function selectEngines(env) {
  return present(env, 'SWITCHBOARD_LIVE_ALL') ? [...engines] : engines.filter((engine) => present(env, engine.gate));
}

/** The engine's model override, or its cheap default. */
export function resolveModel(engine, env) {
  return present(env, engine.modelVariable) ? env[engine.modelVariable] : engine.defaultModel;
}

/**
 * Extra app-server argv for `host/codex`, appended after the adapter's own arguments by the host-owned spawn. The
 * direct route sends no model or effort, so these override the operator's config.toml defaults for this run only.
 * The adapter admits a requester only when the host gives the process a private `sqlite_home` and `log_dir` outside
 * the Codex home (src/adapters/codex/sessions.ts), so the run's history never touches the operator's.
 */
export function codexHostArgs(model, { sqliteHome, logDir }) {
  return ['-c', `model=${JSON.stringify(model)}`, '-c', 'model_reasoning_effort="low"',
    '-c', `sqlite_home=${JSON.stringify(sqliteHome)}`, '-c', `log_dir=${JSON.stringify(logDir)}`];
}

const REASON_LIMIT = 200;
/**
 * One redacted line describing a failure: secrets (exact values, then bearer and sk- shaped tokens) become
 * `<redacted>`, the home directory becomes `~`, only the first line is kept, and the result is at most 200 characters.
 */
export function formatReason(text, secrets, home) {
  let line = String(text ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) line = line.split(secret).join('<redacted>');
  line = line.replace(/Bearer\s+[^\s"',]+/giu, 'Bearer <redacted>').replace(/\b(?:sk|key|crsr)[-_][A-Za-z0-9_-]{8,}/gu, '<redacted>');
  if (home) line = line.split(home).join('~');
  line = line.split(/\r?\n/u)[0].trim();
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT - 1)}…` : line;
}
