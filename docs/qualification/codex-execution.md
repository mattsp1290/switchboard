# Native Codex execution qualification

`src/adapters/codex/execution.ts` is the private turn-execution component over a host-owned app-server (see [boundaries](../architecture/boundaries.md#private-codex-execution)). Inert evidence is `tests/adapters/codex/execution.test.mjs`, which drives an in-memory app-server over a borrowed channel. Native evidence is `spikes/codex-native/execution-proof.mjs`.

## Status

**Native proof recorded.** [execution-proof-result.json](../../spikes/codex-native/execution-proof-result.json) has outcome `execution-outcomes-confirmed`: identical pinned objects on linux/arm64 (coordinator, local) and linux/x64 (CI job 134407401390) at 08810ca, with harness and X1–X9 true on both and cleanup leaving no container and an empty `.work`. Every later run, including CI x64 on every PR, fails on any other pinned value. After that run, usage was promoted to `qualified`; the pin differs from the 08810ca reports only in `X1.usage.evidence`.

Observed natively on both architectures:

- `thread/tokenUsage/updated` delivers six-field `total` and `last` usage and `modelContextWindow` (X1).
- `turn/started` arrives before the terminal (X1); it stays an opaque `native` event.
- An invalid `UserInput` gets a `turn/start` error reply `-32600`, which maps to `conclusive{rejected}` (X7).
- `thread/unsubscribe` replies but does not unload the thread: a same-process reopen stays `busy` (X5).
- The accepted-stream `error` notification reports `willRetry: false` (X8).

Release is host-attested exit of the app-server holding the thread. An earlier arm64 run at 8d41e79 failed only X4: a `thread/resume` on a second app-server failed while the first lived, and resume on a fresh app-server after the first exited works (X2). So a turn terminal ends the turn, not the writer, and a closed session's reservation is retained until exit.

## Labels

Each decoded session event carries `evidence` from `codexNotificationEvidence`. `turn/completed` and `item/agentMessage/delta` are qualified by the existing native probe, and `thread/tokenUsage/updated` by X1 on both architectures. Every other notification, including the natively observed `turn/started` and `error`, arrives as an opaque `native` event labelled `unqualified`, because the adapter decodes no meaning from it.

| Signal | Adapter outcome | Evidence |
| --- | --- | --- |
| `turn/start` result with `turn.id` | dispatch `accepted`, native operation `{codex-turn, id}` | qualified (probe) |
| `turn/completed` | completion `terminal`; `conclusive` if seen before the reply | qualified (probe) |
| `turn/start` written, then no reply (transport loss or acknowledgement deadline) | `outcome-unknown`, writer retained, never resent | transport; native X6 |
| `turn/start` not sent | `outcome-unknown` in core, `not-sent{reason}` to the host, session usable | transport |
| `turn/start` error reply | `conclusive{rejected}`, session usable | native (X7, code `-32600`) |
| `thread/tokenUsage/updated` | `usage` with native `total` and `last`; malformed becomes `native` | qualified (X1) |
| `turn/started` | opaque `native` | unqualified; seen natively (X1) |
| `thread/unsubscribe` | cleanup step only; the thread stays loaded, so never a release condition | native (X5) |
| `error` notification `willRetry` | opaque `native` | unqualified; X8 observed `false` |

## Native proof scenarios

`node spikes/codex-native/execution-proof.mjs <codex-linux-<arch>.tgz> <arm64|x64>` compiles the product into owned work, mounts it read-only and runs one container per scenario under the same Docker limits as the sessions proof. `execution-reader.mjs` plays the host: it spawns the app-server, lends its stdio as the channel (with optional per-method write gates, stdout buffering or an `eof` after a named write) and attests process exit. The loopback Responses service selects `answer`, `hold-<name>` or `disconnect` by the last marker in the request and reports distinct usage (input 11, cached 5, output 7, reasoning 3, total 18). The fixture provider requires OpenAI auth and logs in with a synthetic API key, so `account/read` projects the `apiKey` requester (the pg51 lesson). Every scenario records raw observations for each natively settled signal, so a failed native run is diagnosable.

| ID | Scenario | Checked | Recorded (pinned) |
| --- | --- | --- | --- |
| X1 | create, one answered turn | terminal `completed`, accepted/conclusive, one inference, `qualified` usage seen | event kinds, native methods, `turn/started` seen, usage values and raw payload |
| X2 | resume in a fresh process, one turn | same ID, no resume inference, prefix preserved | saved turns on resume |
| X3 | two held sessions in one app-server | B completes while A is pending, then A | — |
| X4 | ownership release across app-servers on one home and registry; `thread/unsubscribe` gated by the host channel | `interrupted`, reopen `busy` with zero native requests during the hold and again after close (not released), independent turn completes, host stops A, one reservation released, then admission and a completed turn, one held inference | raw native `thread/resume` on a third app-server while A lives (not pinned) |
| X5 | same-process reopen after close | not released; reopen `busy` with zero native requests | unsubscribe status, reopen outcome |
| X6 | channel `eof` right after `turn/start`, then SIGKILL | `outcome-unknown`, one write, retained until exit, released after, resume without resubmission | completion, inference before exit |
| X7 | invalid `UserInput` | one write; `conclusive` `rejected` | snapshot, completion, error code, turn events |
| X8 | accepted stream disconnect | `failed`, delta seen, one inference | error notification and `willRetry` |
| X9 | abort during `initialize` (stdout buffered) | `closed`, one detach, nothing reserved, fresh open creates | — |

Every report records each native error reply raw (`raw.nativeErrors`: method, code, message). Module-only (inert tests, not native): the broken early-release controls (release at cleanup start, release after cleanup), early-notification overflow, late cleanup from an earlier generation, slow-observer isolation and bound refusals.

## Not covered

Cross-process and durable admission, uncooperative external writers, route-policy compatibility (z8tq/me4l), approvals and cancellation acceptance (118i), live providers and macOS.
