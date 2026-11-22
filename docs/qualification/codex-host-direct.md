# Codex direct host contract and qualification

The host adapter targets app-server **0.169.0**. It does not detect or refuse running-binary version skew. `initialize.userAgent` is untyped; the session binding's nativeVersion check validates persisted references, not the executable. Hosts retain their own exact-version and login checks. This milestone does not upgrade the pin.

## Approvals and held turns

Direct native configuration accepts `approvalPolicy: 'never' | 'untrusted' | 'on-request'`, `approvalsReviewer: 'user' | 'auto_review' | 'guardian_subagent'`, model, effort and `activity: 'items'`. Omitted policy still sends never. Model is placed on thread/start and thread/resume; effort on turn/start. A route refuses non-never policy, any reviewer or any direct model override before launch. Route effort is allowed.

`pending` and inspect expose both calls and approvals. Approvals-only pauses return immediately; host calls use the existing 30 ms quiet window. A continuation covers every target exactly once, using `parseInteractionContinuation`. Invalid/missing/duplicate/stale targets and unoffered choices produce no reply. The complete set is checked again after host intent; a changed set prevents the first reply. Each transport handler retains its withdrawal guard until writer entry, so a queued positive reply is withheld if native resolves or ends its target before the write enters. A failure after any earlier reply remains outcome-unknown. Locally queued replies do not establish native acceptance. A limit known before replies retains the originating turn’s accepted evidence across pauses. A limit encountered after local replies keeps their unknown write certainty. No result permits replay.

PendingApproval.request has namespace `codex-app-server/server-request`, schemaVersion 1 and data `{ method, id, params }`. Command params include threadId, turnId, itemId, reason?, command?, cwd? and availableDecisions?. File-change params include threadId, turnId, itemId, reason? and grantRoot?. String choice IDs are native strings. A single-key object choice has ID `<key>:<index>` and maps to the stored object, never a reparsed string. Native 0.169.0 file-change choices are accept, acceptForSession, decline and cancel.

`target.tool.nativeToolCallId` equals the command/file-change item ID. File diffs are carried by the activity item, not the approval request. Inert tests cover file-change accept/cancel and exact public correlation. Native file-change evidence remains unqualified until its optional live scenario passes.

An interrupt applies to the native turn even between segments. Acknowledgement withdraws only the captured turn's unanswered interactions, without an approval decision. A late acknowledgement after the public deadline still emits withdrawals for that turn. Rejection yields unconfirmed-within-bound with bounded code/message evidence. One host-side native-turn monitor owns the completion and interrupt promise reactions; public polls remove their waiters on return. At most 63 interrupt waits and one segment wait are retained at once; excess concurrent waits return unconfirmed immediately. A host-attested process exit establishes that no native turn remains in flight without establishing its previous outcome.

Settlement envelopes use namespace `codex-app-server/interaction-settlement`, schemaVersion 1 and data `{ kind: 'withdrawn', by }`, `{ kind: 'expired' }` or `{ kind: 'lost', cause }`. Successful replies retain separate delivery events. Public host/codex enables no bridge expiry. The existing handlerTimeoutMs defaults to **180000**, range 1..2147483647, and ends the transport with lost/handler-timeout. Hosts set the desired approval hold window with that field. The private explicit-expiry bridge case still projects expired without ending transport.

Close does not guarantee draining queued events or settling interactions still held when it starts. Hosts clear their pending UI on close/process exit. An earlier detected process/transport loss is projected before stream retirement. No event claims process termination.

## Images and history

The host supplies PNG/JPEG data URLs, at most 16 per call and **4,194,304 decoded bytes total**. The shared parser checks canonical base64 (including padding bits), MIME agreement, positive size, count and aggregate bytes before decoded allocation. It performs no file/URL access, pixel decoding or resizing. Empty arrays retain the text path. Unsupported adapters refuse present nonempty or malformed media before native dispatch.

Direct native input is text followed by `{ type: 'image', url }` entries. The serialized text portion must fit the ordinary 1 MiB envelope budget, including escaping; the full image envelope must fit 8 MiB. Transport encoding remains the final authority. Ordinary outgoing and all routed frames remain at 1 MiB. Direct incoming frames permit 8 MiB, and direct channel callbacks permit 16 MiB minus one byte for paired echoes; a larger frame/callback still ends transport. Host launchers must split arbitrary callbacks at this bound.

Direct resume sends excludeTurns:true. The retained reply fields still bind thread, provider, model and sandbox. Routed resume is unchanged. History fingerprints hash exactly the opening-stat prefix, ignore later appends, and scan for the last task_complete turn ID. They retain O_NOFOLLOW, containment, ambiguity and file-identity checks. Symlinked session subdirectories are refused, including links contained within the home; canonical CODEX_HOME aliases remain supported. Total prefix limit is 256 MiB, per-line limit 8 MiB inclusive. Truncation, replacement, detectable same-size mutation and short reads make the fingerprint unavailable. Expected-history verification additionally refuses growth during the read before native resume. Hosts still own cross-process writer exclusion; a fingerprint does not establish an atomic external lock. Small histories preserve the byte-count/hash/turn tuple exactly. Rollback to the old code can make large image histories unavailable; it never permits deleting history.

The direct reader allocates 8 MiB per connection. The ordered intake queue permits at most `maxPending + maxHandlers + observationCapacity` frame references (currently 8 + 16 + 256 = 280); multiply by `maxInboundFrameBytes` for the conservative logical payload bound. Turn pre-ack staging independently retains at most 32 ordinary events and 32 distinct terminal candidates; overflow fails the segment promptly while leaving an unconcluded native turn available for interrupt. Encoded outgoing buffers admit at most `(maxWrites + maxHandlers) × (maxOutboundFrameBytes + 1)` logical bytes (currently 8 writes and 16 handlers). The 16 handler leases may additionally retain their incoming request objects (up to 128 MiB of shared logical payload). A 512-fact publication queue paces ordinary native bursts so synchronous consumers can drain between facts (at most `publicationCapacity × maxInboundFrameBytes` logical payload). Admission saturation flushes the real backlog into the existing observer windows, reporting overflow rather than silently dropping it; no history is replayed. Each lagging public observer retains at most `eventCapacity × maxInboundFrameBytes` logical payload (currently 64 events); multiply by `maxObservers` (currently 4) for independent windows before object/string overhead. Shared references mean these are conservative logical ceilings, not measured RSS.

## Command and file activity

Activity is opt-in. Every envelope uses namespace `codex-app-server/item`, schemaVersion 1, data `{ method, params }` with native params preserved.

| Method | Admitted content |
| --- | --- |
| item/started, item/completed | item.type commandExecution or fileChange |
| item/commandExecution/outputDelta | string itemId; native delta |
| item/fileChange/patchUpdated | string itemId; native changes |

Command items carry id, command, cwd, status, exitCode and aggregatedOutput. Native statuses include inProgress, completed, failed and declined. File items carry id, status and changes containing path, kind `{ type, move_path }` and diff. Patch updates carry itemId and changes. Fields are forwarded, not synthesized. User-message/image echoes, reasoning and other methods are excluded.

Ordered protocol intake admits requests and their following lifecycle facts outside the channel reader before asynchronous observation. Turn text and usage are accumulated before completion can settle a segment; discarded early notifications produce a failed result rather than a complete shortened transcript. Activity continues after completion and between segments, including older turns; other threads are excluded. Four observers each have capacity 64. A lagging observer ends with overflow; healthy observers continue, and there is no replay. Inspect recovers the current pending set, not activity history. RunObservation stays segment-scoped; AG-UI approval projection is deferred.

## Native errors

The generic failure and its existing write certainty are preserved. Optional nativeError contains source, code, message, info and truncated.

| Source | Code | Info |
| --- | --- | --- |
| turn/start-reply | numeric JSON-RPC code | null; RPC data omitted |
| turn.error | null | codexErrorInfo |
| error-notification | null | codexErrorInfo from a matching nonretry notification |

Messages are capped at 2048 UTF-8 bytes on code-point boundaries. Info is retained only when JSON fits 1024 bytes; otherwise null and truncated:true. Unsupported/cyclic info is discarded. additionalDetails and misalignment are omitted. Native messages are untrusted and may contain sensitive content; they are not automatically logged or guaranteed secret-free.

A matching nonretry error notification is cause evidence, never a terminal fact. Before acknowledgement, staging holds at most eight turn IDs for this thread; only the acknowledged turn's candidate binds. More than eight unrelated pre-ack identities can exhaust staging, leaving the optional cause unavailable; they never attach another turn’s cause. Older/wrong-thread/missing-identity/retryable notifications are ignored. RPC or terminal causes take precedence. The retained matching cause can accompany caller abort or process loss without a turn/completed notification; unacknowledged candidates never attach.

## Model catalog

Direct models.list sends model/list with includeHidden:true and optional cursor. It sends no limit, creates no thread, caches nothing and returns no partial result. It follows at most eight pages and accepts at most 1000 records, preserving order. Repeated cursors, excess pages/records, malformed fields or RPC errors fail native-failure. One five-second deadline covers the entire call. Caller cancellation or adapter close gives closed; deadline gives unavailable/models. Listing may overlap a text turn. A route reports unavailable because its model is fixed.

Each CodexHostModel has exactly model, displayName, hidden, isDefault and inputModalities. No provider/effort metadata is invented.

## Evidence

`tests/adapters/codex/host.test.mjs` covers approval-only/mixed pauses, offered object choices, validation with no writes, intent-time mutation, partial reply uncertainty, held tool/approval/mixed interrupt, late acknowledgement, rejection, loss/timeout/withdrawal, file-change accept/cancel correlation, late activity and overflow, all error sources and stale isolation, bounded catalog paging/cancellation, 4 MiB PNG/JPEG paired echoes, large history/resume and escaped text budgets. Transport/fingerprint suites cover frame/callback bounds, exact prefixes, append, replacement, mutation, short reads and size limits. Private interaction tests cover explicit expiry and normalized arbitrary abort reasons. The existing five conformance contracts and Crew route fixture remain regression checks.

These inert tests prove translation and lifecycle behavior, not live login, account catalog entitlement or image understanding. The installed-package fixture checks the public types without importing a native SDK through the root.

Live direct qualification is a separate owner-run gate at the exact pin. Until the script record below lists each mandatory scenario as passed, native command accept/cancel/held interrupt and the valid 4 MiB image journey are **not covered** by this document. Optional file/catalog scenarios are separately labelled. A branch and passing fixtures do not establish main-merge or consumer cutover acceptance.

### Native record — 2026-11-22

Codex executable SHA-256: `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002`, reported `codex-cli 0.169.0`. Direct ChatGPT login used a temporary dedicated home; credentials and disposable workspaces were removed after the run. The committed [redacted result](codex-host-direct-result.json) binds the proof to SHA-256 tree digests of the Codex host closure (`src/core`, `src/adapters/codex`, the root export/compiler configuration, qualification scripts and support files), plus package manifests, and the runtime paths `dist/core`, `dist/adapters/codex`, `dist/index.js` and package metadata. The invocation emits the host into a fresh private directory with JavaScript emission explicitly enabled, requires the emitted entry, then fingerprints and imports that output. The source fingerprint includes tsconfig.json. Command accept/cancel additionally require entry of the exact offered choice response into the writer. Those digests are checked again before the review checkpoint.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Command accept | Passed | One actual approval, native completed command activity, marker present |
| Command cancel | Passed | Correlated declined command item, matching native terminal before cleanup, idle public interrupt, marker absent; reply write certainty remains unknown |
| Held approval interrupt | Passed | Exact target withdrawn, inspect empty, marker absent, then a text follow-up completed on the same adapter; the JSON records acknowledgement and withdrawal evidence |
| Valid 4 MiB PNG | Passed | Complete result, then another text turn completed on the same connection |
| Native file-change | Not covered | Set QUALIFY_FILE_CHANGE=1; no tool/sandbox widening is allowed |
| Account model list | Not covered | Set QUALIFY_MODEL_LIST=1 |

The process-exit attestation must follow stdout close/drain; an earlier process exit event can discard trailing output and conservatively leave an unknown outcome.

The JSON records whether withdrawal followed the local interrupt acknowledgement or an earlier native signal. Local withdrawal alone does not claim that native resolved the held approval. File-change accept/cancel remains fixture evidence.

The durable redacted result records only hashes, native terminal status enums, scenario labels, counts and bounded result classifications. Cancellation is qualified from the declined item and native terminal; a locally submitted reply still does not prove native receipt, so its public failed result and baseline may retain outcome-unknown. Earlier exploratory reports are retained with the review artifacts; they do not qualify the final source.

This gate uses the vendored macOS arm64 binary; other platforms report unsupported-platform. Rerun after build with `CODEX_HOME=/absolute/dedicated/chatgpt-home SWITCHBOARD_QUALIFY_CODEX_HOST=1 npm run qualify:codex-host-direct`. The script refuses the default home, verifies the exact binary version, checks the exact synthetic command and workspace before approval, writes source/runtime hashes, statuses/counts and synthetic scenario labels, and leaves credentials out of its report. SIGINT/SIGTERM stop further scenarios and run owned-child cleanup; cleanup must confirm the owned process group has stopped and its parent has closed before deleting the fixture workspace. Adapter close rejection or timeout fails the scenario. Synthetic commands run with a disposable shell HOME and allow only a raw marker command or `/bin/sh -c`, excluding login-shell startup files. Any failed optional scenario also fails the gate. Its report path can be set with SWITCHBOARD_CODEX_HOST_REPORT.
