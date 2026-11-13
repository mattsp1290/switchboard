# Codex integration selection

Status on 2026-11-13 is **provisional selection, qualification blocked**. Prefer a thin adapter to the native app-server protocol at Codex 0.169.0. Keep the native agent loop, configuration, tools, approvals, session IDs and opaque events. This spike supplies artifact/source checks and SDK fixtures. It does not establish working native or LiteLLM integration.

## Evidence and pins

[pins.json](../../spikes/codex/pins.json) records exact npm artifact SHA512 values and source SHA256 values. The runner downloads only these artifacts and source revisions, verifies hashes, and extracts without installation scripts. No native binary is downloaded or executed.

| Component | Exact inspected revision | License and scope |
| --- | --- | --- |
| Codex SDK and CLI wrapper | `@openai/codex-sdk@0.169.0`, `@openai/codex@0.169.0` | Apache-2.0; SDK LICENSE inspected. Native optional platform packages are separate and untested. |
| Native protocol, config, auth and HTTP/SSE implementation | [`d32063f96c2dff1dc96af839b3952abb6acfeda4`](https://github.com/openai/codex/tree/d32063f96c2dff1dc96af839b3952abb6acfeda4), peeled `rust-v0.169.0` | Apache-2.0 source LICENSE inspected. A release tag/source comparison does not attest the installed 0.167.0 binary. |
| AI SDK harness | `@ai-sdk/harness-codex@1.0.185` | Apache-2.0 metadata; packaged bridge pins Codex 0.167.0. Full transitive license review remains open if reused. |
| ACP adapter | `@zed-industries/codex-acp@0.16.0`; [`bb590500e8646f6daf879b8b3c6a659fbd29017d`](https://github.com/zed-industries/codex-acp/tree/bb590500e8646f6daf879b8b3c6a659fbd29017d) | Apache-2.0 metadata/README; Cargo pins Codex Rust 0.137.0 and ACP Rust 0.14.0 with unstable features. |
| Consumer toolchain | Node 24.22.3, npm 11.19.1, TypeScript 7.0.2, `@types/node` 24.19.2, `undici-types` 7.24.6 | Local fixture compiler is macOS arm64. No DOM library, strict NodeNext/ES2022, `skipLibCheck:false`. |

Code licensing does not grant API access, subscription forwarding, account entitlements or permission to redistribute every dependency. The ACP README specifically restricts its ChatGPT subscription method in remote projects. That is adapter documentation, not a universal Codex authentication restriction. No credentials or production session files were inspected.

## API comparison

| Requirement | SDK 0.169.0 | App-server 0.169.0 source evidence | Decision |
| --- | --- | --- | --- |
| Start/stream/resume | `startThread`, `runStreamed`, `resumeThread(id)` wrap `codex exec --experimental-json`; resume is deferred until invocation | `thread/start`, `turn/start`, `thread/resume` | Prefer app-server for full lifecycle. |
| Discover sessions created outside Switchboard | No list/read API | `thread/list`, `thread/read`, cursor and source/provider/archive filters | Required app-server seam; native discovery remains unrun. |
| Approvals and user input | Policy enum only; no response callback | Bidirectional requests for command/file/permissions approval, user input, MCP elicitation and dynamic tools | Do not replace interactions with `approvalPolicy: never`. |
| Cancellation | Per-turn AbortSignal terminates CLI subprocess in fixture | `turn/interrupt` | Require terminal confirmation or unknown-outcome reconciliation. |
| Raw extensions | `runStreamed` yields unknown fixture event unchanged despite closed TS union | Protocol notifications/requests can be retained as opaque data | Preserve raw envelope alongside projections. Unknown requests need explicit unsupported handling. |
| Completion evidence | Buffered `run` returns normally after EOF without terminal success or after a top-level `error` fixture | Explicit turn notifications and read/resume APIs | Never equate process EOF or an SDK return value with durable success. |
| Native configuration | Structured TOML serialization, raw `configOverrides`, explicit child `env` | Native process configuration plus thread/turn overrides | Preserve native controls; host owns authorization and environment selection. |
| Renewable custom-provider bearer | Pass-through config only; no SDK token callback | Command-backed `model_providers.<id>.auth` | Native command path is promising but not live-qualified. |

Pinned source locations are `sdk/typescript` in the npm artifact, `codex-rs/app-server-protocol/schema/typescript/{ClientRequest,ServerRequest}.ts`, `v2/{ThreadListParams,ThreadResumeParams}.ts`, and `codex-rs/core/config.schema.json` in the source revision above. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server) was also opened, but current documentation is supplementary rather than the version pin.

`thread/list` defaults to interactive sources. An empty `sourceKinds` list does not mean every source. Explicit source coverage must include CLI, IDE, exec, app-server and relevant subagent kinds, and include unknown kinds as the pinned enum permits. `modelProviders: []` includes all providers. Archived threads need a separate query. Cursors are opaque. The default local listing can scan JSONL and repair metadata; `useStateDbOnly:true` avoids that repair but may omit unindexed history. The adapter must disclose coverage and effects, with the host choosing scope. It must not read production files directly to hide this gap. Resume by native thread ID is preferred; a successful SDK constructor proves neither existence nor authorization.

## Routes and authentication

All three required modes remain in scope. Native/direct uses the native provider/account configuration. LiteLLM same-family and LiteLLM cross-provider use a dedicated custom provider with an explicit model mapping, a proxy base URL ending in `/v1`, and the Responses wire protocol. Both proxy modes remain blocked on real compatibility tests. A successful OpenAI-style text response is insufficient evidence for tools, reasoning, attachments, compaction or model-specific native features.

The pinned `codex-rs/codex-api/src/endpoint/responses.rs` sends POST `/responses`, requests `text/event-stream`, and delegates to the native SSE parser. The config schema accepts only `responses` for `wire_api`; Chat Completions is not a fallback. `supports_websockets:false` requests HTTP/SSE for this provider. The fixture proves that these settings reach CLI arguments, not that a native client uses them or LiteLLM accepts them. [Official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) independently documents these controls.

The provider `auth` object has `command`, `args`, `cwd`, `timeout_ms` and `refresh_interval_ms`. The schema defaults are 5000 ms timeout and 300000 ms refresh age. Native `login/src/auth/external_bearer.rs` caches a token, checks its age when resolving auth, invokes the command when needed, trims stdout, and rejects empty/non-UTF-8 output, failure and timeout. A zero refresh interval disables age-based refresh and leaves the 401 recovery path. This is source evidence, not a timed rotation measurement.

Native validation rejects combining command auth with `env_key`, `experimental_bearer_token` or `requires_openai_auth`. A static proxy token can instead use a host-supplied environment key; it is not a substitute for required renewable credentials. The SDK `apiKey` option injects `CODEX_API_KEY`; the fixture checks that injection separately from whether a custom provider consumes it. The token command receives the native process environment plus configured values. Host-controlled command selection and credential handling are therefore required. Native command failures can include stderr in error text, so the adapter must avoid forwarding unreviewed credential-command diagnostics.

LiteLLM owns upstream provider secrets. Switchboard supplies only the proxy credential or host-approved renewable command. No subscription passthrough, cross-provider feature equivalence or entitlement is inferred. [Official authentication documentation](https://learn.chatgpt.com/docs/auth) was consulted for the separate native account boundary.

Provider `request_max_retries` and `stream_max_retries` can be set to zero. This does not prove all internal auth recovery, compaction or reconnect paths obey no-blind-retry. The native implementation must be tested with an accepted request followed by disconnect and with 401 recovery. The host must retain dispatch uncertainty and reconcile before any new turn. This spike adds no adapter retry loop.

## Reuse boundary

The SDK is useful for bounded noninteractive exec jobs but lacks required discovery and interactive reply APIs. Its published declarations also fail the strict consumer check below. Using it alone would require inventing extra native interfaces anyway.

The AI harness exposes `codexConfig` and resume machinery, but packaged `src/bridge/codex-app-server-driver.ts` forces `approvalPolicy: 'never'` and `danger-full-access`. Its `handleAppServerRequest` rejects every method except `item/tool/call`. Its bridge pins 0.167.0. These are concrete conflicts with preserving native approvals and the selected protocol. It is not selected as the adapter foundation; stream projection could be reconsidered separately after raw-event parity is proven. The [AI SDK harness overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) describes the broader abstraction as experimental.

The ACP wrapper offers permissions, client MCP servers and native-like interactions, but its Rust dependency is 0.137.0. Protocol-level loading capabilities do not prove external Codex discovery, identity equivalence, command-auth rotation or unknown-event preservation. [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup) requires capability negotiation before loading. Full adapter semantics and native-version parity would need a separate bounded experiment before choosing ACP.

A thin app-server adapter avoids these known translation losses. This is a source-based selection, not a claim that generated TypeScript declarations are already a NodeNext-ready package or that every required protocol interaction has run.

## Reproduce the bounded probes

From the repository root, use the pinned tools already available in the workspace:

```sh
/Users/lunus/.npm/_npx/010ee680b2e968d8/node_modules/.bin/node spikes/codex/probe.mjs /Users/lunus/.npm/_npx/010ee680b2e968d8/node_modules/.bin/npm
```

On another macOS arm64 machine, substitute the absolute paths to the same Node/npm versions. `probe.mjs` intentionally fails on other platforms because this fixture's network denial uses macOS `sandbox-exec` and the pinned compiler binary is arm64. Linux CI cannot execute this fixture runner. A Linux network-denial fixture is a separate portability blocker. Registry and immutable GitHub downloads are required. Hash mismatches fail rather than selecting newer artifacts.

The runner uses a fresh temporary package, blank npm config, and an allowlisted child environment. It never sets HOME or CODEX_HOME. The fake executable uses only its explicit fixture paths and cannot access native state. It never runs native Codex, the auth command, AI harness bootstrap or ACP. The only child peer is the checked-in fixture. macOS denies its network access; Node permissions deny child execution and reads/writes outside its temporary root. The peer asserts denial of a network connection, `/etc/passwd` access and child execution. Each SDK turn has a five-second deadline. Temporary files are removed in `finally`.

The [recorded probe output](../../spikes/codex/results.txt) contains all nine passing probe groups and the exact compiler diagnostic. The strict SDK declaration probe is an **expected failure**, currently exactly TS2307 for `@modelcontextprotocol/sdk/types.js`. That module is imported by `dist/index.d.ts` but appears only in the SDK's devDependencies. The declared CLI dependency has no regular dependencies; its optional platform packages are not TypeScript dependency fixes. The Node-only control compiles under the same no-DOM configuration. No ambient shim, `skipLibCheck`, transitive workspace package or patched declaration hides the SDK defect. This is a packaging defect, not evidence that the runtime or native API is unavailable. The app-server candidate remains independent of that defect. Adding and qualifying an explicit MCP dependency or a separate compiler boundary is possible follow-up work; neither requires weakening the core no-DOM invariant.

Other assertions cover exact artifact pins, protocol/config source fields, reuse incompatibilities, serialized proxy/command-auth options, native ID resume arguments, unknown streamed payload preservation, usage normalization, malformed JSON, nonzero exit, one invocation per failure, abort, and buffered EOF/fatal-error behavior. Source assertions establish available APIs. The process fixtures establish SDK wrapper behavior only. There is no native session lifecycle, credential renewal, HTTP server, live model or LiteLLM result in this spike.

## Remaining acceptance blockers

1. Run the exact 0.169.0 app-server binary in an isolated host with external dispatch denied. Verify initialize/initialized, session discovery from independently created fixture sessions, pagination/filter coverage, read/resume identity, approvals, user input, native tools and unknown extensions. Establish generated protocol binding consumption under strict NodeNext with no DOM.
2. Exercise native command auth against a local Responses HTTP/SSE fixture. Verify initial issuance, cached reuse, expiry, 401 rotation, timeout/empty output, credential redaction, and loss after dispatch. Confirm native retry controls do not turn an unknown outcome into duplicate work.
3. Use the later live qualification tasks for direct, LiteLLM same-family and LiteLLM cross-provider routes with the host's explicit credentials and model allowlist. Record per-feature support and restrictions without dropping unsupported required combinations.
4. Resolve the SDK declaration packaging defect if SDK code remains in the implementation. Revisit ACP or AI reuse only after an exact-version parity experiment removes their identified conflicts.

The evidence is sufficient to prefer app-server provisionally and reject the inspected reuse packages as drop-in foundations. Required runtime combinations remain blocked; this document does not convert them into optional features.
