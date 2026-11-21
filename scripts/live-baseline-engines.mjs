// Pure engine selection for scripts/live-baseline.mjs. Imports nothing, so tests can load it under the native SDK
// tripwire and the live script can resolve its plan before loading any adapter.

/**
 * One row per engine. A turn runs only when its `gate` (or SWITCHBOARD_LIVE_ALL) is on (see `enabled`); a credential in the
 * environment never selects an engine. Each default is the lowest listed paid input+output price for its provider,
 * excluding free tiers, using a canonical (non-alias) id. `runtime` names the dispatch path in the live script.
 * `confirmation` says how a live run proves the model that actually ran. `expect.modelSpans` is the evidence a passing run
 * must show: `some` model spans (claude, host/pi) or `none` (every other engine). `executable` names the variable that
 * holds an absolute host binary and, optionally, a command to find on PATH when the variable is unset.
 */
export const engines = Object.freeze([
  { name: 'claude', provider: 'claude', gate: 'SWITCHBOARD_LIVE_CLAUDE', credential: 'SWITCHBOARD_ANTHROPIC_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_CLAUDE_MODEL', defaultModel: 'claude-haiku-5-5', runtime: 'text',
    confirmation: 'adapter-enforced',
    expect: { modelSpans: 'some' } },
  { name: 'codex', provider: 'codex', gate: 'SWITCHBOARD_LIVE_CODEX', credential: undefined,
    modelVariable: 'SWITCHBOARD_LIVE_CODEX_MODEL', defaultModel: 'gpt-6-luna', runtime: 'text',
    confirmation: 'native-record',
    expect: { modelSpans: 'none' } },
  // Cursor.models.list lists no prices. Third-party models (gpt-5.4-nano, gemini-3-flash) failed live with "not
  // included in your weekly usage" on 2026-11-21, so the default is Cursor's own composer-2, which passed.
  { name: 'cursor', provider: 'cursor', gate: 'SWITCHBOARD_LIVE_CURSOR', credential: 'SWITCHBOARD_CURSOR_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_CURSOR_MODEL', defaultModel: 'composer-2', runtime: 'text',
    confirmation: 'request-only',
    expect: { modelSpans: 'none' } },
  // mimo-v2.5 is still in the bundled Pi catalog but OpenCode Go returns 410 ModelDeprecated (2026-11-21).
  { name: 'pi', provider: 'pi', gate: 'SWITCHBOARD_LIVE_PI', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_PI_MODEL', defaultModel: 'mimo-v2.6-flash', runtime: 'pi',
    confirmation: 'request-only',
    expect: { modelSpans: 'none' } },
  { name: 'host/pi', provider: 'pi', gate: 'SWITCHBOARD_LIVE_HOST_PI', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_HOST_PI_MODEL', defaultModel: 'mimo-v2.6-flash', runtime: 'host',
    // The pi-host adapter sends every request under its fixed `host` model id, so it cannot confirm the real model.
    confirmation: 'request-only',
    expect: { modelSpans: 'some' } },
  { name: 'host/codex', provider: 'codex', gate: 'SWITCHBOARD_LIVE_HOST_CODEX', credential: undefined,
    modelVariable: 'SWITCHBOARD_LIVE_HOST_CODEX_MODEL', defaultModel: 'gpt-6-luna', runtime: 'host',
    confirmation: 'native-record', executable: { variable: 'CODEX_BIN' },
    expect: { modelSpans: 'none' } },
  // OpenCode's stored login may be stale, so the run hands it the OpenCode Go key through OPENCODE_AUTH_CONTENT.
  { name: 'host/opencode', provider: 'opencode', gate: 'SWITCHBOARD_LIVE_HOST_OPENCODE', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_HOST_OPENCODE_MODEL', defaultModel: 'opencode-go/mimo-v2.6-flash', runtime: 'host',
    confirmation: 'adapter-enforced', executable: { variable: 'OPENCODE_BIN', command: 'opencode' },
    expect: { modelSpans: 'none' } },
].map((engine) => Object.freeze(engine)));

/** Captured into the script, then deleted from the environment before any adapter loads. */
export const credentialNames = Object.freeze(['SWITCHBOARD_ANTHROPIC_API_KEY', 'SWITCHBOARD_CURSOR_API_KEY', 'SWITCHBOARD_OPENCODE_API_KEY']);
/** Deleted without capture, so a stale ambient key can never reach a child process. */
export const ambientCredentialNames = Object.freeze(['ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'OPENCODE_API_KEY']);

const present = (env, name) => typeof env[name] === 'string' && env[name] !== '';
/** A gate is on only for `1`, `true`, `yes`, or `on` (trimmed, any case), so no other value starts paid turns. */
const enabled = (env, name) => present(env, name) && ['1', 'true', 'yes', 'on'].includes(env[name].trim().toLowerCase());

/** Gated engines in table order, or every engine when SWITCHBOARD_LIVE_ALL is set. */
export function selectEngines(env) {
  return enabled(env, 'SWITCHBOARD_LIVE_ALL') ? [...engines] : engines.filter((engine) => enabled(env, engine.gate));
}

/** Whether a dry run or live run treats SWITCHBOARD_LIVE_DRY_RUN as set. */
export function dryRunRequested(env) {
  return enabled(env, 'SWITCHBOARD_LIVE_DRY_RUN');
}

/**
 * Captures each `credentialNames` value and deletes it from `env`, then deletes every ambient provider key without
 * capturing it. Returns the captured values by name. `env` is mutated so no later child or adapter inherits a key.
 */
export function takeCredentials(env) {
  const captured = {};
  for (const name of credentialNames) {
    if (present(env, name)) captured[name] = env[name];
    delete env[name];
  }
  for (const name of ambientCredentialNames) delete env[name];
  return captured;
}

/** OpenCode's provider credential document for one OpenCode Go key, passed to the child as OPENCODE_AUTH_CONTENT. */
export function opencodeAuthContent(key) {
  return JSON.stringify({ 'opencode-go': { type: 'api', key } });
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
  line = line.replace(/Bearer\s+[^\s"',]+/giu, 'Bearer <redacted>').replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|crsr_[A-Za-z0-9_-]{16,})/gu, '<redacted>');
  if (home) line = line.split(home).join('~');
  line = line.split(/\r?\n/u)[0].trim();
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT - 1)}…` : line;
}
