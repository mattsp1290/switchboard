# Native Codex interaction qualification

`src/adapters/codex/interaction.ts` is the private approval bridge over the private execution module (see [boundaries](../architecture/boundaries.md#private-codex-interaction)); cancellation is `CodexSession.interrupt()` in `src/adapters/codex/execution.ts`. Inert evidence is `tests/adapters/codex/interaction.test.mjs` and the interrupt tests in `tests/adapters/codex/execution.test.mjs`, which drive an in-memory app-server that records every reply frame. Native evidence is `spikes/codex-native/interaction-proof.mjs`.

## Status

**Native proof pending.** [interaction-proof-result.json](../../spikes/codex-native/interaction-proof-result.json) is a pending record (`outcome: null`): the proof reports and checks but enforces no pin until the coordinator's linux/arm64 run and CI's linux/x64 run produce identical pinned objects. A native fact that contradicts this design changes the code and this document, never the assertion.

Natively qualified before this proof (probe.mjs; [native API](codex-native-api.md)): a command approval reaches a v2 client under `approvalPolicy: 'untrusted'`, `sandbox: 'read-only'`, and a `decline` reply leaves the item `declined` with no effect; `turn/interrupt` ends a held turn `interrupted`.

## Wiring

1. `createCodexInteraction({ maxObservers, eventCapacity, maxSettled, maxPending, transport, expiry? })`; `maxPending < transport.maxHandlers`, `expiry.afterMs < transport.handlerTimeoutMs`, `expiry` defaults to `null`.
2. Pass its `onServerRequest` to `openCodexExecution`; `attach(session)` after each create or resume, before the first turn.
3. Render `pending` events, persist, then `reply({ value, recordIntent, signal })`. To cancel, `session.interrupt()` or choose the native `cancel` decision.

## Labels

| Signal | Bridge outcome | Evidence |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `pending`, choices `accept`, `acceptForSession`, `decline`, `cancel`, plus proposed amendments or the native `availableDecisions` | qualified request (probe); N1 |
| `decline`, then `item/completed{declined}` | one `{decision:'decline'}` frame; `observed` effect `known{none}` | qualified (probe); N1 |
| `accept`, `acceptForSession`, amendments | one decision frame; effect `unknown` | unqualified; N2 records item and marker |
| `cancel` | one decision frame | unqualified; N6 |
| `item/fileChange/requestApproval` | `pending`, four stable decisions | unqualified; triggered only if advertised |
| permissions, user input, elicitation, dynamic tool call, auth refresh, attestation, legacy v1, `currentTime/read`, unknown | `refused{unsupported}`, `-32601` | unqualified; N8 records reactions if advertised |
| malformed approval / unattached thread / beyond `maxPending` | `refused`, `-32602` / `-32601` / `-32000` | inert |
| native terminal, `serverRequest/resolved` or item completion while live | `settled{withdrawn}`, `-32000`, no decision | unqualified; N4 records the native fate |
| host-selected expiry | `settled{expired}`, `-32000`, delivery `unknown` | unqualified; N9 records the native reaction |
| transport end (eof, deadline, overflow, process exit) while live | `settled{lost, not-sent}`, nothing written | transport; N5 |
| `serverRequest/resolved` after a reply | `observed`; delivery stays `unknown` | unqualified; N1 records order |
| tool or delegation continuation | `unsupported` | Codex has no delegation request; dynamic tools need the experimental API |

## Native proof scenarios

`node spikes/codex-native/interaction-proof.mjs <codex-linux-<arch>.tgz> <arm64|x64>` compiles the product into owned work and runs one fresh container per scenario under the execution proof's Docker limits (`--network none`, read-only root, tmpfs `/tmp` and `/root`). `interaction-reader.mjs` plays the host as the execution reader does, with `accountProfile` and a synthetic API key, threads `{approvalPolicy:'untrusted', sandbox:'read-only'}` passed by the host, `maxHandlers: 4`, `maxPending: 3` and `handlerTimeoutMs: 15000`. The loopback service's `call-<name>` marker emits one `exec_command` function call when `exec_command` is advertised and answers text once the call output is in the history. Every report records each server request (method, id type, param keys, `approvalId` presence, `availableDecisions`), each bridge reply frame (answered method, kind, decision or code), bridge events, native notification order, item and turn statuses, markers, inferences per marker, every native error reply raw and the stderr tail. Files are read only by explicit path.

| ID | Scenario | Checked | Recorded (pinned) |
| --- | --- | --- | --- |
| N1 | decline, then a duplicate reply | pending command approval, reply ok, duplicate refused, one `decline` frame, item `declined` observed as qualified no-effect, marker absent, `completed`, two inferences | choices, item, order of resolved/item/terminal, request id types |
| N2 | accept `touch /tmp/n2-marker` | reply ok, duplicate refused, one `accept` frame, a terminal | terminal, item, marker, order, inferences |
| N3 | A's approval held while B runs an answered turn and a client `thread/read` | B completes while A pends, read replied, A declined completes, transport only caller-closed | concurrent A requests |
| N4 | `session.interrupt()` while held | interrupt replied, no decision frame, marker absent, an independent session completes | terminal within 5 s, terminal, settlement and withdrawal source, item, order, inferences |
| N5 | SIGKILL while held, resume on a fresh app-server | writer held then released only after exit, settled `lost`, nothing written, late reply stale, marker absent, resumed, no resubmission | completion, resumed last turn and items, server requests after resume, replayed pending |
| N6 | native `cancel` decision | reply ok, one `cancel` frame, a terminal | terminal, item, inferences |
| N7 | interrupt while an accepted `sleep 3; touch` runs | reply ok, interrupt replied, a terminal | command started, terminal, item, marker after 5 s |
| N8 | `request_permissions` / `request_user_input`, only if advertised | every reply frame for a refused method is an error | candidates, reactions, refused methods |
| N9 | expiry `afterMs: 500` | settled `expired`, no decision frame, a `-32000` frame, marker absent, an independent session completes | terminal within 5 s, terminal, item, order |

If native never ends a turn after an interrupt or an error reply (N4, N9), the reader records `terminalWithin5s: null` and, after the checked facts are taken, ends the turn with the host's native `cancel` while the approval is live (else an interrupt); the documented consequence would be that an unanswered approval holds its lease until `handlerTimeoutMs`, and the host must choose `cancel`.

## Not covered

File-change, permission, user-input, elicitation and dynamic-tool requests unless N8 finds them advertised; the experimental `requiredHumanApproval` replay; concurrent requests per turn beyond what N3 records; live providers and macOS.
