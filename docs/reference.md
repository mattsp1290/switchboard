# Switchboard reference

The detailed contract notes for every Switchboard entry, adapter, and development check. Start with the [README](../README.md) for an overview.

Switchboard is a Node-hosted TypeScript library for native agent interfaces and adapters.
This foundation contains one private ESM package, `@operatorworks/switchboard@0.0.0`.
Its root module exports adapter contracts, native session envelopes, validation helpers, and bounded event streams.
The optional `./agui` entry projects observed facts into pinned AG-UI 1.0 output.
The optional `./pi` entry runs text-only Pi SDK sessions on OpenCode Go. The caller supplies the model id. The provider remains OpenCode Go, and an id missing from the bundled offline catalog is rejected.
Claude and Codex adapters remain unqualified. The Pi entry has local SDK tests and requires separate live provider qualification.
The optional `./observability` entry records observed agent, model-request, and tool boundaries as OpenTelemetry GenAI spans.

Use Node 24.22.3 and npm 11.19.1. The package supports Node `>=24.22.3 <25`.
Development dependencies pin TypeScript 7.0.2, Oxlint 1.93.0, and `@types/node` 24.19.2. There are no runtime dependencies.

Install and verify the foundation with these commands:

```sh
npm ci
npm run lint
npm run check
npm test
```

`lint` checks JavaScript and TypeScript with Oxlint. `check` runs the strict TypeScript compiler without emitting files.
`test` runs Node's built-in test runner over `tests/**/*.test.mjs`, including nested test directories.
The package test runs `verify:package`, which rebuilds, packs, and installs the tarball in a temporary consumer.
It checks public contract types, installed runtime helpers, blocked private imports, and package contents.
The `tests/core/*.test.ts` fixtures compile against the installed tarball and are never executed.
The `tests/core/*.consumer.mjs` fixtures run with `node --test` inside that installed consumer.
Core source and consumer compilation use ES2022 and Node declarations without DOM libraries.
The isolated Pi source project uses ES2024 and skips vendor declaration checks for Pi 1.5.2.
Core compilation keeps vendor declaration checks enabled.
The script removes its temporary files on success or failure.
`npm run test:codex-guarded` reruns the three Codex spike suites under a guard that refuses real subprocess and network use; see [guarded Codex tests](qualification/codex-guarded-tests.md).
Run `npm run build` to compile separately. The build removes `dist` before compilation. `npm run clean` removes the local build.

GitHub Actions runs the same checks on Ubuntu 24.04 with Node 24.22.3 and npm 11.19.1.
The workflow uses `npm ci`, immutable action commits, and read-only repository access.
It also runs `npm run verify:agui` against checksum-pinned canonical schema fixtures and published Python and TypeScript SDKs.
That repository development check requires uv 0.11.3, Python 3.13.12, and initial registry/GitHub access.
Its SDK environments are temporary. It adds no package dependencies or native qualification claims.
The protocol matrix, exact per-definition dispositions, and validation differences are recorded under `docs/protocol/`.
Installed verification requires actual projection output for all 28 explicit event kinds and five child terminal variants.
Three canonical chunk kinds normalize to explicit stream events. Input and capability declarations do not create output events.

The intended import is `import type { AdapterRegistration, Capability } from '@operatorworks/switchboard'`.
The separate `@operatorworks/switchboard/agui` entry requires the exact optional peer `@ag-ui/core@1.0.4`.
Repository development and the installed-consumer checks in `npm run verify:package` use the immutable core archive from owned [AG-UI PR 49](https://github.com/mattsp1290/ag-ui/pull/49).
That archive is byte-identical to registry `@ag-ui/core@1.0.4`, so hosts satisfy the peer with the registry release.
The [fork reuse record](qualification/ag-ui-fork-reuse.md) pins its delivery and separates core adoption from native adapter qualification.
The separate `@operatorworks/switchboard/observability` entry requires the exact optional peer `@opentelemetry/api@1.9.0`.
It borrows a tracer and explicit parent contexts. The host owns SDK setup, exporters, and shutdown.
Content stays off by default. Model usage comes from individually observed requests.
Native dispatch phases, RPC requests, and AG-UI chunks do not establish those boundaries.
See [record observed agent work](observability/usage.md) and [validate telemetry destinations](observability/validation.md).
The separate `@operatorworks/switchboard/baseline` entry requires both optional peers.
Every exported runtime accepts an optional `onObservation` listener (on the request, as the third `PiSession.prompt` argument, or per host segment).
It receives `RunObservation` values taken at the native branch, including tool arguments, tool results, reasoning text, and token counts that the public callbacks omit.
Feed one segment's observations into one `createRunBaseline` to get AG-UI events and GenAI spans. Families with no native evidence are reported `unsupported` and every family stays `unqualified`.
AG-UI batches can contain those payloads, so the host owns their publication. Span content still follows the host's `contentPolicy`.
`npm run test:live-baseline` runs one opt-in live turn per selected engine and checks its AG-UI run in process and its agent span in an operator-started lotel collector. CI does not run it, and a run spends provider credit.
Only gates select engines: `SWITCHBOARD_LIVE_CLAUDE`, `SWITCHBOARD_LIVE_CODEX`, `SWITCHBOARD_LIVE_CURSOR`, `SWITCHBOARD_LIVE_PI`, `SWITCHBOARD_LIVE_HOST_PI`, `SWITCHBOARD_LIVE_HOST_CODEX`, and `SWITCHBOARD_LIVE_HOST_OPENCODE`, or `SWITCHBOARD_LIVE_ALL` for every engine. A gate is on only for `1`, `true`, `yes`, or `on`, and a key in the environment never selects an engine. `SWITCHBOARD_LIVE_DRY_RUN` fails safe the other way: any non-empty value except `0`, `false`, `no`, or `off` requests a dry run. `host/codex` needs an absolute `CODEX_BIN` for `codex-cli 0.169.0`, and `host/opencode` uses `OPENCODE_BIN` or `opencode` on `PATH`.
Keys come only from `SWITCHBOARD_ANTHROPIC_API_KEY`, `SWITCHBOARD_CURSOR_API_KEY`, and `SWITCHBOARD_OPENCODE_API_KEY` (both Pi engines and OpenCode, which receives it as `OPENCODE_AUTH_CONTENT`). Codex uses its ChatGPT login. Ambient `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, and `OPENCODE_API_KEY` are removed before any adapter loads.
Each engine defaults to a cheap model, overridable with `SWITCHBOARD_LIVE_<ENGINE>_MODEL` (for example `SWITCHBOARD_LIVE_HOST_CODEX_MODEL`): `claude-haiku-5-5`, `gpt-6-luna` for both Codex engines (host Codex also runs at low reasoning effort), `composer-2` for Cursor, `mimo-v2.6-flash` for both Pi engines, and `opencode-go/mimo-v2.6-flash` for OpenCode. The table lives in `scripts/live-baseline-engines.mjs`.
`SWITCHBOARD_LIVE_DRY_RUN=1` prints each selected engine's model, dispatch, credential presence, executable check, and model-proof level without a build, lotel, a model call, or a report. A live run passes only on a `success` terminal with a baseline that reports no dropped data (no diagnostics other than `tool-arguments-changed`; a dropped row reports `baseline-diagnostic` with the list, and a baseline that never terminated reports `baseline-unterminated`), tool arguments and results that equal the projected ones, and a failure prints one redacted reason. The model-span evidence is enforced: `claude` and `host/pi` must record a model span and every other engine must not. For the `native-record` engines (`codex`, `host/codex`) the report records the Codex session id. A `native-record` engine whose turn returns no session id fails with `native-record-missing`. Spans export to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` when set, else `http://127.0.0.1:4318/v1/traces`.
Installed package tests exercise the API and a real loopback HTTP provider without backend credentials.
Separate lotel and Datadog verification commands require their documented backends.
The optional `@operatorworks/switchboard/testkit` entry exports reusable controlled qualification groups and a reference fake.
It requires no AG-UI peer and registers no tests on import. The root module does not load it.
Register its groups in your test runner and provide the runner's bounded cancellation signal.

```js
import test from 'node:test';
import { contracts, createFakeFixture } from '@operatorworks/switchboard/testkit';

for (const [name, contract] of Object.entries(contracts)) {
	test(name, { timeout: 10_000 }, (t) => contract(createFakeFixture, t.signal));
}
```

Fixture obligations are documented on `QualificationFixture`, `QualificationConnection`, and `QualificationFactory`
in the shipped [testkit declarations](../dist/testkit/types.d.ts).
The source is `src/testkit/types.ts`.
The groups cover uncertainty, sessions, interaction, and events with separate result, effect, and delivery assertions.
These controlled checks do not qualify native engines, credentials, or durable host admission.

The `@operatorworks/switchboard/pi` entry requires both exact optional peers, `@earendil-works/pi-ai@1.5.2` and `@earendil-works/pi-coding-agent@1.5.2`.
Its public declarations do not import SDK types. The root entry does not load the SDK.

```js
import { createPiRuntime } from '@operatorworks/switchboard/pi';

const runtime = await createPiRuntime({
	cwd: process.cwd(),
	sessionDirectory: '/absolute/path/to/app-owned-sessions',
	apiKey: process.env.OPENCODE_API_KEY,
	provider: 'opencode-go',
	model: 'glm-5.3',
});
const session = await runtime.open();
let answer = '';
const accepted = await session.prompt('Hello', event => {
	if (event.kind === 'text') answer = event.text;
});
await accepted.finished;
process.stdout.write(answer);
await runtime.close();
```

The optional `./host/opencode` entry drives one local `opencode acp` process. The host supplies the spawn, the absolute executable, the absolute cwd, and the environment. The spawn receives `args` exactly \`[executable, 'acp']\`. That array is the full argv. A host that prepends the executable again launches the wrong process. The host drains or discards the child stderr. The adapter does not read it. An unread stderr pipe can stall the session. `model` is required and is sent as the ACP `model` config value, such as a caller-supplied `provider/model` string. The library does not choose one. Permission, filesystem, and terminal requests fail the segment. `npm test` does not qualify a live OpenCode binary. This entry is not `./pi`.

The `model` field is required and is not filled by the library. `glm-5.3` in the example is an argument the caller supplied.

Text events contain the complete assistant text so far. Replace the displayed text for each event.
`prompt()` resolves after Pi reports that its run started and persists the native user message in its journal.
This SDK admission lets hosts save the session reference before the first provider token. It does not wait for a provider acknowledgement.
`accepted.finished` resolves after the native run drains, with a completed, interrupted, or failed outcome.
Native `stop` and `length` stop reasons both count as completed.
`abort()` waits for the active run to stop. `close()` stops the run, disposes the session, and releases its writer reservation.
A runtime supports at most 32 open sessions. Each session accepts one prompt at a time.
Pi creates the journal lazily when it records the first user or assistant message.
Save `session.id` and the opaque `session.sessionFile` basename after the first `prompt()` resolves.
An unprompted session has no file and cannot be resumed. Open a new session for an empty chat.
A first prompt stopped during preflight still records its user message and can be resumed after it drains.
Resume with `runtime.open({ sessionFile })` after the previous session handle closes.
Resume uses the same canonical `cwd` and session directory. Relative paths follow Node's process-working-directory rules; hosts should supply absolute paths.
A missing or invalid file fails without creating a replacement session.
The runtime reserves each canonical session path within the host process. The host must own its session directory across processes.
Credentials stay in memory. Startup uses bundled model definitions and reads no user credentials, project instructions, skills, prompts, or extensions.
Tools, catalog network refresh, cache warming, compaction, and retries are disabled.
Provider failures expose a generic failed outcome. Native error diagnostics are replaced with generic text before journal persistence.
Importing `./pi` with missing SDK peers rejects with Node's `ERR_MODULE_NOT_FOUND`.
Only the declared exact peer versions are supported; forcing incompatible peers bypasses this contract.
The local tests replace provider HTTP responses and do not qualify a live subscription.

Native tools and credentials are unnecessary for the foundation checks.
No native integration or direct or LiteLLM route is qualified by this package check.

[Architecture boundaries](architecture/boundaries.md) records host responsibilities, source ownership, and native prerequisite evidence.
The existing [MIT license](../LICENSE) covers Switchboard.

TypeScript consumers need `@types/node` in their development dependencies because public cancellation contracts use `AbortSignal`.
The installed consumer verifies `@types/node` 24.19.2 with `lib: ["ES2022"]` and `types: ["node"]`.

`parseSessionReference` checks persisted input against an expected native binding.
`parseCheckpointReference` also checks the exact native session token.
Both return copied, frozen envelopes. These checks do not authenticate native tokens or authorize access.
`validateSessionDiscoveryBounds` validates result, examined-entry, and time budgets.
Every `SessionDiscoveryPage` requires `diagnostics`, including `[]` when no failure was observed.
Sessions and unidentified `file-inspection-failed` observations survive complete, truncated, and cancelled enumeration.
Each diagnostic has an opaque, call-local `discovery-file` subject. Its token grants no inspect or resume access.
Unidentified failures do not imply corruption or increment either skipped count.
`complete` means the adapter exhausted its qualified authorized enumeration, not that every candidate succeeded or all native history is valid.
Native discovery, inspection, and resume require later adapter implementations and qualification.

`createEventStream<T>({ maxObservers, capacity })` provides asynchronous FIFO delivery with one active callback per observer.
`capacity` counts queued events and the active callback. `maxObservers` includes retired subscriptions until their callbacks settle.
Publication returns immediately and reports overflowing observers as disconnected. Other observers continue independently.
`Subscription.ended` reports detachment. Consumer code may still run after disposal, abort, or close.
Payloads are borrowed references. The host owns payload immutability, payload size limits, and durable replay.
`EventObserver<T>` exposes subscription through a compile-time API restriction. It is not an authorization boundary.
Disposal and close never cancel native work. See [event delivery boundaries](architecture/boundaries.md#event-delivery) for terminal outcomes and admission rules.

## ChatGPT subscription chat

Install the optional peer `@openai/codex-sdk@0.169.0` and make Codex CLI 0.169.0 available on PATH. Sign in with ChatGPT using `codex login`. Import `createCodexRuntime` from `@operatorworks/switchboard/codex`. Supply an absolute working directory and a model id. `gpt-6.1-sol` is an example. Supply an absolute `codexPathOverride` for another path to the pinned CLI or `codexHome` for a separate native account and history directory.

Call `await runtime.checkReady()` before opening the chat. Call `await runtime.start({ text, onEvent })` to submit a message. This resolves at the SDK's native turn-start event. Persist the returned `threadId` against the authorized conversation. To continue after a restart, pass that same ID and the new message to `runtime.start`. The SDK owns native history. Hosts own admission across processes and must never resubmit a prompt after an uncertain dispatch.

The callback receives text snapshots per native message item followed by one terminal event. CLI 0.169.0 emits completed assistant items and may send several in one turn. `turn.finished` resolves after the SDK child exits. Use `turn.abort()` to stop the turn or `runtime.close()` to stop this runtime's pending work. Stop and shutdown await the direct CLI child for SDK turns and readiness checks in the pinned Node runtime. Custom launchers must forward termination to their own children.

The child uses the existing ChatGPT login and official OpenAI provider endpoint. The adapter omits inherited provider credentials, sets `shell_tool=false`, disables web search, apps and plugins, requests read-only sandboxing, and disables MCP servers listed by the CLI at dispatch. Other native tools may remain available and their events are not exposed by this text API. Native configuration and account changes during dispatch remain under host control. This entry point supports text. Rich tool calls, interactive approvals, external session discovery and proxy routes belong to the separate native app-server adapter.

### Claude text adapter

`@operatorworks/switchboard/claude` provides a text-only Claude Agent SDK runtime. Install the optional peer `@anthropic-ai/claude-agent-sdk` at the exact version listed in this package's peer dependencies. The caller supplies the exact model id the engine reports for the turn. The runtime passes that id to the SDK, and the turn is admitted only when the native model string equals it. An alias the engine rewrites to a different string is a legal caller string and a failed turn. The id in the example is a placeholder for that exact string, not a claim that the live API echoes it. A mismatch on the init frame, or on the first frame that would admit the turn, rejects `start()` with `Claude operation failed.` before admission. A mismatch on a later assistant frame, after `message_start` has admitted the turn, does not reject: `finished` resolves with outcome `failed`, and text events already delivered for that turn stand. In both cases the provider request was already sent, so the provider may bill it and the native transcript may remain in the session directory.

```js
import { createClaudeRuntime } from '@operatorworks/switchboard/claude';

const claude = createClaudeRuntime({
	cwd: '/work',
	sessionDirectory: '/work/sessions',
	apiKey: process.env.ANTHROPIC_API_KEY,
	model: 'claude-haiku-4-5',
});
```

Create a runtime with an absolute working directory, an absolute private session directory, an Anthropic API key, and that model id. Call `checkReady()` to check local paths, then `start({ text, threadId?, onEvent })`. The returned turn exposes the native session ID, the caller-supplied model id, a `finished` promise, and `abort()`. Call `close()` when the runtime is no longer needed.

Sessions use the native SDK's persisted session data inside the specified directory. Keep that directory private and retain it to resume a session. Resuming uses the exact native ID and never falls back to a new conversation. A turn is admitted only after a native response starts or an assistant response arrives. Initialization alone does not establish that the prompt was accepted. Admission times out after 30 seconds. Each runtime permits up to 32 simultaneous turns, and concurrent writes to the same session are rejected within the process. These limits do not coordinate separate operating-system processes. The adapter disables tools and configured settings, uses a private Claude configuration directory, and supplies only an explicit child environment. It does not impose an overall response deadline after admission.

Claude `start()` rejection can occur after the native process received the prompt, so hosts should treat it as uncertain and avoid automatic retries. If the SDK reports lost transcript writes for the active session, the turn fails and that runtime rejects further attempts to resume the session. This knowledge is held only in memory and does not survive a new runtime or process. A failed turn does not identify the cause.

Stop is available on admitted turns. Before admission, `start()` has no per-request cancellation handle and its 30-second deadline bounds the wait. `close()` cancels all pending work owned by that runtime. Session IDs must use canonical lowercase UUIDs.

### Cursor local agent

`@operatorworks/switchboard/cursor` runs a local Cursor coding agent through the optional peer `@cursor/sdk@1.4.2`. Install that exact peer. Forcing a different SDK version is outside this contract. A missing peer fails the import with `ERR_MODULE_NOT_FOUND`.

The caller supplies the model id. The id in the example is a placeholder, not a default, and the runtime passes that string through as `model.id`. A missing or illegal id throws `Cursor operation failed.` before the SDK is called. Create the runtime with an absolute working directory, an absolute session directory, the API key, and that model id.

```js
import { createCursorRuntime } from '@operatorworks/switchboard/cursor';

const cursor = createCursorRuntime({
	cwd: '/work',
	sessionDirectory: '/work/sessions',
	apiKey: process.env.CURSOR_API_KEY,
	model: 'composer-2.5',
});
```

For `createCursorRuntime`, the sandbox is always on. The runtime loads project settings from the working directory and does not retry a run. The sandbox confines shell execution. It does not confine `webSearch`, `webFetch`, or MCP. A per-user `~/.cursor/sandbox.json` or a project `.cursor/sandbox.json` can change the shell policy the SDK applies after sandboxing is enabled, and this adapter does not read or override those files.

Call `start({ text, agentId?, onEvent })`. `start` resolves when the SDK accepts the send, and the turn's `agentId` is the SDK agent id. `finished` resolves to `completed`, `failed`, or `interrupted`. The callback receives accumulated assistant text snapshots (`{ kind: 'text', text }`), tool envelopes (`{ kind: 'tool', callId, name, status }` where `status` is `running`, `completed`, or `error`), and one `{ kind: 'ended', outcome }`. Tool arguments and results are not callback fields. `@cursor/sdk@1.4.2` sometimes sends a call id as two tokens separated by one newline; the event reports those tokens joined by `:`. Each runtime allows 32 simultaneous turns.

`start` rejection before send returns is `Cursor operation failed.` and emits no `ended`. After send returns, `start` stays resolved even when the turn later fails, so hosts should treat that failure as uncertain and avoid automatic retries. `close()` disposes the agents this runtime opened. It does not delete the session directory or files the agent wrote. An unresolved native send retains its same-ID writer reservation after the public admission deadline. A late run is cancelled immediately when its handle arrives; the reservation is released only after its terminal status is observed. A failed late drain remains reserved and is retried by `close()`. These facts do not attest helper termination.

### Cursor fixed text runtime

`createCursorTextRuntime(options: CursorRuntimeOptions): CursorRuntime` uses the same
four inputs and lifecycle as the generic factory, with a fixed text policy:

```js
import { createCursorTextRuntime } from '@operatorworks/switchboard/cursor';

const runtime = createCursorTextRuntime({
	cwd: '/private/conversation',
	sessionDirectory: '/private/text-sessions',
	apiKey: process.env.CURSOR_API_KEY,
	model: 'grok-4.7',
});
```

Create and resume explicitly disable tools, settings, MCP, custom tools and
subagent configuration, sandbox setup and retries, and supply a retained empty
virtual filesystem. No caller-selectable control bag exists. Images are
unsupported and reject before admission. Unexpected tool or task events fail
without publishing tool payloads. Text uses the existing snapshot and terminal
callback behavior. Catalog listing retains the explicit key and remains
sessionless. Readiness still reports local paths only and cannot report ready.

The supported control tuple is SDK `1.4.2`, `cursor-text-v1`, Node `>=24.22.3 <25`.
Unsupported identity, exports, Node or launch controls produce the exported
`CursorTextPolicyUnsupportedError`, with code `cursor_policy_unsupported` and
fixed public fields including the stack. A refusal occurs before SDK
create/resume/send and emits no run-started observation. Ordinary input and SDK
failures keep the generic error behavior. No generic fallback occurs.

The host must keep a private store and use durable ownership records to reject
generic, imported, wrong-policy and unowned IDs before calling `start` with an
`agentId`. Only sessions created under the same text contract may resume.
Switchboard does not authenticate that provenance or scrub stored transcripts.
SDK 1.4.2 can restore subagent definitions from foreign sessions despite an
empty agents map. Empty tools do not prove absence of model context.

Close and completion do not prove helper termination, erasure or OS confinement.
Provider transport and SDK host access remain distinct from model tools. See the
[control audit and consumer qualification gates](qualification/cursor-text-runtime.md).
Crew must pass ownership, persisted-resume/context and hardened-deployment
qualification before adoption. The local adapter checks alone do not qualify a
production architecture.

### Provider readiness reports

`checkReady()` is unchanged. It runs the same probes and throws the same messages as before. When a host needs the reason, call `readinessReport({ signal? })` on a Codex, Claude, Pi, or Cursor runtime. Codex also accepts `timeoutMs`, a per-probe deadline from 1 through 10000 milliseconds that defaults to 10000. The report resolves for every provider condition, including a missing CLI, a timeout, cancellation and a closed runtime. It rejects only for invalid options. Root types `ReadinessReport` and `ReadinessSource` let a host hold these runtimes in one collection. Each adapter also exports a narrower type: `CodexReadinessReport`, `ClaudeReadinessReport`, `PiReadinessReport`, and `CursorReadinessReport`. Cursor cannot report `ready`.

A report records four facts separately: `installation`, `version`, `authentication` and `workspace`. A passing or positively failing state is listed in `checked`. These states are not evidence of absence:

- `timed_out` and `unknown`: a probe ran without positive evidence, for example a non-zero exit, malformed or oversized output, or an unclassified error. `cancelled`: the host signal stopped the check, possibly before the probe started.
- `not_checked`: a probe exists but did not run because an earlier fact did not pass or the runtime is closed.
- `unsupported`: the adapter has no probe for this fact.

`verdict` is `ready` only when installation, the exact qualified version and authentication were all observed passing. It is `blocked` when a failing condition was positively observed, and `unverified` otherwise. `remediation` is `null` only for `ready`.

| Code | Verdict | Meaning |
|---|---|---|
| `install_required` | blocked | The executable is missing or not executable. |
| `version_required` | blocked | The CLI reported a version other than the exact qualified one. A newer version is not supported. |
| `sign_in_required` | blocked | Codex reported `Not logged in`, or a login method other than ChatGPT. |
| `workspace_unavailable` | blocked | The working or session directory is missing or not accessible. |
| `retry_check` | unverified | A probe timed out or produced no usable evidence. |
| `check_cancelled` | unverified | The host signal aborted the check. |
| `runtime_closed` | unverified | The runtime was closed before or during the check. |
| `check_unavailable` | unverified | Local checks passed, but the adapter cannot observe sign-in. |

Codes and messages are fixed text. Codex blocked reports reuse the `checkReady()` messages. The only text in a report that comes from a native process is `version.observed`, and only when it matches a release pattern such as `0.170.0` or `0.170.0-rc.1`. Native output, paths and credentials are never included.

What each adapter observes:

- Codex runs `codex --version` and then, only for exactly 0.169.0, `codex login status`. The same bounds as `checkReady()` apply to each call: at most two children, run one after the other, 16 KiB of output each, and SIGTERM at the deadline or on cancellation followed by SIGKILL one second later. A version probe that times out leaves installation `available`. A login probe that times out or errors leaves authentication `unknown`, never `sign_in_required`. The executable is resolved from `PATH` when the runtime is created, so a later `PATH` change is not seen. A deleted override is seen. Workspace is `unsupported`.
- Claude checks the readable working directory, creates and checks the private session directory as `checkReady()` does, and checks an explicit `claudePathOverride` for execute permission. Without an override, installation is `unsupported`. It never observes the CLI version or whether the API key works, so it never reports `ready`. Claude and Pi read `signal` only before their local filesystem checks, which have no deadline.
- Pi re-checks only the directories that `createPiRuntime` validated. The SDK runs in-process, and its version and credentials are not probed, so installation, version and authentication are `unsupported`.
- Cursor checks that the working directory is readable and creates the session directory with mode `0o700`. It reads `signal` before those checks and again after each one. An abort during either check is `check_cancelled` and skips the session directory when it arrives first. Installation, version, and authentication are `unsupported`. It never observes the API key, so it cannot report `ready`.

A report is a point-in-time observation at `observedAt`. It is not cached, it does not guarantee that the next turn starts, and it is not native qualification. It never installs, updates, signs in, calls a model or refreshes a catalog. Tests use fixture CLIs only. The Codex `Not logged in` line was taken from the strings of the qualified 0.169.0 binary and has not been exercised natively. Any other output is reported as `unknown`, never as `signed_in`.

```ts
import type { ReadinessReport, ReadinessSource } from '@operatorworks/switchboard';

async function providerRows(sources: Record<string, ReadinessSource>, signal: AbortSignal) {
	return Promise.all(Object.entries(sources).map(async ([name, runtime]) => {
		const report: ReadinessReport = await runtime.readinessReport({ signal });
		if (report.verdict === 'ready') return { name, status: 'Ready', at: report.observedAt };
		// blocked: show the fix. unverified: offer Retry, or explain that sign-in is confirmed when a chat starts.
		return { name, status: report.remediation.message, code: report.remediation.code, at: report.observedAt };
	}));
}
// const rows = await providerRows({ codex, claude, pi, cursor }, AbortSignal.timeout(25_000));
```
