# Host-facing adapter contract

This contract is the surface a host uses to drive one native engine session. Codex, Claude, and Pi host adapters implement it later. The text adapters and their exports stay as they are. The contract keeps no store, retries nothing, applies no approval policy, and contains no launcher.

The host owns the store, retry, approval policy, and launcher. It records intent before the adapter dispatches. An option the host omits keeps that engine's native behaviour. A host-launcher denial is an operation error or `unavailable`, and is never a fallback to another launch, network path, or filesystem path.

## Operations

`HostAdapterRegistration.open` takes `HostOpenOptions` and an `AbortSignal`. The options are a host spawn function, a host channel with a process-exit attestation, or an in-process declaration; the complete environment and native configuration; `instructions` text; host tool declarations; a provider route; `subagents: 'off'`; the engine built-in tools to leave on; and either a new session or a `SessionReference` plus an optional expected history fingerprint. When `launch` is present the host owns every native process. The adapter starts that process only through the supplied launch and never signals it. When `environment` is present the adapter reads no ambient variable, home directory, or configuration file.

`run` executes one segment from a prompt. `continue` answers the whole pending set. One segment runs at a time. Both call the host's `recordIntent` and only then dispatch, using `createDispatchOperation` in `src/core/dispatch.ts`. The host must durably record the command and acquire admission before `recordIntent` resolves. The adapter does not store that command.

`HostSegmentRequest.onObservation` is an optional per-segment listener: `run` and `continue` each take their own, and one segment is one baseline. The adapter emits `run-started` once admitted and `terminal` with its final result, and a listener exception is swallowed and never changes the result. Observations carry tool argument and result JSON, text, and reasoning payloads, as `HostAdapterEvent` already does, so the host treats them with the same care. `usage` rows are native counts that are never summed and a later row for the same provider and model replaces an earlier one; the scope differs by runtime: `./host/codex` reports the thread-cumulative total (including earlier segments), Pi-host reports the most recent request only, and OpenCode reports the latest usage update or the prompt-response usage.

`inspect`, when the capability is `supported`, reads unanswered host tool calls from native state and makes no model call. Otherwise the capability is `unsupported` or `unavailable` and the API is absent.

`fingerprint`, when supported, reads a history fingerprint. `validity` is `segment-end` or `after-process-exit`. The value is a core `CheckpointReference`. Resume passes it back as `expectedHistory`. A different native history fails with `history-mismatch` and dispatches nothing.

`events` is an `EventObserver`. The adapter publishes ordered facts: text delta, tool-call start, argument delta, tool-call end, tool delivery, usage, and opaque native items. The host owns redaction, receipts, and durable replay.

`interrupt` takes a time bound and returns `terminal-observed`, `interrupted`, or `unconfirmed-within-bound`. `terminal-observed` means the segment's native terminal fact arrived within the bound, or no segment was active. `interrupted` means native acknowledged the interrupt and the terminal fact has not arrived. `unconfirmed-within-bound` means the bound elapsed without that acknowledgement. No result claims that a process stopped, and the call never signals a host-owned process.

`capabilities` is fixed for the opened instance. It states the pending-call limit, whether a continuation may be delivered to a session reopened in another process, inspect, fingerprint timing, whether usage is per segment or cumulative, and that tool declarations are `fixed-at-creation`.

## Segment results

`complete` carries the session, the segment text, and raw native usage. `pending` carries the session, one `HostToolCall` per unanswered host call, and usage. Each call embeds the core tool `PendingInteraction` (its `ToolTarget`) plus the engine's tool name and argument value. The adapter does not re-parse or default those arguments. `continue` takes core `InteractionContinuation` values, one per pending call, covering that set exactly in any order. `parseInteractionContinuation` checks each answer against the stored pending record.

`failed` carries a `HostAdapterError` and a write status taken from `createDispatchOperation`:

| Status | Meaning |
| --- | --- |
| `not-attempted` | Refused before that helper ran. Nothing was sent. |
| `not-dispatched` | The helper's not-sent observation: `aborted` or `intent-failed`. |
| `outcome-unknown` | The helper entered native dispatch and lost the result. |
| `accepted` | Native acceptance was observed, and the segment still failed. |

The plan's names `not-sent` and `outcome-unknown` are the helper's `not-dispatched` and `outcome-unknown` observations. `not-attempted` is the refusal that happens before the helper. `accepted` is the helper's accepted observation, used when a typed failure follows a write the host must not treat as unsent. `pending-limit` is that case: the native write was accepted and one assistant message produced more host calls than `maxPendingPerMessage`. The extra call is a typed failure, not a silent loss. None of these statuses authorizes a retry.

A host-launcher denial at `open` is an `Outcome` error. A denial first seen during `run` or `continue` is a `failed` segment whose write status is `not-attempted` or `not-dispatched` when the write did not start. `unavailable` names the denied feature, including `host-launcher`. `Capability` `unavailable` remains the report when configuration already shows the feature cannot be offered. Neither path starts a different process or route.

## Capabilities and the host-tool probes

The probe record is [host-tool-probes.md](../qualification/host-tool-probes.md). It shapes the capability fields:

- Claude holds one deferred host call from one assistant message (A5, A6). A second deferred call in that message is lost by the CLI with no error (A6). `maxPendingPerMessage` is therefore 1 for Claude, and a further deferred call is `pending-limit`.
- Codex tool declarations supplied at `thread/resume` are ignored (A2). `toolDeclarations` is `fixed-at-creation` on every engine. A later declaration that differs from the session's declarations is `invalid-input`.
- A Codex history fingerprint matched at segment end, after process exit, and at the next open (A3). An adapter whose fingerprint is valid at segment end says `segment-end`. One that is valid only after the host attests process exit says `after-process-exit`.
- Codex `total` usage continues across resume and `last` covers one model request (A4). `HostUsage` carries the engine's raw counters and a `segment` or `cumulative` scope. The adapter does not sum them.
- Claude resumed one deferred call in a fresh process (A5). Codex holds the call in the live process (A1). `continuation` is `fresh-process` or `same-process`.

## Provider route

`src/core/auth.ts` adds a host-declared route beside the LiteLLM proxy. `credentialPurpose: 'litellm-proxy'` stays valid and still resolves a `ProxyCredential`. The new kind is `host-route`. It carries an endpoint, a protocol, a credential form, and a principal. The principal is the host's stable route identity, so a per-turn loopback endpoint can change without changing the principal. The forms are `none` (no secret), `helper` (a native helper the host configured, no secret in the material), and `bearer` (a host-supplied token and optional headers, resolved at each boundary). This is not subscription passthrough through LiteLLM. A material whose form or purpose does not match the declared route is `credential-unavailable`. The helper does not cache credentials, choose a fallback route, or dispatch native work.

How an engine binds that principal, which endpoint shapes it admits, and whether a helper can run under the host launcher are adapter work. An adapter that cannot run a helper reports `unavailable`.

## Core types this contract reuses

The contract declares no second `PendingInteraction`, `InteractionContinuation`, `ToolOutcome`, `SessionReference`, or `Capability`.

| Type | File |
| --- | --- |
| `AdapterIdentity`, `AdapterInstance`, `AdapterError`, `Outcome`, `NativeExtension` | `src/core/contracts.ts` |
| `PendingInteraction`, `InteractionContinuation`, `ToolOutcome`, `ToolTarget`, `NativeDelivery` | `src/core/interaction.ts` |
| `SessionReference`, `CheckpointReference` | `src/core/sessions.ts` |
| `createDispatchOperation`, `DispatchObservation`, `DispatchIdentity`, `DispatchEvidence` | `src/core/dispatch.ts` |
| `Capability` | `src/core/capabilities.ts` |
| `EventObserver` | `src/core/events.ts` |
| `AuthConfiguration`, `AuthScope`, `ProxyCredential`, `HostRouteCredential` | `src/core/auth.ts` |

`ToolOutcome` travels inside an `InteractionContinuation` of kind `tool`. `HostToolCall.pending` is the tool branch of `PendingInteraction`. Inspect and fingerprint use `Capability`, so an unsupported or unavailable feature has no API.

## Decisions D1 to D12

Each seam was argued by one advocate for the library and one for the host, with t3code and OpenBot as comparisons. The table and the comparison come from the Crew migration plan (`switchboard-adapter-migration`, files `00-overview.md` and `09-debate-evidence.md`), which is not in this repository.

| # | Seam | Switchboard owns | The host keeps | Rejected | Reason from the comparison |
| --- | --- | --- | --- | --- | --- |
| D1 | Session checkpoints | Locating and parsing native history; a history fingerprint; verify-before-resume | The checkpoint record, fencing, provenance, and the decision to require a match | A checkpoint that carries a whole session | t3code keeps native sessions with host refs; OpenBot's "two stores remembering the same thread" warning argues against a second copy |
| D2 | Process launch | Mapping a host spawn function or channel onto each SDK's hook; never signalling a host-owned process | The launcher, environment, process group, kill and reap evidence | An adapter that spawns and reaps | Both systems split process and sandbox; the host already proves its own confinement |
| D3 | Pi | An adapter that loads inside a host-owned worker with an injected model stream function | The worker, channel, relay, text publication, and result verification | Moving the relay or distrust check into the library | The host's check of the worker must not depend on the code it checks |
| D4 | Codex member lane | The app-server transport with host dynamic tools | The call ledger, live hold, settlement, delivery confirmation and deadlines | SDK exec with a loopback MCP server | t3code puts app tools behind a host endpoint; probe A1 showed the app-server holds a host call long enough |
| D5 | Pause and resume | Core `PendingInteraction` and `InteractionContinuation`; a read of pending calls with no model call; a fresh-process capability | The approval ledger, receipts, restore decision, and recovery | An adapter that picks a restore workaround or fabricates a tool result | t3code: "Do not imitate a missing mode by answering approvals"; OpenBot persists the pending row in the host |
| D6 | Cancellation | An interrupt with a typed result that never claims termination | Reap evidence, the `uncertain` record, the no-replay rule | Trusting an adapter's cleanup as proof | t3code surfaces a timeout as "its processes may still be running"; neither system auto-replays an uncertain effect |
| D7 | Events | Typed facts in order, with argument deltas and native identifiers | Redaction, receipts, the durable wire and replay | Replacing the host's projection | Both systems translate events in the adapter and leave durability to the host |
| D8 | Credentials | A host-declared route: endpoint, protocol, credential form, and a stable principal | The signing relay, upstream credentials, account approval, sign-in reads | A LiteLLM-only route; a helper the launcher cannot run | Both systems split credentials; in both, plan credentials leaked through side channels when the seam lacked a route |
| D9 | Usage | Raw native counters per segment | The ledger, prices, budgets, stored prior totals | Summing in the library | t3code's adapter reports tokens and the host prices |
| D10 | Children | An option that switches the engine's own subagents off | Targets, roles, budgets, the delegation tool, the kill switch | A child driver in the library | OpenBot removes the engine's own agent tool and keeps subagents in the host |
| D11 | System context | One `instructions` input, placed per engine | The content | Per-engine placement code in the host | t3code shares the text and lets each adapter place it; OpenBot composes content and the harness places it |
| D12 | Host-run tools | Declarations fixed at creation, a pending call keyed by native identity, a delivery fact, capabilities that report limits | The catalog, gate, ledger and execution | Engine built-in tools as the mechanism | OpenBot strips ungoverned built-ins and runs governed tools in the host |

What the contract takes from those decisions:

- D1. The fingerprint is a `CheckpointReference`. Resume can require it to match. The reference does not carry a whole session transcript.
- D2. Launch is a host spawn, a host channel plus process-exit attestation, or an in-process declaration. Interrupt never signals a host-owned process.
- D3. In-process launch is how a Pi adapter loads inside a host-owned worker. This package does not implement that adapter, the relay, or worker verification.
- D4. A host tool call is a pending interaction with native identity. The Codex app-server adapter is a later package.
- D5. Pause and resume reuse `PendingInteraction` and `InteractionContinuation`. Inspect reads pending calls with no model call. Fresh-process continuation is a capability, not a restore policy.
- D6. Interrupt returns one of the three results above and does not claim termination.
- D7. Events are ordered typed facts, including argument deltas and native identifiers.
- D8. The host-declared route carries endpoint, protocol, credential form, and a stable principal. `litellm-proxy` remains valid.
- D9. Usage is raw native counters labelled per segment or cumulative.
- D10. `subagents: 'off'` switches the engine's own subagents off. Omitting it leaves native behaviour.
- D11. `instructions` is one string. The adapter places it. The host writes the content.
- D12. Tool declarations are fixed at session creation. A pending host call keeps its native identity. Tool delivery is its own event. Capabilities report the pending-call limit.

## Conformance

`src/testkit/host-contracts.ts` exports `hostAdapterContracts`: `segments`, `interaction`, `history`, `interrupt`, and `host-launcher`. Each runs against any `HostConformanceSubject`. The host-launcher contract requires the launch to go through the host launcher, and a denial to surface as an operation error or as a failed segment whose write did not start. A subject that launches another way, or that reports an accepted or unknown write after the denial, fails the contract. An interrupt with no segment in flight must be `terminal-observed`. An interrupt while a segment is blocked before native entry must be `unconfirmed-within-bound`, and it must not signal the process. `interrupted` stays the result where native has acknowledged the interrupt. `pending-limit` must carry an `accepted` write. `createFakeHostSubject` is an in-memory subject with no process and no engine. It qualifies nothing native.

## Layout and export names

- The Codex host adapter lives at `src/adapters/codex/index.ts`, in the root project beside the private app-server stack. It does not import `@openai/codex-sdk`. It exports `CODEX_HOST_NATIVE_VERSION`. It sets `initialize.capabilities.experimentalApi` to true so host dynamic tools can be declared at `thread/start`.
- The OpenCode host adapter is `src/adapters/opencode/index.ts` and is exported as `./host/opencode`. It declares ACP protocol version `1` and does not declare an OpenCode release.
- The Claude host project is `adapters/claude-host/`. It compiles apart from the root project because the root declaration check fails on the SDK (`docs/qualification/claude-selection.md`). `sessions.ts` discovers one directory. `execution.ts`, `interaction.ts`, `features.ts`, `proxy.ts`, and the `./host/claude` export remain later. The Pi host adapter is `adapters/pi-host/`.
- The export names will be `./host/codex`, `./host/claude`, and `./host/pi`. Each package that adds an adapter adds its entry. The map gains no entry that points at a missing file.
- Each host adapter will declare the exact native versions it was proved against. The Claude host adapter will also declare `@modelcontextprotocol/sdk`.

## Left to later packages

The Codex host adapter is exported as `./host/codex`. The Pi host adapter is exported as `./host/pi`. The `./host/opencode` entry does not implement host tools, resume, or live OpenCode qualification. This tree does not add `./host/claude`. It does not change `createAguiProjection`, the AG-UI mapping, or a text adapter. The Claude session adapter and its endpoint rules remain a later package. The Codex adapter does not pass a subscription credential through LiteLLM: a bearer is a host-route whose token stays in the host environment. `test:native-isolated` belongs to a different package and is not part of this tree.
