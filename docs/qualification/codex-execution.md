# Native Codex execution qualification

`src/adapters/codex/execution.ts` is the private turn-execution component over a host-owned app-server (see [boundaries](../architecture/boundaries.md#private-codex-execution)). Inert evidence is `tests/adapters/codex/execution.test.mjs`, which drives an in-memory app-server over a borrowed channel. Native evidence is `spikes/codex-native/execution-proof.mjs`.

## Status

**Native proof pending.** [execution-proof-result.json](../../spikes/codex-native/execution-proof-result.json) has `outcome: null`. The coordinator runs arm64 locally; CI runs x64 on every PR after the sessions proof. Until the outcome is recorded, a run prints its full report, enforces the harness and X1–X9 checks, and does not enforce the pin.

## Labels

Each decoded session event carries `evidence` from `codexNotificationEvidence`. `turn/completed` and `item/agentMessage/delta` are qualified by the existing native probe. `thread/tokenUsage/updated` is unqualified until X1 pins it. Every other notification arrives as an opaque `native` event labelled `unqualified`.

| Signal | Adapter outcome | Evidence |
| --- | --- | --- |
| `turn/start` result with `turn.id` | dispatch `accepted`, native operation `{codex-turn, id}` | qualified (probe) |
| `turn/completed` | completion `terminal`; `conclusive` if seen before the reply | qualified (probe) |
| `turn/start` written, then no reply (transport loss or acknowledgement deadline) | `outcome-unknown`, writer retained, never resent | transport; X6 |
| `turn/start` not sent | `outcome-unknown` in core, `not-sent{reason}` to the host, session usable | transport |
| `turn/start` error reply | `conclusive{rejected}`, session usable | unqualified; X7 records it |
| `thread/tokenUsage/updated` | `usage` with native `total` and `last`; malformed becomes `native` | unqualified; X1 records it |
| `thread/unsubscribe` | cleanup step only, never a release condition | unqualified; X5 records reopen |
| `error` notification `willRetry` | opaque `native` | unqualified; X8 records it |

## Native proof scenarios

`node spikes/codex-native/execution-proof.mjs <codex-linux-<arch>.tgz> <arm64|x64>` compiles the product into owned work, mounts it read-only and runs one container per scenario under the same Docker limits as the sessions proof. `execution-reader.mjs` plays the host: it spawns the app-server, lends its stdio as the channel (with optional per-method write gates, stdout buffering or an `eof` after a named write) and attests process exit. The loopback Responses service selects `answer`, `hold-<name>` or `disconnect` by the last marker in the request and reports distinct usage (input 11, cached 5, output 7, reasoning 3, total 18). The fixture provider requires OpenAI auth and logs in with a synthetic API key, so `account/read` projects the `apiKey` requester (the pg51 lesson). Every scenario records raw observations for each unqualified signal, so a failed native run is diagnosable.

| ID | Scenario | Checked | Recorded (pinned) |
| --- | --- | --- | --- |
| X1 | create, one answered turn | terminal `completed`, accepted/conclusive, one inference | event kinds, native methods, `turn/started` seen, usage values and raw payload |
| X2 | resume in a fresh process, one turn | same ID, no resume inference, prefix preserved | saved turns on resume |
| X3 | two held sessions in one app-server | B completes while A is pending, then A | — |
| X4 | ownership release across two app-servers on one home and registry; `thread/unsubscribe` gated by the host channel | `interrupted`, reopen `busy` with zero native requests, independent turn completes during the hold, release, then admission and a completed turn, one held inference | — |
| X5 | same-process reopen after close | released; reopen `resumed` or `busy` | unsubscribe status, reopen outcome |
| X6 | channel `eof` right after `turn/start`, then SIGKILL | `outcome-unknown`, one write, retained until exit, released after, resume without resubmission | completion, inference before exit |
| X7 | invalid `UserInput` | one write; an error reply maps to `rejected` | snapshot, completion, error code, turn events |
| X8 | accepted stream disconnect | `failed`, delta seen, one inference | error notification and `willRetry` |
| X9 | abort during `initialize` (stdout buffered) | `closed`, one detach, nothing reserved, fresh open creates | — |

Module-only (inert tests, not native): the broken early-release control, early-notification overflow, late cleanup from an earlier generation, slow-observer isolation and bound refusals.

## Not covered

Cross-process and durable admission, uncooperative external writers, route-policy compatibility (z8tq/me4l), approvals and cancellation acceptance (118i), live providers and macOS.
