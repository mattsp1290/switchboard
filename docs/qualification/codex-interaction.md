# Native Codex interaction qualification

`src/adapters/codex/interaction.ts` is the private approval bridge over the private execution module (see [boundaries](../architecture/boundaries.md#private-codex-interaction)); cancellation is `CodexSession.interrupt()` in `src/adapters/codex/execution.ts`. Inert evidence is `tests/adapters/codex/interaction.test.mjs` and the interrupt tests in `tests/adapters/codex/execution.test.mjs`, which drive an in-memory app-server that records every reply frame. Native evidence is `spikes/codex-native/interaction-proof.mjs`.

## Status

**Native proof recorded.** [interaction-proof-result.json](../../spikes/codex-native/interaction-proof-result.json) has outcome `interaction-outcomes-confirmed`: identical pinned objects on linux/arm64 (coordinator, local) and linux/x64 (CI job 134512526517, run 44217989017) at da20172, with harness and N1–N5, N7–N9 true on both; the arm64 cleanup left no container and an empty `.work`. One value has a single-architecture source: after the fixture fix below, N8's `request_user_input` inference count (0 at da20172, when the call was never made) was re-taken from x64 CI at 069b309; arm64 has not run the fixed N8, and the coordinator reruns arm64 on the final head. Every later run, including CI x64 on every PR, fails on any other pinned value. The pin audit removed native notification order and N4's withdrawal source (which follows it) before recording, identically for both architectures: resolved, item and turn notifications come from separate native sources, and 0.169 cross-source order already varied in the execution proof (`thread/started`), so order stays in every report but is not pinned.

Observed natively on both architectures (0.169.0, `untrusted`/`read-only`):

- `cancel` leaves the command item `declined` and the turn `interrupted` after one inference (N1); `accept` runs the command (marker written) and the turn completes after a second inference (N2).
- An approval held for A does not repeat while B completes and a client `thread/read` replies; A cancelled ends `interrupted` (N3).
- `turn/interrupt` while held ends the turn `interrupted` within 5 s with no command item; the bridge settles the approval `withdrawn` with no decision frame (N4).
- SIGKILL while held: the turn settles `unconcluded`, the approval `lost`; resume on a fresh app-server shows the last turn `interrupted` with no command item, sends no server request and replays no approval (N5).
- Interrupt while an accepted `sleep 3; touch` runs ends the turn `interrupted` with no completed command item and no marker (N7).
- `request_user_input` is advertised (`request_permissions` is not), but its call reaches no client: the model's call and its continuation are two inferences, no server request arrives and the turn completes with a user and an agent message (N8). The da20172 runs never made the call because the fixture's marker pattern dropped `_`; the fixed pattern ran on x64 CI at 069b309 (job 134521071264), which differed from the da20172 pin only in that inference count, and the coordinator reruns arm64 on the final head.
- A host expiry's `-32000` fails the command item and the turn completes (N9). So native ends the turn after an interrupt or an error reply; an unanswered approval does not hold its lease past the turn.

Natively qualified before this proof (probe.mjs; [native API](codex-native-api.md)): a command approval reaches a v2 client under `approvalPolicy: 'untrusted'`, `sandbox: 'read-only'`, and a `decline` reply leaves the item `declined` with no effect; `turn/interrupt` ends a held turn `interrupted`.

Native fact (coordinator linux/arm64 run, 0.169.0, `untrusted`/`read-only`, no `experimentalApi`): every command approval carries `availableDecisions: ["accept", {"acceptWithExecpolicyAmendment": {...}}, "cancel"]` with no `decline` and no `approvalId`, and a numeric request id. `cancel` leaves the item `declined` and the turn `interrupted`. probe.mjs's unoffered `decline` was accepted on the wire, but the bridge offers only what the request lists, so a host `decline` is refused locally (`choice-mismatch`, nothing written); the host's deny is `cancel`. A refused reply leaves the approval live and answerable; one never answered settles `lost` with the transport's end reason as `cause` (that run's `decline`-only N1 and N3 ended `lost{handler-timeout}`).

## Wiring

1. `createCodexInteraction({ maxObservers, eventCapacity, maxSettled, maxPending, transport, expiry? })`; `maxPending < transport.maxHandlers`, `expiry.afterMs < transport.handlerTimeoutMs`, `expiry` defaults to `null`.
2. Pass its `onServerRequest` to `openCodexExecution`; `attach(session)` after each create or resume, before the first turn.
3. Render `pending` events, persist, then `reply({ value, recordIntent, signal })`. To cancel, `session.interrupt()` or choose the native `cancel` decision.

## Labels

| Signal | Bridge outcome | Evidence |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `pending`, choices exactly its `availableDecisions`: a string is its own choice, a single-key object is the opaque choice `<key>:<index>` whose reply is the request's own object verbatim; absent or unusable list `refused{malformed}` | qualified request (probe); N1 records the list |
| a choice the request did not offer (0.169: `decline`, `acceptForSession`) | `choice-mismatch`, nothing written, still pending | N1 |
| `cancel`, then `item/completed{declined}` | one `{decision:'cancel'}` frame; `observed` effect `known{none}` | declined item qualified (probe); N1 |
| `accept`, object decisions | one decision frame; effect `unknown` | unqualified; N2 records item and marker |
| `item/fileChange/requestApproval` | `pending`, its `availableDecisions` if present, else the bindings' four decisions | unqualified; triggered only if advertised |
| permissions, user input, elicitation, dynamic tool call, auth refresh, attestation, legacy v1, `currentTime/read`, unknown | `refused{unsupported}`, `-32601` | unqualified; N8 records reactions if advertised |
| malformed approval / unattached thread / beyond `maxPending` | `refused`, `-32602` / `-32601` / `-32000` | inert |
| native terminal, `serverRequest/resolved` or item completion while live | `settled{withdrawn}`, `-32000`, no decision | unqualified; N4 records the native fate |
| host-selected expiry | `settled{expired}`, `-32000`, delivery `unknown` | unqualified; N9 records the native reaction |
| transport end (eof, deadline, overflow, process exit) while live | `settled{lost, not-sent, cause}`, `cause` the transport end reason, nothing written | transport; N5 |
| `serverRequest/resolved` after a reply | `observed`; delivery stays `unknown` | unqualified; N1 records order (not pinned) |
| tool or delegation continuation | `unsupported` | Codex has no delegation request; dynamic tools need the experimental API |

## Native proof scenarios

`node spikes/codex-native/interaction-proof.mjs <codex-linux-<arch>.tgz> <arm64|x64>` compiles the product into owned work and runs one fresh container per scenario under the execution proof's Docker limits (`--network none`, read-only root, tmpfs `/tmp` and `/root`). `interaction-reader.mjs` plays the host as the execution reader does, with `accountProfile` and a synthetic API key, threads `{approvalPolicy:'untrusted', sandbox:'read-only'}` passed by the host, `maxHandlers: 4`, `maxPending: 3` and `handlerTimeoutMs: 15000`. The loopback service's `call-<name>` marker emits one `exec_command` function call when `exec_command` is advertised and answers text once the call output is in the history. Every report records each server request (method, id type, param keys, `approvalId` presence, `availableDecisions`), each bridge reply frame (answered method, kind, decision or code), bridge events, item and turn statuses, native notification order (N1, N2, N4, N7, N9), markers, inferences per marker, every native error reply raw and the stderr tail. Files are read only by explicit path.

| ID | Scenario | Checked | Recorded (pinned) |
| --- | --- | --- | --- |
| N1 | a not-offered `decline`, then native `cancel` and a duplicate reply | choices equal the request's `availableDecisions`, `decline` refused `choice-mismatch` with no frame, reply ok, duplicate refused, one `cancel` frame, marker absent, a terminal, qualified no-effect observed exactly when the item is `declined` | choices, item, terminal, inferences, request id types and offered decisions |
| N2 | accept `touch /tmp/n2-marker` | reply ok, duplicate refused, one `accept` frame, a terminal | terminal, item, marker, inferences |
| N3 | A's approval held while B runs an answered turn and a client `thread/read` | B completes while A pends, read replied, A cancelled reaches a terminal, transport only caller-closed | concurrent A requests, A terminal |
| N4 | `session.interrupt()` while held | interrupt replied, settled `withdrawn`, no decision frame, marker absent, an independent session completes | terminal within 5 s, terminal, settlement, item, inferences |
| N5 | SIGKILL while held, resume on a fresh app-server | writer held then released only after exit, settled `lost`, nothing written, late reply stale, marker absent, resumed, no resubmission | completion, resumed last turn and items, server requests after resume, replayed pending |
| N7 | interrupt while an accepted `sleep 3; touch` runs | reply ok, interrupt replied, a terminal | command started, terminal, item, marker after 5 s |
| N8 | `request_permissions` / `request_user_input`, only if advertised | every reply frame for a refused method is an error | candidates, reactions, refused methods |
| N9 | expiry `afterMs: 500` | settled `expired`, no decision frame, a `-32000` frame, marker absent, an independent session completes | terminal within 5 s, terminal, item |

If native never ended a turn after an interrupt or an error reply (N4, N9), the reader would record `terminalWithin5s: null` and, after the checked facts are taken, end the turn with the host's native `cancel` while the approval is live (else an interrupt). Both architectures ended both turns within 5 s, so that path did not run. Native notification order and N4's withdrawal source are recorded in every report but not pinned.

## Not covered

File-change, permission, user-input, elicitation and dynamic-tool requests unless N8 finds them advertised; the experimental `requiredHumanApproval` replay; concurrent requests per turn beyond what N3 records; live providers and macOS.
