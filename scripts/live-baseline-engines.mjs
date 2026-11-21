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
  // Cursor.models.list (2026-11-21) carried no tier descriptions; Nano is the only name marked as the smallest tier.
  { name: 'cursor', provider: 'cursor', gate: 'SWITCHBOARD_LIVE_CURSOR', credential: 'SWITCHBOARD_CURSOR_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_CURSOR_MODEL', defaultModel: 'gpt-5.4-nano', runtime: 'text',
    confirmation: 'request-only' },
  { name: 'pi', provider: 'pi', gate: 'SWITCHBOARD_LIVE_PI', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_PI_MODEL', defaultModel: 'mimo-v2.5', runtime: 'pi',
    confirmation: 'request-only' },
  { name: 'host/pi', provider: 'pi', gate: 'SWITCHBOARD_LIVE_HOST_PI', credential: 'SWITCHBOARD_OPENCODE_API_KEY',
    modelVariable: 'SWITCHBOARD_LIVE_HOST_PI_MODEL', defaultModel: 'mimo-v2.5', runtime: 'host',
    confirmation: 'adapter-enforced' },
  { name: 'host/codex', provider: 'codex', gate: 'SWITCHBOARD_LIVE_HOST_CODEX', credential: undefined,
    modelVariable: 'SWITCHBOARD_LIVE_HOST_CODEX_MODEL', defaultModel: 'gpt-6-luna', runtime: 'host',
    confirmation: 'native-record' },
  { name: 'host/opencode', provider: 'opencode', gate: 'SWITCHBOARD_LIVE_OPENCODE', credential: undefined,
    modelVariable: 'SWITCHBOARD_LIVE_OPENCODE_MODEL', defaultModel: 'opencode-go/mimo-v2.5', runtime: 'host',
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
 */
export function codexHostArgs(model) {
  return ['-c', `model=${JSON.stringify(model)}`, '-c', 'model_reasoning_effort="low"'];
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
