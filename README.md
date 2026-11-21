# Switchboard

**One honest TypeScript interface to the coding agents you already use, that reports what it observed and never what it hoped.**

Claude, Codex, Cursor, and Pi each have their own SDK, their own event shapes, and their own idea of what a "session" is. Switchboard puts a small, strict, dependency-free layer in front of them. It gives you typed adapter contracts, session references you can validate, bounded event streams, an AG-UI projection for your frontend, and OpenTelemetry GenAI spans for your tracing backend.

> **Status:** a private, pre-release package (`@operatorworks/switchboard@0.0.0`, `"private": true`). It is not published to npm. Node `>=24.22.3 <25`, ESM only. The Claude and Codex adapters are explicitly **unqualified**, and the Pi adapter still needs separate live provider qualification. See [Honest status](#honest-status).

## What makes it different

Most "unify all the agents" libraries try to hide the differences between engines. Switchboard takes the opposite stance: **the differences are facts, so record them and don't paper over them.**

- **Observed facts, not guesses.** Spans and AG-UI events come from things the library actually saw at a native boundary. A model request is a model span only if it was individually observed. Native dispatch phases, RPC requests, and AG-UI chunks don't count as evidence of one. If an engine can't supply evidence for something, the baseline reports that family as `unsupported` instead of inventing it, and every family stays `unqualified` until it has been qualified.
- **Every adapter is qualified separately, and says so.** There is no blanket "supports agents" claim. Claude, Codex, and Pi each have their own selection and qualification notes under [`docs/qualification/`](docs/qualification/) and an exact pinned peer version; Cursor has a recorded live run; the host adapters track what they have and haven't proved in the [host adapter contract](docs/architecture/host-adapter-contract.md). Each states what has and hasn't been exercised against the real thing.
- **Zero runtime dependencies.** The package declares none. Every engine SDK (`@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`, `@cursor/sdk`, the Pi packages), plus `@ag-ui/core` and `@opentelemetry/api`, is an *optional peer* pinned to an exact version. You install only the ones you use, and the root entry loads none of them.
- **Pinned everything.** Development and CI use Node 24.22.3 and npm 11.19.1 (consumers get the range `>=24.22.3 <25`), with TypeScript 7.0.2, Oxlint 1.93.0, and exact peer versions. Importing an engine adapter without its peer fails loudly with `ERR_MODULE_NOT_FOUND`, and forcing a different peer version is outside the contract.
- **Bounded by construction.** Event streams have fixed observer and queue capacity, and a slow observer gets disconnected instead of growing memory. Every engine runtime caps concurrent sessions or turns at 32. Admission deadlines are explicit, and readiness probes escalate from SIGTERM to SIGKILL instead of hanging.
- **Uncertainty is a first-class state.** When a `start()` fails after the native process may have received the prompt, the docs say so: treat it as *uncertain* and don't auto-retry. Readiness reports distinguish `blocked` (a failure was positively observed) from `unverified` (nothing was observed), and `timed_out` or `unknown` is never silently promoted to "ok" or "not signed in".
- **Your host owns the dangerous parts.** Switchboard does not authenticate native tokens, authorize access, persist replay, or set up your telemetry SDK. Pass `contentPolicy: { kind: 'none' }` and spans stay metadata-only. The boundaries are written down in [Architecture boundaries](docs/architecture/boundaries.md).
- **Tests that refuse to touch the real world.** `npm test` runs behind a native-SDK tripwire. The Codex spike suites can also be rerun under a guard that refuses real subprocess and network use. See [guarded Codex tests](docs/qualification/codex-guarded-tests.md).

## The shape of it

```text
  Claude · Codex · Cursor · Pi · host/codex · host/pi · host/opencode
        │  native SDKs and CLIs, each behind its own subpath adapter
        ▼
  RunObservation   (text · reasoning · tool · usage · model boundary · terminal)
        │  taken at the native branch through an optional onObservation listener
        ▼
  createRunBaseline (/baseline)
        ├──►  AG-UI 1.0 events      (/agui,          peer @ag-ui/core)
        └──►  OpenTelemetry spans   (/observability, peer @opentelemetry/api)

  root module: adapter contracts · session envelopes · validation helpers · bounded event streams
  /testkit:    reusable qualification groups and a reference fake
```

Families with no native evidence come out as `unsupported`, not invented. Observations can carry tool arguments, results, and reasoning text that the public callbacks omit, so your host owns their publication; span content still follows your `contentPolicy`.

## What's in the box

Everything is a subpath export of one package. Import only what you need.

| Entry | What it gives you | Optional peer (exact version) |
|---|---|---|
| `@operatorworks/switchboard` | Adapter contracts, native session envelopes, `parseSessionReference` / `parseCheckpointReference`, session-discovery bounds, and `createEventStream` | none |
| `/agui` | Projection of observed facts into pinned AG-UI 1.0 output | `@ag-ui/core@1.0.4` |
| `/observability` | Records observed agent, model-request, and tool boundaries as OpenTelemetry GenAI spans | `@opentelemetry/api@1.9.0` |
| `/baseline` | `createRunBaseline`: feed it a segment's `RunObservation`s and get AG-UI events and GenAI spans from the same evidence | both of the above |
| `/testkit` | Reusable qualification `contracts` and a reference `createFakeFixture` | none |
| `/pi` | `createPiRuntime`: text-only Pi SDK sessions on OpenCode Go (caller supplies the model id) | `@earendil-works/pi-ai@1.5.2`, `@earendil-works/pi-coding-agent@1.5.2` |
| `/codex` | `createCodexRuntime`: text chat over a ChatGPT subscription via the Codex CLI | `@openai/codex-sdk@0.169.0` (and Codex CLI 0.169.0 on `PATH`) |
| `/claude` | `createClaudeRuntime`: text-only Claude Agent SDK runtime | `@anthropic-ai/claude-agent-sdk@0.3.323` |
| `/cursor` | `createCursorRuntime`: a local Cursor coding agent | `@cursor/sdk@1.4.2` |
| `/host/pi`, `/host/codex`, `/host/opencode` | Host-adapter entries. For example, `/host/opencode` drives one local `opencode acp` process that your host spawns | see [host adapter contract](docs/architecture/host-adapter-contract.md) |

Every engine runtime also exposes `readinessReport()`, which records installation, version, authentication, and workspace as four separate facts, and marks a fact `unsupported` when the adapter has no way to observe it. The result is a `ready`, `blocked`, or `unverified` verdict with a fixed-text remediation code. Only Codex can reach `ready`; Claude, Cursor, and Pi cannot observe everything `ready` requires, so they report only `blocked` or `unverified`. It never installs, signs in, or calls a model.

Tool access differs per engine: Pi and Claude run text-only with tools disabled, Codex disables shell and web search but other native tools may remain available, and Cursor runs a sandboxed coding agent whose sandbox confines shell but not `webSearch`, `webFetch`, or MCP. The exact disabled tools, sandbox behavior, and caveats for each engine are in the [reference](docs/reference.md) and the [qualification notes](docs/qualification/).

## Quick start

> The package is private and unpublished, so for now you work from a clone (see [Development](#development)). Imports below show the intended public specifiers.

**Talk to a model through Pi** (install the two exact Pi peers first):

```js
import { createPiRuntime } from '@operatorworks/switchboard/pi';

const runtime = await createPiRuntime({
	cwd: process.cwd(),
	sessionDirectory: '/absolute/path/to/app-owned-sessions',
	apiKey: process.env.OPENCODE_API_KEY,
	provider: 'opencode-go',
	model: 'glm-5.3', // caller-supplied; the library never picks a model for you
});
const session = await runtime.open();
let answer = '';
const accepted = await session.prompt('Hello', event => {
	if (event.kind === 'text') answer = event.text; // each event carries the full text so far
});
await accepted.finished; // completed, interrupted, or failed
process.stdout.write(answer);
await runtime.close();
```

An id missing from the bundled offline catalog is rejected. Save `session.id` and `session.sessionFile` after the first `prompt()` resolves if you want to resume with `runtime.open({ sessionFile })`.

**Check your own adapter against the contracts** with the testkit, which registers nothing on import:

```js
import test from 'node:test';
import { contracts, createFakeFixture } from '@operatorworks/switchboard/testkit';

for (const [name, contract] of Object.entries(contracts)) {
	test(name, { timeout: 10_000 }, (t) => contract(createFakeFixture, t.signal));
}
```

These controlled checks do not qualify native engines, credentials, or durable host admission.

**Hold several engines in one place** with the shared readiness types:

```ts
import type { ReadinessReport, ReadinessSource } from '@operatorworks/switchboard';

async function providerRows(sources: Record<string, ReadinessSource>, signal: AbortSignal) {
	return Promise.all(Object.entries(sources).map(async ([name, runtime]) => {
		const report: ReadinessReport = await runtime.readinessReport({ signal });
		if (report.verdict === 'ready') return { name, status: 'Ready', at: report.observedAt };
		return { name, status: report.remediation.message, code: report.remediation.code, at: report.observedAt };
	}));
}
```

For the Codex, Claude, and Cursor runtimes, the options and the uncertain-dispatch rules (persist `threadId`, never resubmit after an uncertain start) are documented in the [reference](docs/reference.md). They share a similar shape: an absolute working directory, a caller-supplied model id, and `start({ text, onEvent })`, plus per-engine fields such as `threadId` or `agentId`.

## Honest status

- **Private and pre-release.** `0.0.0`, `"private": true`. This is a foundation, not a released library.
- **Claude and Codex adapters are unqualified.** Per the project's own docs, they have not been qualified as native integrations.
- **Pi** has local SDK tests with provider HTTP stubbed. A live subscription still needs separate qualification.
- **Cursor and the host adapters** make no native-qualification claim in this README. Treat them as unqualified too unless their [qualification notes](docs/qualification/) say otherwise.
- **Controlled checks are not native qualification.** The testkit, fixture CLIs, and the package tests do not qualify native engines, credentials, or direct or LiteLLM routes.
- **Live checks exist but are opt-in.** `npm run test:live-baseline` runs one real turn per engine you select, with its own env gates, and it spends provider credit. CI does not run it.
- **TypeScript consumers need `@types/node`**, because public cancellation contracts use `AbortSignal`.

## Development

Use Node 24.22.3 and npm 11.19.1.

```sh
npm ci
npm run lint    # Oxlint
npm run check   # strict tsc, no emit (core plus each adapter project)
npm test        # node:test over tests/**/*.test.mjs, behind the native-SDK tripwire
npm run build   # clean + compile everything into dist/
```

A few things worth knowing:

- `npm test` includes package verification: it rebuilds, packs, and installs the tarball into a temporary consumer, then checks public types, runtime helpers, blocked private imports, and package contents.
- `npm run test:codex-guarded` reruns the Codex spike suites under a guard that refuses real subprocess and network use.
- `npm run test:live-baseline` is the opt-in live check. Use `SWITCHBOARD_LIVE_DRY_RUN=1` to preview what would run without a model call.
- `npm run verify:agui` checks the AG-UI projection against checksum-pinned canonical schemas. It needs uv 0.11.3, Python 3.13.12, and initial registry/GitHub access.
- CI runs the same checks on Ubuntu 24.04 with Node 24.22.3, `npm ci`, immutable action commits, and read-only repository access.

### Where to read more

- [Reference](docs/reference.md): the full contract notes for every entry, adapter, readiness code, and live-baseline gate
- [Architecture boundaries](docs/architecture/boundaries.md): host responsibilities, source ownership, event delivery
- [Host adapter contract](docs/architecture/host-adapter-contract.md)
- [AG-UI protocol notes](docs/protocol/ag-ui.md) and the matrix and dispositions under [`docs/protocol/`](docs/protocol/)
- [Record observed agent work](docs/observability/usage.md) and [validate telemetry destinations](docs/observability/validation.md)
- [Qualification notes](docs/qualification/), including the [AG-UI fork reuse record](docs/qualification/ag-ui-fork-reuse.md)
- [Guarded Codex tests](docs/qualification/codex-guarded-tests.md)

## License

[MIT](LICENSE). Bundled third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
