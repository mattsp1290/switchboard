# Switchboard boundaries

Switchboard supplies reusable interfaces and native adapters for a Node host.
The foundation supplies public adapter contracts, session envelope validation, bounded event streams, and package verification.
Native adapters and native session discovery remain future work.
The private core package has no mandatory runtime dependencies.
The optional `./agui` integration requires the exact peer `@ag-ui/core@1.0.4`.

## Host ownership

Crew, AgentUI, or another consumer owns authorization policy, credential resolution, and durable command intent and outcomes.
The host also owns database storage, event replay, recovery scheduling, workflow retries, remote server lifecycle, and UI.
Native runtimes may maintain their own session files. Those files do not make Switchboard a durable workflow engine.

A local request ID does not establish exactly-once execution.
Future adapters must expose uncertainty after ambiguous native acceptance so the host can reconcile from supported native evidence.
The host must not blindly resubmit a message, approval, or continuation after losing its acknowledgement.
Cancellation does not imply rollback. Removing an observer does not imply cancellation.

Direct native authentication and proxy authentication are separate configuration paths.
LiteLLM owns upstream provider credentials. Switchboard authenticates to the proxy with host-resolved credentials.
Subscription credential passthrough through LiteLLM is outside v1.
A selected proxy route must not silently fall back to direct access.
Future adapters must scope credentials per adapter and session, preserve native approvals, and prevent secret disclosure in observable output.

## Source ownership and exports

`src/index.ts` exports core contracts and helpers without importing AG-UI.
`src/agui/index.ts` supplies the explicit `./agui` entry with pinned protocol metadata.
`createAguiProjection` maps observed lifecycle, text, tool, content and step facts through one bounded per-run actor.
Its frozen `aguiProtocol` descriptor identifies basic, value and message snapshot mapping support; terminals, reasoning and subagents remain planned.
The root export maps to emitted JavaScript and declarations under `dist`.
Deep imports are private. The package verification command checks this restriction in an installed tarball.

The following directories describe source ownership. Core contracts live in `src/core/`; protocol mapping and metadata live in `src/agui/`.

| Source area | Responsibility | Allowed direction |
| --- | --- | --- |
| `src/core/` | Public runtime contracts, native session references, and bounded event delivery | No native SDK or AG-UI dependency |
| `src/adapters/claude/` | Claude native integration | May import core and Claude dependencies |
| `src/adapters/codex/` | Codex native integration | May import core and Codex dependencies |
| `src/adapters/pi/` | Pi native integration | May import core and Pi dependencies |
| `src/agui/` | Canonical AG-UI mapping | May import core and canonical AG-UI types |

Native adapters need their own explicit entry points when implemented.
AG-UI imports only the SDK main entry. Optional Zod and SDK schemas are not integration runtime dependencies.
Third-party adapters must use public contracts without importing internal source files.
Native dependency and package-splitting decisions belong to the adapter tasks.

## Adapter contracts

`AdapterIdentity<Engine>` identifies an engine, adapter package, adapter version, and contract generation.
Engine names form an open string domain. A concrete engine literal connects a registration to its returned instance.
`AdapterRegistration<Options, Instance>` preserves the adapter's configuration and concrete instance type through `open`.
Registration and instance identity metadata must agree. Types do not prove object-reference equality or runtime identity.
`contractVersion: 1` describes this contract generation. Identity metadata does not validate persisted native data.

`AdapterInstance` requires identity and `close`. Concrete instances define their own named capability groups.
No native capability is mandatory. Domain contracts describe optional operations. Native dispatch remains future work.
`Capability<Api>` keeps a typed API in its `supported` branch.
`unsupported` means the adapter or native version does not implement the feature.
`unavailable` means this configured instance cannot offer the feature, such as when the host disables it.
Both branches carry a reason and omit the API. Callers narrow `kind` before accessing operations.
TypeScript rejects excess API fields on fresh unsupported literals. Structural typing does not enforce exact objects after aliasing.
Capabilities describe configured availability. Operation results still handle changed native conditions and busy resources.
Capability support does not grant authorization or prove native qualification.

`Outcome<T, E = AdapterError>` distinguishes `ok` with a value from `error` with a typed error.
`AdapterError` describes unsupported requests, busy or closed instances, invalid input, and native failures.
An unsupported error names its feature. Public messages must exclude credentials and raw native responses.
Domain contracts can supply their own error type. Ordinary errors confer no permission to retry native effects.
Side-effecting domain contracts must model uncertain outcomes with operation identity and reconciliation evidence.

`NativeExtension<T = unknown>` labels adapter-specific data with a namespace and schema version.
The adapter owns those labels and the payload type. Consumers without that type receive `unknown`.
An extension promises neither serialization nor compatibility validation. Core does not log its payload.

The adapter owns clients, listeners, transports, and processes that it creates.
Adapters that accept borrowed native clients must state ownership in their options.
A failed `open` releases resources acquired before returning its error.
`close` is idempotent cleanup. Repeated and concurrent callers share one cleanup attempt and its settled outcome.
The adapter rejects new operations once closing starts and releases its owned resources.
A cleanup failure returns a redacted error and does not establish that every resource terminated.
Closing does not confirm native cancellation, roll back tool effects, delete session history, or establish safe retry.
The later domain contracts own active-work cancellation and reconciliation.

The installed consumer checks prove public typing and package boundaries.
They do not verify cleanup idempotence, resource release, native identity validation, or native integration behavior.
Concrete adapters require runtime tests for those promises.

## Native sessions and checkpoints

`SessionReference` and `CheckpointReference` carry Switchboard envelope `formatVersion: 1`.
Their binding identifies the engine, native version, account, adapter-specific authorized scope, and native format.
Exact native version and format equality is the conservative initial rule. Adapter package semver is not part of this binding.
Later native qualification may justify a broader compatibility rule.
Checkpoints also bind the exact session's opaque token. `SessionCorrelation` carries separate host thread, run, and request IDs.
The host owns the correlation map, persistence, and authorization. An identifier does not grant access.

The parsers accept `unknown`, check bounded nonblank strings without control characters, and reject unknown envelope versions without migration.
They copy known fields into frozen envelopes and frozen bindings. Extra input fields are discarded.
`sessionLimits` exposes the string and work ceilings. Identifiers have at most 1024 UTF-16 code units and opaque tokens at most 8192.
Core does not interpret opaque token syntax, prove authenticity, inspect private native formats, or check native existence.
Adapters validate native references before use. No parser imports, rewrites, or migrates history.

`SessionDiscovery<Scope>` and `SessionInspection<Scope>` require an explicit host-authorized adapter-specific scope, binding, bounds, and `AbortSignal`.
Adapters define scope handles and authorize discovery sources. The optional filesystem helper below requires an explicit root.
`validateSessionDiscoveryBounds` requires positive safe integers, at most 1000 returned results, 100000 examined entries, and 60000 milliseconds.
The result limit cannot exceed the examined-entry limit. Validation returns a frozen budget copy.
Adapters enforce all budgets and stop cooperatively on abort. They count each examined candidate, including filtered, corrupt, or inaccessible entries.
They remain within authorized resolved roots and symlink boundaries and read only supported native discovery sources.
Discovery skips corrupt and inaccessible entries and reports both counts. A scope-wide access failure is an `inaccessible` error.
Pages distinguish complete, truncated by a named budget, and cancelled results. A complete empty page differs from an interrupted empty page.
Inspection reports available, absent, busy, or incompatible. Inspection cancellation or exhausted budgets return `cancelled` or `bounds-exceeded` errors.
Neither discovery nor inspection acquires a lease. A later resume operation rechecks native availability before use.
The installed session tests verify envelope validation, budget validation, and typed outcomes. Native discovery and resume remain adapter qualification obligations.

## Event delivery

`createEventStream<T>` returns an `EventStream<T>` with `publish`, `subscribe`, and `close`.
`EventObserver<T>` exposes only `subscribe`. This type is a compile-time API restriction, not an authorization boundary.
Adapters define event payloads and preserve native features and reported usage. Core supplies no universal event vocabulary or manufactured reasoning.
Payloads are borrowed references. Core neither clones nor freezes them, and the host owns payload immutability and byte limits.

`EventStreamBounds` requires positive safe integers for `maxObservers`, `capacity`, and their product. Invalid bounds throw `RangeError`.
Each observer receives events in FIFO order through an asynchronous drain, with at most one active callback.
`publish` never awaits a listener. Its result reports how many observers accepted the event and how many disconnected on overflow.
`capacity` counts queued events plus the active callback. Overflow disconnects that observer, clears its queue, and ends its subscription with `overflow`.
Other observers continue independently. The helper stores no replay history. The host owns durable replay.

`maxObservers` counts observer leases, including retired observers whose scheduled drain or active callback has not settled.
Disposal cannot repeatedly free admission while callbacks remain hung. Admission recovers when those callbacks settle.
`subscribe` returns a `capacity` error when all leases are occupied, or a `closed` error after stream closure.
An already-aborted signal returns an immediately ended `aborted` subscription without consuming a lease, unless the stream is closed.

Disposal, input abort, overflow, listener failure, and close settle `Subscription.ended` once with the corresponding terminal reason.
They detach the input abort handler, clear queued references, abort the callback's delivery signal, and prevent later delivery.
`ended` means detached. An arbitrary consumer callback may still run, and a late rejection is consumed.
Listener throws and rejections end only that subscription with `listener-error`. Repeated disposal and close have no further effect.
`publish` returns `closed` after closure. Delivery cancellation never cancels native work, and the helper accepts no native cancellation callback.
Installed-consumer tests verify these delivery guarantees. Native event mapping and native-operation cancellation require separate adapter qualification.

## Scoped authentication

`createAuthContext` snapshots a host-authorized engine, account, adapter instance, session, and route.
Direct and LiteLLM configurations remain distinct. Proxy configuration requires its endpoint, protocol, and proxy credential purpose.
The host authorizes endpoints, including private HTTP proxies. URL checks establish syntax only.
Adapters validate protocol, native options, direct credential material, and any conflicting authentication headers against their native family.
Opaque native options and direct material retain their identity and are not deep-frozen.
Known scope, route, headers, boundary, and proxy credential fields are copied and frozen.

Adapters call `resolve` at each supported invocation or request boundary, including resumed work.
Each call supplies a fresh frozen context and the caller's abort signal to the host resolver.
The helper does not cache, coalesce, retry, choose fallback routes, or dispatch native requests.
Cancellation is cooperative during resolution and checked before and after it.
Safe failure messages exclude raw resolver errors and credentials. A proxy purpose label is a host assertion, not issuer verification.
Installed fixtures verify scope isolation, credential rotation, cancellation, route preservation, and redacted failures.
Native boundary wiring and direct/LiteLLM qualification remain adapter obligations.

## Native interactions and continuations

Approval, tool, and delegation targets carry exact native identifiers and a bound `SessionReference`.
Host correlation IDs do not replace native identifiers. Approvals can exist without a tool call.
`PendingApproval` advertises bounded native choice IDs with their labels, native policy, and request payloads.
The host policy selects an advertised choice or withholds locally. There is no default policy or universal permit/deny translation.
A thrown policy leaves the request pending. Withholding is not a dispatch continuation.
Finite advertised choices form this capability's boundary. Adapters must preserve parameterized native permissions through an evidence-backed extension when needed.

Tool result, native delivery confirmation, and tool effects are separate facts. Failure or cancellation does not prove that no effect occurred.
Unknown delivery or effects never authorize retries. Delegated work distinguishes completed, cancelled, and unknown outcomes.
`parseInteractionContinuation` validates both the supplied expected interaction and the continuation envelope.
It matches every binding field, session token, target kind, applicable native ID, tool presence, and advertised choice.
Delegations require the exact child target set regardless of order, without duplicates or missing or extra children.
Choice and delegation lists must be nonempty and at most 1000 entries, exposed by `interactionLimits`.
Known envelopes are copied and frozen. Native extension labels require bounded namespaces and positive safe integer schema versions.
Opaque `data` remains unknown and retains its identity; this promises neither deep immutability, serialization, nor native semantic validation.
Input-access exceptions return a safe `invalid-input` error without the raw exception.
Successful parsing proves correspondence to the supplied expected record. Native pending state, consumption, dispatch, persistence, and reconciliation remain later work.
Installed fixtures verify correspondence, fact combinations, mutation isolation, malformed inputs, and public type discrimination.

## Scoped filesystem discovery

`discoverFiles<T>` enumerates one explicit host-authorized root per call and validates its exact account/scope binding before I/O.
`namespace: 'host-stable'` asserts that the host controls stable path resolution throughout the call, including ancestors and mount topology.
Portable Node path APIs cannot prove confinement against hostile concurrent ancestor swaps. Rechecks do not establish that security property.
The root is canonicalized once, allowing aliases such as macOS `/tmp`. Descendant symlinks and nonregular leaves are rejected.
Files use no-follow, nonblocking opens, bigint device/inode checks, and reads from the same verified handle.
Relative names describe entries; they are not reopenable path leases. Hardlink provenance is not established.

`FileDiscoveryBounds` adds depth, per-file bytes, and total bytes to the session discovery budgets.
`fileDiscoveryLimits` exposes ceilings of depth 64, 16 MiB per file, and 64 MiB total bytes, alongside session limits.
Enumeration is iterative depth-first with bounded directory buffering. Every returned entry counts before filtering.
Root depth is zero. Skipped descent marks depth truncation. Exact budget exhaustion reports truncation without unbudgeted EOF probes.
Actual read bytes include an oversize sentinel. Incomplete or oversized contents are not decoded.
Pages distinguish completion, cancellation, and named truncation, with examined/read counts and corrupt, inaccessible, absent, rejected, and oversized skips.
Errors expose fixed codes without OS text, absolute candidate paths, or contents. Configuration access is captured once before validation.

The adapter supplies trusted synchronous bounded selection and decoding callbacks. Their allocation and returned values are outside the byte-read budget.
Adapters validate decoded native session references against the authorized binding before publishing them.
Cancellation and deadlines are cooperative; outstanding I/O settles before handle cleanup. Content can change during reads.
The helper does not write, lock, migrate, or dispatch native history. Reads can update access metadata.
Real temporary filesystem fixtures verify traversal, symlinks, permissions, budgets, replacement, cancellation, and cleanup.
These tests do not qualify native formats or prove confinement when the host's namespace-stability precondition is false.

## Safe diagnostics

`createSafeError` lets trusted adapters assert one of the qualified adapter or authentication error codes.
Each code has a fixed message. It accepts no raw message or metadata, and malformed runtime codes become `native-failure`.
`normalizeError` preserves only exact error objects created by this module instance, using private identity tracking.
Clones, structural lookalikes, proxies, foreign package instances, and arbitrary native errors become the fixed native failure.
It never reads properties, prototypes, getters, keys, or coercion hooks on raw values.

`summarizeDiagnostic` wraps an owned error or suppresses an endpoint, headers, credentials, checkpoint, or native payload in full.
Invalid runtime categories become a native-data redaction. Returned records and nested errors are frozen.
`serializeDiagnostic` emits precomputed JSON only for owned records; all other inputs produce the fixed native-data redaction.
Every supported projection is at most 512 UTF-8 bytes with fixed depth and vocabulary.
These helpers do not sanitize arbitrary host events or establish whether an adapter's asserted condition is true.
Adapters must qualify native error mappings separately. No existing module's error is automatically trusted by structural similarity.
## Single-attempt dispatch

`createDispatchOperation` captures an immutable host operation identity and either an existing session reference or a new-session binding.
The host supplies `recordIntent` and a native dispatch closure. Before intent resolves, the host must durably record the exact command and acquire admission.
The helper does not store that command, persist receipts, or enforce uniqueness across handles or processes.
`run()` reserves and returns the same promise before any callback or lifecycle publication. One handle enters native dispatch at most once.
The original result and promise remain stable for the lifetime of the handle.

An abort before native entry or an intent failure returns `not-dispatched`. The signal is checked after lifecycle publication immediately before entry.
After entry, throws, rejections, malformed observations, and mismatched evidence become `outcome-unknown`, including cancellation errors.
Cancellation cannot establish rollback or nonacceptance. No retry, timeout, or polling is provided.
Callbacks are cooperative; awaiting this handle's own `run()` inside a callback creates a dependency cycle.

Native observations distinguish unknown, accepted, and conclusive results. Conclusive results retain the adapter's exact result, including rejection or pending interaction.
Evidence carries the exact host identity, a native acknowledgement source, a separately named native operation reference or null, and a native extension.
Known envelopes are copied and frozen; opaque native data and generic results retain their original identity.
Validation establishes correspondence with the requested identity, not the native authority of an adapter's assertion.
Malformed construction, including proxy signals, exposes a fixed `TypeError` without raw error data and executes no callbacks.
If a retained signal later becomes unreadable, the cached `run()` promise rejects with `TypeError('Invalid dispatch signal.')` before native entry.
It emits no fabricated terminal observation. The supported Node getter does not prove an unforgeable signal brand; the helper inspects no private signal state.

Borrowed lifecycle publication contains only a phase. Publisher failures, closed streams, overflow, and observer failures cannot change native execution or its result.
The host remains responsible for durable outcome storage and exclusion among duplicate identities.
Both fresh and recovery handles expose explicit `reconcile(signal)`. Recovery mode has no `run()`, native dispatch callback, or intent callback.
It can restore a prior native observation or start with identity-only uncertainty. The host supplies authorized durable context and any trusted prior receipt.
Fresh reconciliation returns `not-ready` until the run snapshot exists and never starts execution. If run rejects from signal invalidation, no snapshot exists and reconciliation remains not-ready.

One outstanding lookup promise coalesces concurrent and reentrant calls. The first signal owns that lookup; later signals are ignored.
Lookups require the exact operation identity and an `authoritative-native-lookup` source for positive observations.
Unknown, failed, malformed, aborted, or conflicting lookups preserve prior knowledge. An absent record cannot establish nonacceptance or safe retry.
A known native operation reference survives a null lookup reference, and a conflicting nonnull reference is rejected.
Conclusive observations latch permanently; restored conclusive and fresh not-dispatched observations require no lookup.
The original fresh run promise and snapshot never change as reconciliation refines the separate current snapshot.
An invalid lookup signal rejects with a fixed `TypeError`; cancellation cannot invalidate already returned positive native evidence.
The helper checks correspondence, not native authority. It never dispatches during recovery, retries a command, or persists an outcome.

## Native prerequisites and checked evidence

Node 24.22.3 with npm 11.19.1 is the selected foundation toolchain.
TypeScript 7.0.2 compiles the package with strict NodeNext settings, ES2022 libraries, and Node declarations.
TypeScript consumers need `@types/node` as a development dependency for public `AbortSignal` contracts.
The package and installed consumer checks use pinned `@types/node` 24.19.2 without DOM libraries.
The supported Node range stays within this selected major until other versions receive validation.
[Node's release index](https://nodejs.org/dist/index.json) supplied the selected runtime and bundled npm evidence checked on 2026-11-13.

The registry metadata below was checked on 2026-11-13 during foundation design.
These versions are research evidence, not installed dependencies or live qualification results.

| Prospective dependency | Checked version | Declared Node prerequisite |
| --- | --- | --- |
| [Claude Agent SDK](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.323) | 0.3.323 | `>=18.14.0` |
| [Codex SDK](https://registry.npmjs.org/@openai/codex-sdk/0.169.0) | 0.169.0 | `>=18` |
| [Codex CLI](https://registry.npmjs.org/@openai/codex/0.169.0) | 0.169.0 | `>=16` |
| [Pi coding agent](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.5.2) | 1.5.2 | `>=22.19.0` |
| [Pi agent core](https://registry.npmjs.org/@earendil-works/pi-agent-core/1.5.2) | 1.5.2 | `>=22.19.0` |
| [Pi AI](https://registry.npmjs.org/@earendil-works/pi-ai/1.5.2) | 1.5.2 | `>=22.19.0` |

The [Codex SDK documentation](https://developers.openai.com/codex/sdk/) specifies server-side Node 18 or later.
[Codex app-server](https://developers.openai.com/codex/app-server/) uses a native Codex process.
The checked Codex launcher and Claude SDK manifests include platform-specific optional runtime packages.
The current [Pi source repository](https://github.com/earendil-works/pi) is authoritative for the checked `@earendil-works` packages.
Native integration qualification must establish executable availability, supported authentication, and authorized session access on the target host.
Dependency engine declarations alone do not establish those facts.
Switchboard's MIT license does not establish the license terms of prospective native dependencies.

All three native integrations require separate direct and LiteLLM qualification.
Record exact native, proxy, model, protocol, and source versions with configuration that excludes secrets.
Distinguish deterministic fixture checks from live evidence.
All GitHub Actions must use Linux runners. Record macOS native evidence separately.
The temporary consumer check proves packaging on the machine running it. It does not qualify a native integration on either platform.

## Basic AG-UI projection

Hosts serialize `accept` calls and publish each successful batch in order. Local validation failures emit nothing and fault the actor.
Success and cancellation require every opened stream or step to close. Only observed native failure abandons open entities.
Ended tool arguments can remain unanswered; an optional success `pendingTools` list must match first-start order exactly.
`NativeRef` IDs use the public JSON tuple `[1, sourceKey, kind, scope, id]`. Message references share one identity domain across text and tool results.
The tuple preserves lone UTF-16 surrogates and omits host run IDs so stable native references survive resume.
These identifiers are reversible public values. The host must supply authorized public namespaces and IDs.
Adapters supply resolved ownership on every entity fact. Omission means root ownership, including text and tool continuations.
When native continuations omit attribution, the adapter carries forward the opener owner before calling `accept`.
Identical closed text/tool streams may reopen. Owner or opener disagreement faults the actor.
Step identity becomes `stepName`; an observed display label is retained in `metadata.switchboard.name`.
Returned events and nested JSON are detached and recursively readonly. No native availability or qualification follows from representation fixtures.

## AG-UI values and explicit public data

State snapshots and deltas preserve bounded JSON and all six JSON Patch operations, including extra operation members.
The mapper forwards patches without applying them or retaining materialized state. Native producers remain responsible for patch applicability.
Activity snapshots establish a message baseline. Replacing snapshots can re-mint ownership and type; `replace: false` retains the established values.
Activity deltas require that baseline and matching resolved ownership, and can change the activity type.
Raw and custom facts require nonempty namespace and version strings plus selected `publicPayload`. No raw native error or private payload is selected automatically.
JSON validation establishes shape and budgets; it cannot establish that selected values are safe to publish.
A valid `not-observable` fact emits an empty batch without fabricating a native event. The host records the gap independently.
`describeProjection` reports represented families separately from caller-asserted native availability and qualification.
Missing assertions remain undeclared. Mapping or fixture success never upgrades native availability or qualification.
