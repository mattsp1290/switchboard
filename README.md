# Switchboard

Switchboard is a Node-hosted TypeScript library for native agent interfaces and adapters.
This foundation contains one private ESM package, `@mattsp1290/switchboard@0.0.0`.
Its root module exports adapter contracts, native session envelopes, validation helpers, and bounded event streams.
The optional `./agui` entry projects observed facts into pinned AG-UI 1.0 output.
The optional `./pi` entry runs text-only Pi SDK sessions on OpenCode Go with `glm-5.3`.
Claude and Codex adapters remain unqualified. The Pi entry has local SDK tests and requires separate live provider qualification.

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
Run `npm run build` to compile separately. The build removes `dist` before compilation. `npm run clean` removes the local build.

GitHub Actions runs the same checks on Ubuntu 24.04 with Node 24.22.3 and npm 11.19.1.
The workflow uses `npm ci`, immutable action commits, and read-only repository access.
It also runs `npm run verify:agui` against checksum-pinned canonical schema fixtures and published Python and TypeScript SDKs.
That repository development check requires uv 0.11.3, Python 3.13.12, and initial registry/GitHub access.
Its SDK environments are temporary. It adds no package dependencies or native qualification claims.
The protocol matrix, exact per-definition dispositions, and validation differences are recorded under `docs/protocol/`.
Installed verification requires actual projection output for all 28 explicit event kinds and five child terminal variants.
Three canonical chunk kinds normalize to explicit stream events. Input and capability declarations do not create output events.

The intended import is `import type { AdapterRegistration, Capability } from '@mattsp1290/switchboard'`.
The separate `@mattsp1290/switchboard/agui` entry requires the exact optional peer `@ag-ui/core@1.0.4`.
The optional `@mattsp1290/switchboard/testkit` entry exports reusable controlled qualification groups and a reference fake.
It requires no AG-UI peer and registers no tests on import. The root module does not load it.
Register its groups in your test runner and provide the runner's bounded cancellation signal.

```js
import test from 'node:test';
import { contracts, createFakeFixture } from '@mattsp1290/switchboard/testkit';

for (const [name, contract] of Object.entries(contracts)) {
	test(name, { timeout: 10_000 }, (t) => contract(createFakeFixture, t.signal));
}
```

Fixture obligations are documented on `QualificationFixture`, `QualificationConnection`, and `QualificationFactory`
in the shipped [testkit declarations](dist/testkit/types.d.ts).
The source is `src/testkit/types.ts`.
The groups cover uncertainty, sessions, interaction, and events with separate result, effect, and delivery assertions.
These controlled checks do not qualify native engines, credentials, or durable host admission.

The `@mattsp1290/switchboard/pi` entry requires both exact optional peers, `@earendil-works/pi-ai@1.5.2` and `@earendil-works/pi-coding-agent@1.5.2`.
Its public declarations do not import SDK types. The root entry does not load the SDK.

```js
import { createPiRuntime } from '@mattsp1290/switchboard/pi';

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

[Architecture boundaries](docs/architecture/boundaries.md) records host responsibilities, source ownership, and native prerequisite evidence.
The existing [MIT license](LICENSE) covers Switchboard.

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
Disposal and close never cancel native work. See [event delivery boundaries](docs/architecture/boundaries.md#event-delivery) for terminal outcomes and admission rules.

## ChatGPT subscription chat

Install the optional peer `@openai/codex-sdk@0.169.0` and make Codex CLI 0.169.0 available on PATH. Sign in with ChatGPT using `codex login`. Import `createCodexRuntime` from `@mattsp1290/switchboard/codex`. Supply an absolute working directory and `model: 'gpt-6.1-sol'`. Supply `codexPathOverride` for another path to the pinned CLI or `codexHome` for a separate native account and history directory.

Call `await runtime.checkReady()` before opening the chat. Call `await runtime.start({ text, onEvent })` to submit a message. This resolves at the SDK's native turn-start event. Persist the returned `threadId` against the authorized conversation. To continue after a restart, pass that same ID and the new message to `runtime.start`. The SDK owns native history. Hosts own admission across processes and must never resubmit a prompt after an uncertain dispatch.

The callback receives text snapshots per native message item followed by one terminal event. CLI 0.169.0 emits completed assistant items and may send several in one turn. `turn.finished` resolves after the SDK child exits. Use `turn.abort()` to stop the turn or `runtime.close()` to stop this runtime's pending work. Stop and shutdown track the SDK's direct child in the pinned Node runtime. Custom launchers must forward termination to their own children.

The child uses the existing ChatGPT login and official OpenAI provider endpoint. The adapter omits inherited provider credentials, disables shell execution, search, apps and plugins, requests read-only sandboxing, and disables MCP servers listed by the CLI at dispatch. Native configuration and account changes during dispatch remain under host control. This entry point supports text. Rich tool calls, interactive approvals, external session discovery and proxy routes belong to the separate native app-server adapter.
