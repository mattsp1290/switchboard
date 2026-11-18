# Codex integration selection

Codex 0.169.0 public app-server is selected for implementation.
Use a thin adapter around its public protocol and preserve the native agent loop, tools, approvals, configuration, session IDs, and opaque events.
Inventory-driven path inspection and retained unidentified-file diagnostics resolve the exact unknown-omission selection blocker.
Completed adapters, broader discovery coverage, and live journeys remain downstream requirements. Selection does not qualify their support.

The discovery qualifier uses a private shared wire codec for UTF-8 JSONL and envelope validation.
Each frame is bounded to 1,048,576 bytes excluding LF and including CR; each input chunk is bounded to 2,097,151 bytes.
The client's separate cumulative stdout refusal at 2 MiB and 128-request limit remain in place.
Malformed, truncated, oversized, or routing-incompatible input, including a reply carrying both result and error, stops the owned child. Duplicate JSON member names follow JSON.parse last-wins and are not detected. Unknown payload members remain available to method decoders.
Outgoing serialization must preserve routing kind, method, ID, and the result/error branch. Serialization work inside caller payloads is outside the codec's storage bound.
A consumer exception closes the reader and propagates unchanged. Reentrant push closes the reader and throws; callback close and end remain allowed.
The codec owns only framing storage. The qualifier retains shutdown, final drain, failure identity, progress, and refusal of server requests.
This does not qualify transport correlation, approval handling, a native adapter, or live provider routes.

Numeric routing IDs must be safe integers other than negative zero, while numeric `0` and string `"0"` remain valid and distinct.

## Evidence and pins

The [native pins](../../spikes/codex-native/pins.json) identify the official Linux arm64 and x64 archives by SHA512 and the Node image by OCI digest. The [native qualification](codex-native-api.md) records actual app-server execution against a synthetic loopback Responses service, independently of the SDK. The [discovery qualification](codex-discovery.md) records read-only-source discovery and inspection. Neither establishes a real provider or LiteLLM support claim. These standalone app-server fixtures use synthetic immutable roots. Global native SDK import confinement remains unqualified.

[PR13](https://github.com/mattsp1290/switchboard/pull/13), merged as `d3a25d5`, supplies native lifecycle, auth, and generated-binding evidence. [PR22](https://github.com/mattsp1290/switchboard/pull/22), merged as `1e1d8e1`, supplies indexed/unindexed discovery through a private index. The retained local execution reports are `/tmp/switchboard-codex-native-parent-proof.json`, `/Users/lunus/git/switchboard/.audit/codex-discovery-owner-proof.json`, and `/tmp/switchboard-consumer-d4e36e8d-native/native-x64-mounted.log`. The latter x64 execution uses QEMU. These reports are execution evidence, not a fresh remote CI assertion.

The earlier arm64 known-target inspection run is retained at `/Users/lunus/git/switchboard/.audit/codex-selection-read-proof-final.json`.
It includes bounded raw malformed-list replies, known-target read replies, native notifications, preservation assertions, and zero discovery inference.
[PR28](https://github.com/mattsp1290/switchboard/pull/28), merged as `da2a0ced218bcf72b34b7c8405ac72383f6c97c2`, adds inventory-driven public path inspection without known IDs.
Its retained parent arm64 report is `/Users/lunus/git/switchboard/.audit/codex-path-summary-fixed-parent.json`, SHA-256 `0f4f84e203d419060ae10de69a4732956aca18e5d7b74f7484e083a1aad1f881`.
That report records nine admitted file observations per path mode. Indexed and unindexed each return eight summaries for seven native IDs.
Malformed returns seven summaries for six IDs and two `-32603` failures, including the harmless auxiliary file. These are failed-file observations, not a corruption taxonomy.
Inventory entry and byte totals are specific to each execution. The parent report's indexed totals are 28 entries and 3,757,396 accounted bytes.
[PR30](https://github.com/mattsp1290/switchboard/pull/30), merged as `8976667a39467c1233ebcde557a583f3fbfa158e`, adds the retained diagnostics contract and its installed consumer proof.

| Component | Exact inspected revision | License and evidence |
| --- | --- | --- |
| Native app-server and protocol | CLI `0.169.0`, source [`d32063f96c2dff1dc96af839b3952abb6acfeda4`](https://github.com/openai/codex/tree/d32063f96c2dff1dc96af839b3952abb6acfeda4) | Apache-2.0 source. Verified official Linux arm64 and x64 execution with synthetic endpoints. |
| SDK and CLI wrapper | `@openai/codex-sdk@0.169.0`, `@openai/codex@0.169.0` | Apache-2.0. Frozen source/process-fixture evidence only. SDK not imported by this update. |
| AI SDK harness | `@ai-sdk/harness-codex@1.0.185` | Apache-2.0 metadata. Packaged bridge pins CLI `0.167.0`. No native parity qualification. |
| ACP adapter | `@zed-industries/codex-acp@0.16.0`, source [`bb590500e8646f6daf879b8b3c6a659fbd29017d`](https://github.com/zed-industries/codex-acp/tree/bb590500e8646f6daf879b8b3c6a659fbd29017d) | Apache-2.0 metadata/README. Cargo pins Codex Rust `0.137.0` and ACP Rust `0.14.0`. |
| Consumer toolchain | Node `24.22.3`, TypeScript `7.0.2`, Node declarations `24.19.2` | Strict NodeNext, ES2022 without DOM, `skipLibCheck:false`. |

[Historical pins](../../spikes/codex/pins.json) and [historical results](../../spikes/codex/results.txt) are copied unchanged from local commit `63d13e6d11a76275d868c173f7e003c69f82d5ae`. That frozen SDK experiment used a fake executable, not native Codex. Its runner is deliberately dormant and is not adopted here. Its success label does not qualify native discovery, authentication, or routing. Artifact licenses do not grant provider access, subscription forwarding, or account entitlements. Transitive license review remains required if either wrapper is later reused.

## Selection matrix

| Requirement | Supported API and measured evidence | Selection status and restriction |
| --- | --- | --- |
| Public protocol and bindings | Native `initialize`, `thread/start`, `turn/start`, list/read/resume, `getConversationSummary({ rolloutPath })`, and `turn/interrupt` run. Historical qualification compiled all 784 generated public TypeScript files after 1,766 verified relative import-specifier rewrites. | Selected for implementation. The qualifier now consumes a shared validated transform. The exact RequestId leaf and upstream notices are retained with [immutable provenance](../../THIRD_PARTY_NOTICES.md). Fresh native CI must establish generator byte parity and strict consumer compilation at this head. Raw generated imports are not directly NodeNext-ready. |
| Indexed and unindexed external discovery | Native-created immutable history is mounted read-only. Supported `sqlite_home` and `log_dir` redirect backfill and logs to private directories. Both cases return compatible native IDs. Source hashes match through startup, listing/inspection, shutdown, and the host container lifecycle. | Source-write and compatible-unindexed questions resolved for the confined synthetic roots. Auxiliary writes are bounded and intentional. Production stable-root admission remains a host obligation. |
| Filters, accounts, and bounds | Explicit source/provider/exact-cwd/archive/account parameters and bounded cursors run. A separate root and symlinks contribute no IDs. | Queries select after native reads. They do not authorize root access or resume. API-key auth sees both synthetic accounts; unattributed history is shared. Pagination does not bound startup backfill bytes. |
| Known-target inspection | Public `thread/read` with `includeTurns:true` returns the valid ID. Corrupt-known returns `-32603` with metadata-read/empty-rollout failure. A distinct valid UUID known absent from the fixture returns `-32600`, `thread not loaded`. | A read-only known-target failure is distinguishable in this fixture. The valid paginated thread returns `turns:[]` and a hydration deprecation notice. No full-history hydration claim follows. Never classify every `-32603` as corruption or every `thread not loaded` as universal absence. |
| Discovery completeness and bad sessions | Listing still omits malformed history without an identifying warning. Bounded inventory independently supplies paths to public `getConversationSummary`. The native probe retains failed files beside compatible summaries. The shared contract retains `file-inspection-failed` diagnostics beside sessions across every existing page termination. | Exact unknown-file selection mapping resolved. Neither an omitted record nor a generic native error establishes corruption. The adapter must qualify the composition, enumeration coverage, wire validation, redaction, and budgets. List exhaustion alone cannot support a complete empty history. |
| Inaccessible, old-format, and busy sessions | An invalid sessions-directory layout returns `-32603` with `Not a directory`. | `ENOTDIR` proves an explicit root failure only. Permission-denied files, old-format classification, and externally busy sessions remain unqualified. The [Legacy tail experiment](codex-discovery.md#legacy-tail-record-read-experiment) observes one syntax property of current-native Legacy history only. Do not migrate, silently fork, or race a second writer. |
| External continuation and uncertainty | A second native process discovers/resumes the same persisted ID and appends while preserving the saved byte prefix. Interrupted streaming is confirmed. Accepted disconnect/process-loss fixtures do not resubmit inference with request/stream retries zero. | Preserve no-blind-retry. Start-only IDs are not yet durable. Ambiguous acceptance may return outcome-unknown; universal terminal reconstruction and exactly-once effects are not claimed. |
| Native approvals and extensions | Native command approval is declined and the command marker remains absent. Public protocol exposes file/permission approvals, user input, MCP elicitation, and dynamic tools. | Preserve native controls. Successful command/file/permission/user-input round trips and unknown-event handling remain downstream qualification. Do not replace them with approval `never`. |
| Command-backed authentication | Synthetic native HTTP/SSE runs prove token caching, age-based refresh, renewal after rejected 401, fresh-process reacquisition, and failure behavior. | Selected auth API with conditional host-policy restrictions below. No live OAuth, token revocation, or credential-isolation claim. |
| Native direct | Native protocol runs against a local synthetic custom provider. | Required downstream live qualification. Real direct provider/model behavior is unqualified. |
| LiteLLM same-family | Source/config and native synthetic execution establish a dedicated provider, `/v1` base URL, Responses HTTP/SSE, and model selection. | Required downstream live LiteLLM qualification. No support claim from an OpenAI-style fixture. |
| LiteLLM cross-provider | The same configurable Responses path is available. | Required downstream live cross-provider qualification, including native tool/reasoning/attachment/compaction restrictions and extension route conflicts. No feature equivalence is inferred. |

Rebuilding a private index does not establish preservation of SQLite-only titles, sections, or projects. Original database bytes remain intact. This fidelity limit does not create an independent universal UI-metadata selection gate.

A failed supported known-target read can expose a native failure for a previously authorized reference. It cannot inventory unknown omitted files.
Authorized bounded inventory now supplies paths independently of listing and fixture IDs to the public [path-summary request](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server-protocol/schema/typescript/GetConversationSummaryParams.ts).
The [probe](../../spikes/codex-native/discovery.mjs) sends only `rolloutPath`. It uses the fixture manifest afterward for expected-identity assertions.
No guessed ID, private history parser, or SQLite query selects a request.
The [shared discovery contract](../architecture/boundaries.md) can retain actual failed inspections beside valid sessions on complete, every named truncation, and cancelled pages.
Its call-local diagnostic subjects grant no session access. The adapter must construct redacted tokens, retain settled observations before later aborts, enforce budgets, and release temporary associations.
Raw native messages and the qualifier's relative-path tokens cannot cross that contract. Controlled consumer tests prove representation, not a native adapter.

The observed failed files receive per-request replies while the same native process continues discovery. They are not fatal scope-wide failures.
The separate `ENOTDIR` fixture fails listing without earlier path enumeration. Production admission must reject invalid history-directory layouts before useful discovery.
The spike's generic inventory admission does not establish that production check.
Fatal scope-wide failure after useful observations still needs a public representation and fault tests before adapter support.
The qualifier's retained raw partial evidence is not such an outcome. Never report a fatal failure as complete, cancelled, or an unrelated budget stop.

Path-summary success establishes native metadata only. It does not establish full-history validity, physical-byte identity, or production namespace stability.
The API is [deprecated in the pinned source](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server-protocol/src/protocol/common.rs#L1583). Selection promises no survival in later versions.
The [discovery qualification](codex-discovery.md) retains limits for permissions, old formats, busy sessions, unreadable-file account attribution, aliases, revert files, compression, attached-thread eligibility, stale indexes, and authorized resume.
Host admission must separately qualify stable authorized roots, symlink and ancestor races, and oversized or unreadable roots before native execution.

## Authentication and routing restrictions

Native custom-provider configuration uses `wire_api:"responses"`, `supports_websockets:false`, and an explicit `/v1` base URL. Actual native inference posts to `/v1/responses` and consumes SSE. Chat Completions is not a fallback. LiteLLM owns upstream secrets. The host supplies only the approved proxy credential or renewable command and controls the command, environment, cwd, and timeout. Native command diagnostics may contain stderr and require redaction before forwarding.

The native auth cache is not a universal authorization veto. Failed proactive refresh can reuse a still-valid cached bearer. Initial helper failure can dispatch without Authorization to the configured endpoint, where the fixture returns 401. A rejected bearer plus failed renewal produces no accepted retry. None of these observations shows a silent fallback to a direct provider. Refresh age does not establish token expiry or revocation.

`src/adapters/codex/proxy.ts` implements this path (codex-native-api.md, LiteLLM route): `codexProxyConfig` generates the provider entry with command auth only and both retry limits at zero, and `startCodexCredentialBroker` resolves the host's LiteLLM credential at each helper invocation through a unix-socket broker, never through argv, environment or files. Both take the model from the route, and execution refuses any other model on a routed session. An initial helper failure dispatches without Authorization to the proxy only (no direct fallback, because `base_url` is the proxy), subscription passthrough is absent, and non-empty `AuthRoute.headers` are refused. The local native check covers rotation after a 401, resume in a new process, resolver failure and two parallel brokers, all synthetic loopback.

Host invocation denial must prevent invocation. If host policy requires zero dispatch after every later native helper failure, this native auth path has a conditional policy conflict unless additional enforcement is separately qualified. Preflight alone cannot control later internal refresh. Do not substitute a static global token or silently disable renewable proxy credentials. Both retry limits remain explicitly zero for the tested no-resubmission claim; 401 recovery is measured separately from retrying accepted work.

## Reuse decision

The SDK offers `startThread`, `runStreamed`, and deferred `resumeThread(id)` around `codex exec --experimental-json`. It has no discovery/read API or interactive approval-response callback. Frozen strict-consumer evidence records TS2307 for undeclared `@modelcontextprotocol/sdk/types.js` in its published declarations. That defect rejects the wrapper as a drop-in foundation; it does not invalidate qualified public app-server bindings. No shim, DOM library, `skipLibCheck`, or SDK import is introduced.

The inspected AI harness's `src/bridge/codex-app-server-driver.ts` forces `approvalPolicy:'never'` and `danger-full-access`, rejects server requests except `item/tool/call`, and pins an older CLI. ACP's older native dependency lacks exact-version discovery, auth, and feature-parity evidence. Both are rejected as drop-in foundations. Reuse of projections requires a separate parity experiment. A thin app-server adapter preserves the native loop without inheriting those known conflicts.

## Reproduction and remaining work

Run the pinned [native qualification entry point](codex-native-api.md) with an official archive matching [pins.json](../../spikes/codex-native/pins.json).
It unconditionally runs inventory-driven path inspection in indexed, unindexed, and malformed modes, plus the malformed variant's three known-target reads.
It emits bounded raw replies and notifications and checks source preservation and zero discovery inference through shutdown.
The pinned environment uses Codex `0.169.0`, Node `24.22.3`, TypeScript `7.0.2`, Node declarations `24.19.2`, and image `node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`.
No historical SDK runner or module import is needed. The retained parent report above proves Linux arm64 execution.
The [Linux x64 native CI job](https://github.com/mattsp1290/switchboard/actions/runs/43554616649/job/132324530599) passed at source `7be6e58ca155905af27b6d31f415fa84570aafe1`.
Its logs identify the x64 archive, `linux/amd64` container, strict generated-binding check, and path inspection results.
This CI execution is separate from the earlier local QEMU report. Neither Linux environment qualifies native macOS behavior.

The original downstream tasks retain their acceptance requirements:

- `pg51` composes discovery, reference validation and resume preparation in the private `src/adapters/codex/sessions.ts`, mapping each required outcome to a core code or an explicit unqualified label; see [Adapter composition and native proof](codex-discovery.md#adapter-composition-and-native-proof). Stable root admission stays a host obligation, and the limits above that have no native signal (external busy, permission-denied, creator account) stay visibly unqualified.
- `x9av` owns create/turn/resume execution, separate-session concurrency, ordering, backpressure, cleanup, and uncertain acceptance without duplicate dispatch, in the private `src/adapters/codex/execution.ts`; see [Codex execution qualification](codex-execution.md). Its native proof is recorded on linux/arm64 and x64. `118i` owns approval acceptance, denial, invalid continuation, delivery distinctions, busy coordination, and cancellation while streaming, running tools, or awaiting approval, in the private `src/adapters/codex/interaction.ts`; see [Codex interaction qualification](codex-interaction.md).
- `z8tq` owns native configuration, tools/extensions, permission controls, opaque events, and visible feature/routing conflicts. No forced allow-all policy or replacement model loop is permitted. Typed host settings for `thread/start`, `thread/resume` and `turn/start` live in the private `src/adapters/codex/features.ts`: raw native keys pass through unchanged, the adapter adds no default, a typed value that contradicts a raw key or a protocol combination rule is `invalid-input` before anything is sent, and `codexFeatureCapabilities` labels each feature `qualified`, `fixture-only`, `typed-unqualified` or `passthrough-unqualified`; see [Native feature settings](codex-native-api.md#native-feature-settings). Routing conflicts, such as raw `modelProvider` or `config.model_provider` against a typed `model`, are not detected here: under a proxy route execution refuses raw `modelProvider` and `config` (ai7m), and any `model`, `collaborationMode` or `allowProviderModelFallback` that is not the route model (me4l), and `routing` is labeled `fixture-only` by `me4l`.
- `me4l` implements Responses HTTP/SSE routing, model mapping, renewable credentials at native boundaries, isolation/redaction, and no direct fallback in `src/adapters/codex/proxy.ts`, with synthetic loopback evidence only (Authentication and routing restrictions). Cached-token reuse and initial-helper-failure restrictions remain as measured above. Stronger host fail-closed refresh policy needs separate qualification.
- `mebb` owns the integrated packed adapter and crash/fault windows. `une2` owns live direct qualification. `ov4y` owns live LiteLLM evidence with separately recorded same-family and cross-provider journeys. Synthetic Responses execution qualifies neither live route.
- `bzn9`, `e2oc`, and `q5wd` own packed exports/dependency/license checks, separate native macOS evidence, and final release reconciliation. Global native SDK import confinement remains unqualified.

All three engines, direct operation, LiteLLM, native features, external-session discovery/resume, and no-blind-retry remain required by the original plan.
The app-server adapter must also meet the [native process requirements](../architecture/boundaries.md#adapter-contracts).
The exact API-selection blocker is resolved. Unqualified downstream behavior still blocks its corresponding support or release claim.
Oversized downstream work must be split without dropping an acceptance journey.
