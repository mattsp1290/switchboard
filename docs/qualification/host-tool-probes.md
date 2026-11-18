# Host-tool probes (P0)

These probes settle assumptions A1 to A8 of the Switchboard adapter migration plan (Crew, `.agents/plans/switchboard-adapter-migration/00-overview.md`) before the host-facing adapter contract is fixed. Gate G1 rests on A1, A2 and A5. The probes are evidence, not product code: nothing under `spikes/host-tools/` is packaged, imported by `src/`, or run by CI.

## Status

Gate G1: **A1, A2 and A5 hold.** A3, A4 and A8 hold. A6 is answered: a batch with exactly one deferred host call resumes cleanly, and a batch with two deferred calls silently loses one of them. A7 lists four differences from Crew's recorded facts. Every result below comes from the saved output named in its row; nothing was inferred without a run unless the row says so. Linux arm64 only; x64 was not run.

## How the probes ran

- Host: macOS on arm64 with Docker Desktop, server 29.2.1, `linux/arm64`.
- Image: `node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` (Node 24.22.3, npm 11.19.1), the image `spikes/codex-native/pins.json` pins.
- Packages: a named Docker volume filled by `npm ci --ignore-scripts` from this commit's `package-lock.json`, in the same image. That step is the only one with a network beyond loopback. No dependency was added and the lockfile is unchanged. The lockfile integrity of `@openai/codex-linux-arm64` equals the arm64 `sha512` in `spikes/codex-native/pins.json`.
- Each probe runs in its own fresh container: `--network none` (loopback only), a read-only root, an empty tmpfs home at `/home/probe`, `--security-opt no-new-privileges`, and no provider variable. Every result records the probe's environment keys: `HOME`, `HOSTNAME`, `NODE_VERSION`, `PATH`, `PWD`, `YARN_VERSION`, without `PWD` for the Pi probes, which start without a shell.
- Synthetic model servers listen on `127.0.0.1` inside the container. They are scripted so that the model calls the tool deterministically. For Claude, the synthetic key and base URL reach the CLI child only through the SDK's `env` option.
- Command, from the repository root, after creating the volume: `node spikes/host-tools/run.mjs <volume> [probe ...]`. The runner compiles this checkout's `src/` with the pinned TypeScript inside a container, so the Codex probes drive the real `src/adapters/codex/transport.ts`. It writes one file per probe to `spikes/host-tools/results/`, holding the exact `docker` command, the timestamps, the exit status and the probe's report.

| Component | Version | Where it came from |
| --- | --- | --- |
| Codex app-server | `codex-cli 0.169.0` | `@openai/codex-linux-arm64` 0.169.0, lockfile |
| Claude Agent SDK and its CLI | 0.3.323, `2.1.323 (Claude Code)` | `@anthropic-ai/claude-agent-sdk` and `-linux-arm64` 0.3.323, lockfile |
| MCP SDK | 1.32.2 | lockfile |
| Pi | `pi-coding-agent`, `pi-ai`, `pi-agent-core` 1.5.2 | lockfile |
| Switchboard transport | this commit's `src/adapters/codex/transport.ts` | compiled by `run.mjs` with TypeScript 7.0.2 |
| Supplementary: Claude Agent SDK and CLI | 0.3.306, `2.1.306 (Claude Code)`; MCP SDK 1.32.2 | a second volume, `npm install --ignore-scripts` with no lockfile, in the same image; the SDK and `-linux-arm64` integrity values equal those in Crew's `package-lock.json` |

## Results

| # | Assumption | Command | Observed | Verdict | Output |
| --- | --- | --- | --- | --- | --- |
| A1 | The Codex app-server holds a host tool call for 171 s under the transport bounds Crew uses | `run.mjs <volume> codex-hold-121 codex-hold-151 codex-hold-171 codex-hold-control` | Holds of 121, 151 and 171 s each ended with the turn `completed`. No notification arrived during any hold, the `dynamicToolCall` item went from `inProgress` to `completed` with `success: true`, and the next model request carried exactly one `function_call_output` for the call with the host's text. The transport ended only on the probe's own close. The control, with a 15 s handler bound, ended the transport with `handler-timeout`. | holds | `results/codex-hold-121.json`, `-151`, `-171`, `-control` |
| A2 | A Codex tool declared at `thread/start` is callable after `thread/resume` in a fresh process | `run.mjs <volume> codex-resume` | In the second, third and fourth processes, each opened with a plain `thread/resume`, the model request offered `host_probe`, the app-server sent `item/tool/call` for it, and the turn completed with the host's result. `thread/resume` with a `dynamicTools` field (fifth process) replied without error but ignored it: the new tool was not offered, and calling it returned `unsupported call: host_probe_late` to the model. | holds | `results/codex-resume.json` |
| A3 | A Codex history fingerprint is equal at segment end, after host-attested exit, and at next open | same run as A2 | In all five segments the rollout's size, SHA-256 and last `task_complete` turn were identical when `turn/completed` arrived, after the turn returned, after the process exited on stdin EOF, in the next process before `thread/resume`, and after the `thread/resume` reply. | holds | `results/codex-resume.json` |
| A4 | Codex's native `total` usage continues across resume | same run as A2 | `thread/tokenUsage/updated` `total` continued across all four resumes: each new process started from the previous process's final total and added each response's usage. `last` was always the newest model request alone. The rollout's last `token_count` matched the final notification in every segment. | holds | `results/codex-resume.json` |
| A5 | With the real Claude CLI, a host tool call alone in its message can be deferred and resumed in a fresh process through loopback HTTP MCP | `run.mjs <volume> claude-solo claude-solo-no-await` | Process 1: the PreToolUse hook returned `defer`; the result had `stop_reason` and `terminal_reason` `tool_deferred` and `deferred_tool_use` with the original id; the tool handler did not run; the CLI exited 0. Process 2, a new host process with a new MCP port and bearer: `resume` with `--await-initialize`; the CLI re-emitted the call through PreToolUse with the same id and input; the hook answered `allow`; the handler ran once. The next model request carried exactly one `tool_result` for the original id, with the host's text. | holds | `results/claude-solo.json` |
| A6 | What the real Claude CLI does with a batch that contains a host tool | `run.mjs <volume> claude-batch claude-batch-reversed claude-batch-preallowed claude-batch-deny-sibling claude-batch-both-gated claude-batch-both-gated-preallowed` | One deferred call with an allowed or denied sibling, in either order, with or without `allowedTools`: the sibling ran (or got an error result) in process 1, the host call was deferred and reported, and after resume the next model request carried exactly one result per call. Two deferred calls: both deferrals were recorded in the transcript, but `deferred_tool_use` named only the last; on resume only that one was replayed, and the first `tool_use` was missing from the next model request, with no result and no error. In no variant did the host tool's handler run without the hook's decision. | answered: one deferral per message works; two lose one | `results/claude-batch*.json` |
| A7 | Claude SDK 0.3.323 and Codex 0.169.0 match the 0.3.306 and 0.167.1 facts recorded in Crew's `docs/member-capabilities.md` | `run.mjs <volume> facts`, plus the A1, A5 and A6 runs | Every type and string Crew cites is still present (line numbers moved). Four differences, listed below: two of Crew's open questions are answered, Crew's "Refuted" entry on batch deferral does not hold at 0.3.323 or at 0.3.306, and the CLI holds a third defer refusal string. | four differences | `results/facts.json` |
| A8 | The Pi adapter can load and run inside a process with sockets, fork and file locking denied | `run.mjs <volume> pi-launcher pi-launcher-locks pi-unconfined` | Under both profiles, the controls were refused with `EPERM`: a socket, starting `/bin/true`, `utimes`, `chmod`, and a signal to another process. With the locks variant, an SQLite write lock was also refused. The Pi SDK loaded and an in-memory session ran one turn through an injected model stream function, ending `stopReason: "stop"` with the scripted text. The unconfined control succeeded at every operation. | holds | `results/pi-launcher.json`, `-locks`, `pi-unconfined.json` |

## A1: holding a Codex host tool call

The probe declares one function tool with `thread/start.dynamicTools` after `initialize` with `capabilities.experimentalApi: true`, and runs one turn whose model calls it. Its `onRequest` handler, behind Switchboard's own `openCodexTransport`, waits until its measured hold reaches the target and then answers with `contentItems: [{ type: "inputText", text }]` and `success: true`.

Transport bounds: `maxFrameBytes` 1048576, `maxChunkBytes` 2097151, `maxDiagnosticBytes` 65536, `maxPending` 8, `maxHandlers` 4, `maxWrites` 8, `observationCapacity` 4096, `handlerTimeoutMs` 180000, `observationTimeoutMs` 5000, `writeTimeoutMs` 20000. All but `handlerTimeoutMs` are the values `spikes/codex-native/interaction-reader.mjs` passes. `handlerTimeoutMs` bounds how long any server request may stay unanswered for the whole transport (`docs/architecture/boundaries.md`, "Request callbacks awaiting human decisions retain their lease"). A host such as Crew must therefore pass more than its longest hold. Crew's longest is 170 s: `crew:src/service/codex-calls.ts:60` refuses a live call that expires more than 170 s ahead. Crew also waits 120 s for a live decision (`crew:src/service/codex-live.ts:35`), gives its MCP tool 150 s (`tool_timeout_sec`, `crew:src/service/codex.ts:176`), and bounds a trusted Codex turn at 170 s (`crew:src/service/trusted-codex.ts:21`). The probe passes 180000 ms.

| Probe | Hold measured | Turn | Result in the next model request | Transport end |
| --- | --- | --- | --- | --- |
| `codex-hold-121` | 121008 ms | `completed` | one `function_call_output` for `call_1` | `caller-close` after the turn |
| `codex-hold-151` | 151005 ms | `completed` | one `function_call_output` for `call_1` | `caller-close` after the turn |
| `codex-hold-171` | 171002 ms | `completed` | one `function_call_output` for `call_1` | `caller-close` after the turn |
| `codex-hold-control` (bound 15000 ms, hold 30 s) | none: the transport ended 15004 ms after the call arrived and aborted the hold | no `turn/completed` reached the probe | none sent | `handler-timeout`, with one handler unsettled |

The 0.169.0 protocol has no timeout field on any dynamic tool type (`results/facts.json`, `timeoutFieldsInDynamicTypes` is empty). These runs show no app-server timeout up to 171 s. They do not show where one would start beyond that.

## A2, A3 and A4: one thread across five processes

`codex-resume` runs five app-server processes in one container, one after another, on one `CODEX_HOME`. The first starts the thread with `host_probe` declared. The second, third and fourth call `thread/resume` with only `threadId`. The fifth calls `thread/resume` with `threadId` and `dynamicTools` declaring `host_probe_late`. Each process runs one turn in which the model calls the tool named in the user text, then exits on stdin EOF after the probe closes its transport. All five exited with code 0 without a signal.

| Process | Open | Tool the model was offered | `item/tool/call` received and answered | Turn |
| --- | --- | --- | --- | --- |
| p1 | `thread/start` declaring `host_probe` | `host_probe` | `call_1` | `completed` |
| p2 | `thread/resume` | `host_probe` | `call_3` | `completed` |
| p3 | `thread/resume` | `host_probe` | `call_5` | `completed` |
| p4 | `thread/resume` | `host_probe` | `call_7` | `completed` |
| p5 | `thread/resume` with `dynamicTools: [host_probe_late]`, replied without error | `host_probe` only | none: the model's `call_9` to `host_probe_late` came back as `unsupported call: host_probe_late` | `completed` |

In p1 to p4, the model request after each answer carried the new `function_call_output` once, with the host's text, beside the earlier calls' outputs from the history.

The generated 0.169.0 protocol has no `dynamicTools` on `ThreadResumeParams` or `TurnStartParams` (`results/facts.json`), and the fifth process shows the app-server accepting and ignoring one rather than refusing it.

Fingerprint: the rollout file under `sessions/`, its byte size and SHA-256, and the newest `event_msg` of type `task_complete` with its `turn_id`. It is read at five points: synchronously when `turn/completed` arrives, after the turn returns, after the process exits, in the next process after `initialize` and before `thread/resume`, and after the `thread/resume` reply.

| Segment | Size (bytes) | SHA-256, first 12 | Last completed turn | Equal at every point |
| --- | --- | --- | --- | --- |
| p1 | 38546 | `1f1d5948c1b0` | `…f4e024` | yes, all five |
| p2 | 46866 | `3010eb91d942` | `…779f4c` | yes, all five |
| p3 | 55207 | `ebff9174e799` | `…36baba` | yes, all five |
| p4 | 63552 | `ee6bd6235efd` | `…999acb` | yes, all five |
| p5 | 71439 | `da9492edfde0` | `…a5295f` | yes, the three in its own process (no process follows it) |

In every case the last line of the rollout was the `task_complete` entry. Neither `initialize` nor `thread/resume` wrote to the rollout. The probe takes each process down by closing its transport and ending stdin, and all five exited on that alone.

Usage: the synthetic server gives response `n` the usage `input_tokens` 1000n+1, `cached_tokens` n, `output_tokens` 10n+2, `reasoning_tokens` n, so each request's share can be read back from any total.

Each row lists `total.totalTokens` / `last.totalTokens` from each `thread/tokenUsage/updated` in that process, in order. Response `n` alone is 1010n+3 tokens.

| Process | Model requests | Usage notifications | Rollout's last `token_count` |
| --- | --- | --- | --- |
| p1 | 1, 2 | 1013/1013, 3036/2023 | 3036/2023 |
| p2 | 3, 4 | 3036/2023 (previous turn's id), 6069/3033, 10112/4043 | 10112/4043 |
| p3 | 5, 6 | 10112/4043 (previous turn's id), 15165/5053, 21228/6063 | 21228/6063 |
| p4 | 7, 8 | 21228/6063 (previous turn's id), 28301/7073, 36384/8083 | 36384/8083 |
| p5 | 9, 10 | 36384/8083 (previous turn's id), 45477/9093, 55580/10103 | 55580/10103 |

The input, cached input, output and reasoning fields follow the same pattern field by field. `total` is the sum over every response of the thread across processes, so a segment's own usage is its final `total` minus the previous segment's.

## A5 and A6: Claude deferral and resume

Each scenario runs two host processes in one container. The orchestrator holds the synthetic Messages server and starts each host phase as its own Node process, so only the files under `CLAUDE_CONFIG_DIR` carry from the deferring process to the resuming one. Each phase starts its own loopback HTTP MCP server on a new port with a new 32-byte bearer, compared in constant time with the `Host` header checked, as the MCP server in Crew's vendored `@ag-ui/claude-agent-sdk` 0.0.8 does. The SDK options follow Crew's `claude-worker.ts`: `tools: []`, `allowedTools: []` (except the `preallowed` variants), `strictMcpConfig: true`, `settingSources: []`, `plugins: []`, `permissionMode: "dontAsk"`, and the MCP server with `alwaysLoad: true`. The probe passes its own `spawnClaudeCodeProcess`. Process 2 passes `resume`, `forkSession: false`, `extraArgs: { "await-initialize": null }`, and a prompt stream that stays open and empty until a result arrives, as the vendored adapter does. The CLI writes a debug log, and each phase records the CLI's own lines about deferral and the transcript it leaves.

A5 (`claude-solo`), in order:

1. Process 1 sent one model request, which offered `mcp__host__host_echo` and `mcp__host__host_probe`. The model answered with one `tool_use` for `mcp__host__host_probe`.
2. The PreToolUse hook received that call with `mcp_server: { name: "host", source: "dynamic" }` and returned `defer`. No tool handler ran.
3. The query ended with a `success` result: `stop_reason` and `terminal_reason` `tool_deferred`, and `deferred_tool_use` with the original id, name and input. The transcript holds the `tool_use` and a `hook_deferred_tool` attachment for it. The CLI exited 0, and then the host process exited 0.
4. Process 2, a new Node process with a new MCP port and bearer, started the CLI with `--resume=<session>` and `--await-initialize`. The CLI logged `Auto-resuming deferred tool` and re-emitted the call through PreToolUse with the same id and input. The hook answered `allow` and the MCP handler ran once.
5. The second and last model request carried the original `tool_use` in the assistant history and, in the last user message, exactly one `tool_result` for its id, with the host's text, followed by `Continue from where you left off.`. The query ended `end_turn`/`completed`. Two model requests in all, and every MCP request carried the bearer.

`claude-solo-no-await` is the same scenario with `--await-initialize` left out of process 2, as the SDK leaves it out when the host supplies a spawn function. It gave the same result in this one run.

A6, by variant:

| Variant | Calls in the one assistant message (hook in process 1) | Process 1 | Reported `deferred_tool_use` | Process 2 | Next model request |
| --- | --- | --- | --- | --- | --- |
| `claude-batch` | `host_probe` (defer), `host_echo` (allow) | `host_echo` ran | `host_probe` | `host_probe` re-emitted, allowed, ran once | both `tool_use`; one result each: `host_echo` from process 1, `host_probe` from process 2 |
| `claude-batch-reversed` | `host_echo` (allow), `host_probe` (defer) | `host_echo` ran | `host_probe` | as above | as above |
| `claude-batch-preallowed` | as `claude-batch`, with both in `allowedTools` | `host_echo` ran; `host_probe` did not | `host_probe` | as above | as above |
| `claude-batch-deny-sibling` | `host_probe` (defer), `host_echo` (deny) | nothing ran; `host_echo` in `permission_denials` | `host_probe` | as above | both `tool_use`; `host_echo` result `is_error` with `PreToolUse:mcp__host__host_echo hook error: denied by the probe host`; `host_probe` result with the host's text |
| `claude-batch-both-gated` | `host_probe` (defer), `host_echo` (defer) | nothing ran; two `hook_deferred_tool` attachments | `host_echo` only | only `host_echo` re-emitted, allowed, ran | only `host_echo`'s `tool_use` and its result; `host_probe` absent, with no result and no error |
| `claude-batch-both-gated-preallowed` | as `claude-batch-both-gated`, with both in `allowedTools` | as above | `host_echo` only | as above | as above |

What the CLI logged in process 1 of `claude-batch-both-gated`: two `Hook result has permissionBehavior=defer` lines, and its transcript holds two `hook_deferred_tool` attachments, one per call. In process 2 it logged `Auto-resuming deferred tool` for the last call only. The first call's `tool_use` stays in the transcript file but was not in the next model request.

Supplementary run at Crew's pin (`run.mjs <volume-0.3.306> --label claude-sdk-0.3.306 claude-solo claude-batch claude-batch-both-gated`, outputs `results/*--claude-sdk-0.3.306.json`): SDK 0.3.306 with CLI 2.1.306 behaved the same in all three scenarios.

## A7: differences from Crew's recorded SDK facts

Crew's record (`crew:docs/member-capabilities.md`, section "SDK assumptions") was read at Claude Agent SDK 0.3.306 and Codex 0.167.1. `results/facts.json` re-reads each place it cites in the pinned packages and generates the 0.169.0 protocol with `codex app-server generate-ts --experimental` (951 files, SHA-256 over names and contents `d9bacb7ece9dc2ddf26900564df8d195818be23437f1617df2eed6c873789261`).

Unchanged, with the pinned locations:

- PreToolUse fires for MCP tools: `PreToolUseHookInput` carries `mcp_server?: McpServerProvenance` (`sdk.d.ts:2899-2904`); an in-process server is `type: 'sdk'` (`:1290`); MCP tools are named `mcp__server__tool_name` (`:5025`). A5 adds a run: the hook fired for the HTTP MCP tool with `mcp_server: { name: "host", source: "dynamic" }`.
- `HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer'` (`sdk.d.ts:1052`); the result carries `deferred_tool_use?: SDKDeferredToolUse` (`:6301`); `TerminalReason` includes `tool_deferred` and `tool_deferred_unavailable` (`:10427`). The CLI binary still holds `tool_deferred_unavailable`. No probe used an in-process SDK MCP server, so the "Refuted" entry on resuming one is unchanged and was not run.
- Codex: `ServerRequest.ts` has `"item/tool/call"` with `DynamicToolCallParams` (`threadId`, `turnId`, `callId`, `namespace: string | null`, `tool`, `arguments`); `DynamicToolCallResponse` is `{ contentItems, success }`; `ThreadStartParams` has `dynamicTools`; `InitializeCapabilities` has `experimentalApi`. `@openai/codex-sdk` 0.169.0 still runs `["exec", "--experimental-json"]` (`dist/index.js:178`), and the binary still holds `dynamic tool calls are not supported in exec mode` and `dynamic tool call was cancelled before receiving a response`.
- Pi 1.5.2 is the version Crew read, and its cited lines are unchanged: `extensions/types.d.ts:999`, `:1109`, `:1266`; `docs/extensions.md:975`, `:3253`; `pi-agent-core` `types.d.ts:279`.

Differences:

1. Answered, was open: an SDK `query()` counts as print mode for deferral. A deferring hook ends the query with `stop_reason: "tool_deferred"` (A5).
2. Answered, was unknown: the Codex app-server has no timeout shorter than Crew's. A dynamic tool call was held 171 s with the turn completing normally (A1).
3. Does not hold: "Several calls in one batch can be denied while one is deferred: **Refuted**". With CLI 2.1.323, and with 2.1.306 in the supplementary run, one deferred call with an allowed or denied sibling is deferred, reported and resumed, and both results reach the model exactly once (A6). The binary still holds `tool calls are in this batch; ignoring (defer is solo-only — siblings would be orphaned on resume)`, but no probe reached that line. What does fail is two deferrals in one message: the earlier deferred call is dropped without a result (A6).
4. New: the CLI binary holds a third defer refusal, `returned permissionDecision=defer for a served call; refusing (no resume machinery)`, which the record does not mention. No probe reached it.

The record's Landlock and UDP row concerns Crew's launcher and a kernel, not an SDK, and was not re-probed.

## A8: Pi under the launcher's Pi-mode filter

`spikes/host-tools/pi-seccomp.mjs` builds a Docker seccomp profile from the Pi-mode filter of Crew's launcher (`crew:native/member-launch.c`, `install_filter`, lines 142-212 at Crew `ef86e62`). Each rule names the launcher line it copies. The `launcher-locks` variant also refuses `flock` and `fcntl` `F_SETLK`, `F_SETLKW`, `F_OFD_SETLK` and `F_OFD_SETLKW`, which the launcher does not refuse. Each result file holds the full profile it ran under. The worker runs as PID 1 with `--entrypoint node`, because the image's entrypoint script starts a subshell, which the profile refuses.

Differences from the launcher:

- No Landlock. The container's read-only root, tmpfs home and read-only mounts stand in for it, which is coarser.
- "Only this process" rules compare against PID 1, the worker's PID in its namespace, instead of `getpid()`. `kill` and `tgkill` refuse any target but 1, as the launcher refuses any but itself. The `only_self` calls accept 0 and 1.
- A foreign architecture meets libseccomp's bad-architecture action, not the launcher's explicit kill. On x86-64, x32 calls likewise get that action instead of `EPERM`.
- runc skips a system call name its libseccomp does not know. `fchmodat2`, `setxattrat`, `removexattrat` and `file_setattr` are recent, and whether they were installed was not checked. Node made none of them in these runs.
- `no_new_privs` comes from `--security-opt no-new-privileges`. The launcher's parent-death signal and descriptor closing have no container equivalent and were not reproduced.
- The launcher refuses no file lock. The plan's "file locking denied" matches Crew's own note in `crew:src/service/pi-worker.ts` that file-backed Pi storage "locks with utimes, which the launcher refuses". `utimensat` is refused in both profiles, and `launcher-locks` also refuses the lock calls.

| Step | `pi-unconfined` | `pi-launcher` | `pi-launcher-locks` |
| --- | --- | --- | --- |
| TCP connect to `127.0.0.1:9` | `ECONNREFUSED` (the socket opened) | `EPERM` | `EPERM` |
| `spawnSync("/bin/true")` | ran, status 0 | `EPERM` | `EPERM` |
| `utimes` on a file it owns | ok | `EPERM` | `EPERM` |
| `chmod` on a file it owns | ok | `EPERM` | `EPERM` |
| SQLite `BEGIN IMMEDIATE` write | committed | committed | `ERR_SQLITE_ERROR`, `access permission denied` |
| `kill(2, 0)` | `ESRCH` | `EPERM` | `EPERM` |
| Import `pi-ai` and `pi-coding-agent` | ok | ok | ok |
| In-memory turn | one stream call; `stop`, `pi answer to 1 prompt(s)` | same | same |
| File-backed turn | same; wrote only `sessions/<id>.jsonl` | same | same |

The turn used Crew's worker configuration (`crew:src/service/pi-worker.ts`, `pi-session.ts`): `ModelRuntime.create` with in-memory credential and model stores, `allowModelNetwork: false`, and a native provider whose `stream` is a probe function that emits `start`, `text_delta` and `done`. `SettingsManager.inMemory`, a `DefaultResourceLoader` with extensions, skills, prompt templates, context files and themes off, `SessionManager.inMemory`, and `createAgentSession` with no tools. The probe also ran the same turn with `SettingsManager.create` and `SessionManager.create`. That turn completed under both profiles too, but it wrote only a session JSONL file and no lock file or directory, so the SDK's lock path was not reached. Whether a settings or auth write would fail under the launcher was not probed.

## Observed and not anticipated by the plan

1. Codex `thread/resume` accepts a `dynamicTools` field and ignores it without an error. A host that tries to add or change a tool after start gets no signal. The tool is simply absent, and a model call to it receives `unsupported call: <name>` as its output.
2. On every resume, the app-server sends a `thread/tokenUsage/updated` for the previous turn, carrying the previous final `total` and `last`, right after the `thread/resume` reply and before `turn/start` is answered. `last` covers one model request, so a tool turn produces two usage notifications, and the last `last` is not the turn's usage. A host that stores `last` per segment undercounts. The difference of `total` across the segment is the segment's usage.
3. Claude: with two deferred calls in one assistant message, only the last is reported and resumed, and the other is lost without a result or an error. Three or more were not tried. The adapter sees every PreToolUse decision it makes, so it can count deferrals per message and must fail a segment with more than one, with a typed failure. A single deferral alongside calls the host allows or denies in the same process works, which is better than the plan's A6 fallback of failing every batch that contains a host tool.
4. Claude: the resumed model request carries the tool result followed by a user text block, `Continue from where you left off.`, that the CLI adds.
5. Claude: the SDK adds `--await-initialize` itself only when the host sets neither `spawnClaudeCodeProcess` nor `pathToClaudeCodeExecutable` (`sdk.mjs` in 0.3.323). So a host that supplies a spawn function, as Crew's launcher path does, gets no barrier unless it passes `extraArgs: { "await-initialize": null }` itself, as the vendored adapter does. In one run (`claude-solo-no-await`) the hook was registered in time without it. One run does not show that this is not a race, so an adapter should keep passing the flag.
6. Codex warns on every resume that "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`". It also warns that bubblewrap is not on `PATH` and that the probe's model has no metadata. None of these changed the results.
7. With only the probe's configuration, the model was offered the built-in tools `exec_command`, `write_stdin`, `request_user_input`, `view_image`, `multi_agent_v1`, `get_goal`, `create_goal`, `update_goal` and web search beside the host tool. A host that wants only its own tools must switch features off, as Crew's trusted lane does.

## Not covered

- Linux x64, and the CI image path. Every run was linux/arm64 on Docker Desktop.
- Holds beyond 171 s; Codex dynamic tools in a namespace (Crew's trusted lane uses one); `deferLoading`.
- Repeated Claude resumes without `--await-initialize` (one run only); an in-process SDK MCP server; the CLI under Crew's launcher.
- A Pi settings or auth write under the profile, and Landlock.
