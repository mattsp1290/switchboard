# Native Codex discovery qualification

Codex 0.169.0 public app-server is [selected for implementation](codex-selection.md).
It discovers indexed and unindexed native history while the original history and SQLite files are mounted read-only.
The supported `sqlite_home` override sends startup backfill and metadata repair to a disposable private index, resolving the suspected source-write incompatibility.
Listing alone still omits malformed history without a structured coverage warning, and pagination does not bound startup backfill bytes.
A supported known-target read distinguishes this corrupted fixture from an absent ID.
Inventory-driven public path inspection supplies an explicit failed-file observation without knowing its native ID.
Together with the retained diagnostics contract, that evidence resolves the exact unknown-omission selection blocker. Broader coverage and adapter support remain unqualified.

The executable proof is [discovery.mjs](../../spikes/codex-native/discovery.mjs), invoked unconditionally by [qualify.mjs](../../spikes/codex-native/qualify.mjs).
The [native qualification instructions](codex-native-api.md) reproduce it on Linux arm64 or x64.
The [selection evidence](codex-selection.md#evidence-and-pins) identifies the retained parent arm64 report and its hash.
The [Linux x64 native CI job](https://github.com/mattsp1290/switchboard/actions/runs/43554616649/job/132324530599) passed the same entry point at source `7be6e58ca155905af27b6d31f415fa84570aafe1`, including path inspection.
Both executions verify the pinned archive, strict generated bindings, native behavior probe, and five discovery variants. Neither qualifies native macOS execution or a live provider.

The proof creates eight native threads through `thread/start` and completed turns against a synthetic loopback Responses server. The threads cover two matching records, another cwd, another provider, archived history, a separate unauthorized root, and two synthetic account identities. Native archive operations produce the archived fixture. The probe exports native history and SQLite bytes after process shutdown. It does not parse, synthesize, or import private history formats. The malformed case deliberately replaces one native-created file with invalid JSON.

The data shape is a fixture manifest of native IDs, role names, cwd values, providers, and native-returned paths. The runner uses those paths to preserve and remount opaque files. No native-generated skill instructions are read or executed by the qualification script.

## Storage and authorization boundary

Each discovery container has a fresh writable auxiliary home on `/root` tmpfs. The runner mounts `sessions`, `archived_sessions`, and every exported original SQLite file read-only at their native locations under `/root/.codex`. This includes `state_5`, `thread_history_1`, goals, memories, queue, and logs databases with any WAL and SHM sidecars present after shutdown. `state_5` is the metadata index. `thread_history_1` and all other original databases receive the same protection without assuming they are all discovery indexes.

The process uses `sqlite_home=/tmp/private-index` and `log_dir=/tmp/private-logs`. The original SQLite files are protected but are not the active discovery index. Both indexed and unindexed cases rebuild a private cache from native history. SQLite-only customizations, such as explicit titles, sections, and project metadata, are not proven to survive reconstruction. The private cache already serves `useStateDbOnly=true` at initialization, before the first scan listing. Source hashes are identical before startup, after initialization, after listing, and after shutdown. The host also compares source hashes across the entire container lifetime. Write attempts against the mounted history fail with `EROFS`.

Writes to the fresh auxiliary home and private cache are intentional. Native startup creates helper files and other auxiliary state. A private preliminary experiment mounting the entire native home read-only failed before initialization. That failure does not imply that history or indexes must be writable. No production home, credentials, history, or sockets are mounted. The probe never assigns `HOME`, `home`, or `CODEX_HOME`.

The host must authorize the entire mounted history root and its account contents before startup. `cwd`, provider, source, and account parameters select results after native reads. They cannot establish read confinement. The fixture creator also supplies an out-of-scope native history file. Only the symlink characterization mounts it at `/unauthorized`. Other cases omit that file from the mounted namespace. Native discovery excludes its ID, including when the protected original index still contains that ID. The symlink characterization also excludes file and directory symlinks into that separately mounted root. The host preflight rejects either symlink before ordinary discovery. The explicit symlink test bypasses that rejection solely to characterize native behavior in the isolated synthetic container.

The fixture namespace is immutable during each run. This proof does not solve races with another writer replacing files between host admission and a production mount. Root authorization, stable namespace admission, and subsequent native-ID resume authorization remain host responsibilities.

## Bounded source observation

This section states the current guarantee. Its evidence is guarded inert tests only; no native run has exercised this
source, and none of the historical native records below certifies it.

One observer in [inventory.mjs](../../spikes/codex-native/inventory.mjs) replaces the leaf-and-hash checks at every consumer:
host admission and the host container lifetime in `qualify.mjs`, every reader checkpoint in `discovery.mjs`, the H1 cold
copies, and the `prepare` and `prepare-accounts` export. It records kind, device, inode, size, mode, link count, modification
and change times for every selected entry, directories and absent trees included, the exact bytes of every selected regular
file, and the raw target bytes of a permitted symlink. A reader takes one baseline before startup and re-walks it at every
existing checkpoint; the creator takes one capture after native shutdown and exports from it.

| Modes | Selected root names | Trees | Symlinks |
| --- | --- | --- | --- |
| `prepare`, `indexed`, `unindexed`, `malformed`, `inaccessible` | `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm` | `sessions`, `archived_sessions` | refuse |
| `symlink` | same as above | same | kind and raw target recorded, never followed or descended |
| `prepare-accounts`, `account-reads` (H1) | any name containing `.sqlite` or starting with `thread_history` | same | refuse |
| host admission | every entry under the source | — | refuse |
| host container lifetime | every entry under the source | — | kind and raw target recorded |

A tree that is a regular file, such as the inaccessible `sessions` control, is a selected file. An absent tree is recorded as
missing, so creating it later is a change. Ordinary hardlinks stay allowed: each path is its own entry and its link count is
compared. The ordinary rule is not widened to the H1 rule, so a rollback journal or another `.sqlite` suffix is outside
ordinary selection.

Root additions follow the storage boundary above. `/root/.codex` is a writable auxiliary home where native startup writes
helper files on purpose, and only the trees and original SQLite files are protected. Unselected root names are therefore
counted against the entry budget and recorded as added or removed evidence (`source.rootChanges`, the last passed checkpoint against the baseline, at
most 16 names each), and the preservation summary names them, but they do not refuse. Any added or removed root name that matches the mode's selector refuses, and
so does any change inside a selected tree, including an empty directory.

Each observation keeps the existing limits: 128 examined directory entries, the root's own children included; depth eight; 8 MiB per
file and 8 MiB of actual returned file and link-target bytes in aggregate; and one second. Directory and symlink sizes are
reported separately as metadata and are not budgeted. Enumeration is incremental. The entry, depth, kind and deadline limits refuse
before the next `lstat`, open or directory open; the byte limits refuse after the descriptor opens and before any
read or allocation, and every descriptor and directory closes on every path. A file is opened with
`O_NOFOLLOW` and `O_NONBLOCK`. Its descriptor must match the path's kind, device and inode. It is then read in 64 KiB chunks
up to its descriptor size, and a 1-byte probe must find end of file. Descriptor metadata must be unchanged after the read,
and path metadata unchanged after the entry. A checkpoint compares each chunk directly against the retained baseline bytes;
the digest is evidence only and is never compared.

A refusal reports the first difference only, not a full diff: the stage, the cause (a policy limit or a change), the
reason, the token, the field with before and after values, the counters, and the last 16 visited tokens. The first refusal
in a run is latched as `sourceRefusal`, so a later drained-shutdown checkpoint cannot overwrite its stage. An initial
observation refusal happens before any native spawn. The H1 cold copies refuse before the affected requester spawns. The
24 MiB aggregate copy budget is still charged from `history-copy.mjs`'s own path `lstat` sizes. The observer compares
path and descriptor on identity only, so that budget control stays reachable.

The preservation summary and the H1 `negative-public-read-result` are set in one place, last. Both require exit code zero,
no progress overflow, no omitted source evidence, and `after final shutdown attempts` as the last passed checkpoint.
Progress keeps its 512 KiB budget and reserves one `progressOverflow` marker line, written once. Checkpoint progress
lines are constant-size. Final-output source entries are bounded at 128 KiB before they are built, and an omission refuses before startup. The creator export refuses
above 7.75 MiB of encoded JSON before any base64 string exists, reserving 256 KiB of the host's 8 MiB output buffer
for records. A refusal,
progress overflow, export refusal, timeout, missing final output or host parse failure exits nonzero or throws on the host,
and none of them promotes preservation or H1 success.

This is not an atomic snapshot. It gives no protection against a hostile ancestor, makes no claim about atime, and does not
bound a single blocking system call; the deadline is checked cooperatively between calls. It makes no claim about client
stderr, listener ownership or forced shutdown.

[codex-history.test.mjs](../../tests/spikes/codex-history.test.mjs) drives the actual discovery entry through inert
boundaries. It includes the reproduced defects, which passed on `2f96265` and now refuse: an empty directory added inside
a protected tree, and a selected file replaced by the same bytes at a new inode. It also covers the root-addition,
selector, metadata, read, limit and closure controls, all under the [guarded runner](codex-guarded-tests.md).
[source-observation-result.json](../../spikes/codex-native/source-observation-result.json) records that inert evidence
and the SHA-256 of the exact sources it ran against, and marks native evidence `not-run`. Native and Docker gates have not
run for this source. The historical native records in `account-reads-result.json` and
`qualification-lifecycle-result.json` are unchanged and describe earlier sources only.

## Observed behavior

| Case | Native assertion |
| --- | --- |
| Indexed source | Native-created history and every original SQLite file remain unchanged. Discovery uses the private index. |
| Unindexed source | With all original SQLite files omitted, the same compatible native IDs remain discoverable. |
| Pagination | A limit of one returns at most one item, advances opaque cursors without repetition, and returns unique IDs within eight pages. |
| Source | Native app-server creation records source `vscode`. A `vscode`-inclusive query returns it. An `appServer`-only query excludes it. |
| Provider and cwd | Explicit provider filters and exact cwd filters include their matching fixtures. An absent provider and a child cwd return no records. |
| Archive | Active and archived queries return separate native fixtures. |
| Accounts | Each synthetic ChatGPT account sees its own thread plus unattributed shared history. Disabling the account filter returns both accounts. An API-key login sees both accounts even with `currentAccountOnly=true`. |
| Invalid public inputs | A malformed cursor, invalid source enum, and invalid excluded thread ID return protocol errors. |
| Malformed history | The corrupted native rollout is omitted. Other compatible records remain discoverable. Raw list metadata and all native notifications are retained. No structured coverage warning identifies the omitted record. |
| Known-target read | `thread/read` with `includeTurns:true` returns the valid ID. Corrupt-known returns `-32603` with metadata-read/empty-rollout failure. A distinct valid-format absent ID returns `-32600`, `thread not loaded`. No inference is dispatched. |
| Inaccessible layout | A regular file at the sessions-directory path returns error `-32603` with `Not a directory`. This tests `ENOTDIR`, not permission-denied behavior. |
| Scope | A separate native root and file or directory symlinks do not contribute IDs. Host admission rejects symlinks. |
| Lifecycle | Source bytes remain unchanged across startup, listing, and shutdown. Discovery dispatches zero inference requests. |

Account fixtures use the public `account/login/start` request with fabricated JWT claims. `chatgptAuthTokens` requires the explicit `experimentalApi` initialization capability in this version. `features.apps=false` disables default account-linked app startup in this isolated fixture. These tests establish local account-filter semantics, not real login, OAuth validation, account authorization, or live provider behavior. Account switching and the API-key login affect only fresh auxiliary state. The existing strict binding check still generates and checks the stable public bindings without experimental generation.

The known-target reads run only in the malformed variant, inside the same read-only-source/private-index process. The fixture manifest supplies original native IDs previously returned by public creation APIs. It does not discover unknown corrupt IDs. The valid paginated record returns `turns:[]`; a native `deprecationNotice` directs clients to `thread/turns/list` and `thread/items/list`. This probe establishes identity and failure behavior, not full-history hydration. Raw list replies contain `data`, `nextCursor`, `backwardsCursor`, and `readStates`. Retained notifications include unrelated bubblewrap `configWarning`, remote-control/account events, and the read deprecation notice. None identifies the omitted corrupt record. The emitted JSON retains those envelopes through process shutdown under the existing stdout limit.

## Bounds and remaining adapter requirements

Every container retains the existing network-disabled, read-only root filesystem, 128-process, two-CPU, 768 MiB memory, 128 MiB `/tmp`, and 64 MiB `/root` limits. The container deadline is 40 seconds and the host deadline is 45 seconds. Each protocol wait has a six-second deadline. The discovery client bounds requests to 128, stdout to 2 MiB, and pagination to eight pages with cursors below 512 characters. The host output limit is 8 MiB. Host admission and every container checkpoint use the [bounded source observation](#bounded-source-observation) limits, and the creator export is capped at 7.75 MiB of encoded JSON before encoding. Only the digest-verified executable, fixture code, manifest, and synthetic data enter the container.

These are process and fixture bounds. They are not native per-file read bounds. Pinned source shows that initialization recursively collects rollout paths and loads rollout items for metadata backfill before `thread/list`. The scanner has a 10,000-file traversal cap and bounded record lookahead on some listing paths. Neither limit bounds initialization, JSONL line bytes, total rollout bytes, compressed expansion, or total directory enumeration. A general production byte budget requires separately qualified host admission over the authorized stable root. Oversized or unreadable roots must produce an explicit incomplete or inaccessible outcome before native execution.

The supported path preserves original history and indexes and covers unindexed compatible history. Required broader coverage remains unresolved.
The public list response cannot distinguish a complete result from omitted malformed history in this probe. Listing alone cannot support a complete empty history.
Bounded inventory and public path inspection now observe unknown failed files, and the shared contract retains them beside successful sessions.
That combination resolves the exact selection mapping without a guessed private-format importer. A blanket coverage-unknown label alone would not resolve it.
The known-target read remains evidence for one failed metadata inspection distinct from the deliberately absent fixture ID.
Neither probe justifies a general corruption taxonomy, permission-denied behavior, old-format classification, or external busy-session handling.
The observed path failures are per-request replies, after which native discovery continues. Fatal scope-wide failures after useful observations still require a public outcome and fault tests before adapter support.
The `ENOTDIR` variant has no preceding path enumeration. Production admission must reject that directory layout before useful discovery; generic spike admission does not prove this policy.
The [selection document](codex-selection.md#reproduction-and-remaining-work) retains downstream ownership and every original native, live, host, and release requirement.

## Pinned source evidence

All source links use Codex commit `d32063f96c2dff1dc96af839b3952abb6acfeda4`.

- The [configuration schema](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/config.schema.json) documents `sqlite_home`, `log_dir`, and the apps feature configuration.
- [ThreadListParams](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server-protocol/schema/typescript/v2/ThreadListParams.ts) documents explicit source, provider, archive, account, cwd, and DB-only parameters.
- [Local listing](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/thread-store/src/local/list_threads.rs#L244) separates the DB-only and scan paths.
- [State initialization](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/rollout/src/state_db.rs#L99) waits for backfill. [Metadata extraction and collection](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/rollout/src/metadata.rs#L150) load rollout items and recursively collect paths.
- [Listing limits](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/rollout/src/list.rs#L147) and [directory collection](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/rollout/src/list_files.rs#L220) explain why pagination and file caps do not establish total byte bounds.
- [Account filtering](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/request_processors/thread_processor.rs#L6044) shares unattributed history and bypasses account filtering for API-key authentication.

## Public path summary experiment

The qualifier now inventories every admitted regular file under `sessions` and `archived_sessions` before native startup. It inspects every candidate through public `getConversationSummary({ rolloutPath })`. Enumeration supplies each absolute request path. The fixture manifest supplies expected identities and the deliberate corruption target only. No path request contains a native ID, and listing never selects inspection candidates.

The local evidence separates file observations from native identities. It retains each relative token, exact request and reply, returned-path containment result, broad listing pages, and enumeration termination. Distinct hardlink paths remain separate observations. Successful IDs can be deduplicated separately. Neither a list omission nor a file inspection failure implies a corrupt session. The harmless auxiliary file demonstrates why a generic native error cannot become `skipped.corrupt`.

The indexed, unindexed, and malformed containers perform these path requests. They have no outside-root data mount. Only the older symlink characterization mounts synthetic `/unauthorized` material and deliberately bypasses host rejection. That characterization does not prove mount-enforced exclusion. The path experiment never uses the bypass and never dispatches a path under `/unauthorized`.

Admission includes directories, protected indexes, and sidecars in its accounting. It permits at most 128 entries, eight levels, 8 MiB per regular file, 8 MiB of actual file bytes in aggregate, and one second. It rejects symlinks, special files, unexpected devices, traversal failures, unstable metadata, and paths outside the admitted history trees. Every regular history file qualifies regardless of extension. Directory enumeration stops when the entry or time budget fails. The synthetic fixture owner freezes the namespace. These metadata checks do not establish a production snapshot or exclude a hostile ancestor replacement.

The native client retains its six-second RPC deadline, 2 MiB stdout limit, and container resource limits. It keeps the exact first 64 KiB of stderr with a total byte count and a `truncated` flag, and every discovery report records each client's close, exit code, signal and that stderr in `drain`. The combined discovery client allows at most 128 protocol requests. Path inspection has a separate 32-request budget. Broad listing uses at most eight pages of two records for each archive value, every pinned source kind, all providers, and `currentAccountOnly:false`. It omits cwd, search, section, project, relation, and exclusion restrictions. Exhaustion, page truncation, native failure, and repeated or invalid cursors remain distinct observations. This is ordinary listing, not an all-native-object guarantee.

The host checks the full source metadata and bytes over the container lifecycle. The client checks selected metadata and bytes before startup, after initialization, after requests, after stdio-drained shutdown, and after final shutdown attempts. Unexpected failures retain bounded request and reply evidence, drained notifications where possible, and preservation checks. A separate 512 KiB progress stream preserves observations in captured container stderr if an outer deadline prevents the final report. Progress truncation is explicit and emits one reserved `progressOverflow` marker. Inspection must dispatch zero inference. Synthetic fixture preparation keeps its existing loopback inference flow.

The generated public binding consumer also includes the path-only request. The Linux arm64 native run retained compatible active, archived, provider-diverse, cwd-diverse, and synthetic-account identities alongside an explicit malformed unknown-ID path failure. Missing-path and directory-path requests are labeled negative controls. The auxiliary outcome remains an unclassified file observation. Host-only controls cover rejected symlinks and outside paths, distinct hardlinks, and exhausted admission and request budgets. Their dispatch count must remain zero.

A successful path summary reads native metadata. It does not validate the entire history or prove that native inspected exactly the requested physical bytes. Missing, outside, or ambiguous returned paths remain unresolved. This deprecated pinned API does not establish future support. Revert files, compression, logical aliases, attached-thread eligibility, stale indexes, permission-denied diagnosis, old formats, busy-session handling, unreadable-file account attribution, and resume authorization remain unqualified.

The shared discovery contract now preserves successful sessions alongside required `diagnostics` on complete, truncated, and cancelled pages.
Each `file-inspection-failed` diagnostic identifies an admitted failed file observation with an opaque call-local subject, without claiming a session identity or corruption classification.
The installed controlled consumer proves retention and rejects these subjects as session handles. It does not qualify a native adapter or budget enforcement.
A future adapter must construct redacted tokens independently of this qualifier's relative paths and preserve observations across termination.
The experiment still adds no adapter and makes no `complete` claim. Corrupt, inaccessible, incompatible, busy, old-format, account, namespace, alias, and external resume acceptance remain required and unqualified.

The observed arm64 run inspected nine admitted files in each path mode. Indexed and unindexed sources returned eight summaries for seven native identities. Malformed sources returned seven summaries for six identities and a path-specific `-32603` failure for the deliberately malformed file. The auxiliary file also returned `-32603`. Missing and directory controls returned `-32600`. The hardlink alias returned the second fixture's native identity as a separate file observation. Both ordinary listing collections exhausted, every successful returned path was contained, originals remained unchanged, and inspection dispatched zero inference. These observed codes classify these fixtures only. The separate x64 CI execution is linked above.

## Qualification lifecycle

The current discovery variants share `client.mjs`. It rejects malformed, non-UTF-8, invalid-envelope, oversized-frame and truncated-EOF output, stdout overflow, invalid outgoing envelopes, asynchronous process, stdin and stdout errors, and requests beyond 128 before dispatch. Shutdown waits for the process `close` event and drained stdio, closes the reader, then rejects any latched protocol or transport failure, including final-drain faults. After six seconds it sends SIGKILL and waits at most six more seconds for close. Helper imports perform no native or daemon operation.

The qualifier uses `lifecycle.mjs` for every named container. Successful run or removal supplies operation evidence. An independent bounded inventory must also omit the exact name. Failed creation plus failed removal plus empty inventory remains uncertain because daemon-side creation may arrive late. No uncertain creation is retried. Failed execution still fails after confirmed cleanup, except for the Legacy tail containers below, whose bounded partial report is kept as `acquisition: 'partial'` (or `'unparsed'`) and can only make that experiment inconclusive. Bounded partial stdout and stderr survive failure.

On uncertainty the qualifier retains the actual frozen work directory and emits its exact path and container name. It deletes work only after confirmed absence, and prints success only after work removal. The focused inert tests intercept actual source and transports. They establish branch behavior without running Docker, a native executable, or a listener. Historical parent arm64 and emulated x64 runs at `d467665e4faa` passed all five discovery modes, twelve behavior assertions, and strict compilation of 784 generated public binding files. Parent independently confirmed both exact containers and every qualifier run directory absent. `qualification-lifecycle-result.json` records the retained report and absence hashes. Fresh parent runs after the shutdown correction passed the same arm64 and emulated x64 native, binding, and cleanup controls. Eleven focused inert tests include final-drain failure propagation through the actual discovery entry point; all 26 package tests pass. Current and historical evidence hashes are separate in the result file. These observations do not qualify native x64 hardware, macOS, H1, or a live provider.

The original behavior probe, strict bindings, and five discovery modes remain unconditional. This lifecycle change does not resolve H1 projected history, requester or creator authority, native account eligibility, source confinement, or pg51. Every original wrong-account, busy, old, corrupt, inaccessible, external discovery and resume requirement remains. All engines, direct and LiteLLM modes, native features, host authorization and durability, compiler and release acceptance, and no blind retry remain required.

## Cold projected-history H1 candidate

The complete source candidate adds synthetic A, B, API-key, and separate malformed-file targets after all five original discovery modes. Both prior native attempts remain inconclusive. The first returned a null requester account. The auth-required revision reached correct A requester correspondence and an empty saved-turn page. Parent runs of this cold-copy profile passed on Linux arm64 and emulated x64. Each passed all five original discovery modes, twelve behavior cases, strict compilation of 784 generated public binding files, three actual requester contexts and nine exact saved-turn/message associations. The initial copies totaled 1,865,808 bytes per run. Original sources stayed unchanged, inspection inference was zero, and parent independently confirmed both exact named containers and all owned work directories absent. [account-reads-result.json](../../spikes/codex-native/account-reads-result.json) records these separate outcomes and current native report and independent absence hashes.
The host authorizes and freezes the whole synthetic source, including every original SQLite file and sidecar, within the existing 8 MiB admission bound. Before every reader spawn, including initial A, the common connection copies exactly `thread_history_1.sqlite` and each present WAL and SHM into a distinct newly created empty private SQLite directory. Absent sidecars stay absent. Unsupported history families and rollback journals refuse. Every destination file must match the admitted size and SHA-256, and is compared directly against the reader baseline's retained source bytes, without sharing an inode with any original or earlier reader copy. Failed or partial copies cannot start that reader. Three initial families remain within 24 MiB in aggregate. The metadata index stays fresh and private.
Preparation retains actual native turn-start and matching completed IDs, status, and expected user and assistant messages in the exported fixture manifest. Readers require that exact completed turn and both expected messages associated with it. This is the smallest chosen public fixture witness. Additional creator page diagnostics would observe projection availability earlier but would not repair a missing projection. No full loaded read, persistence, resume, retry, or extra inference repairs an empty page. These associations prove neither complete rollout projection nor a projection watermark.
Each reader first establishes actual synthetic requester context through `account/read`, checks its selected `sqlite_home`, then exhausts paired visibility lists, inventory-selected path-only summaries, metadata-only known-ID reads, and bounded turn and item pages. A reads A and B reads B remain positive controls. B must omit A from current-account listing yet read A by known ID. A and B both see the API-key-created target. The API-key requester sees A and B with either filter. Creator-field, malformed path, corrupt known ID, distinct absent ID, nonempty history, unique IDs, cursor, and message-association controls remain required. Generic failures, empty pages, visibility, and expected string equality cannot classify wrong account.
Only all controls, zero inspection inference, preserved selected source metadata and bytes through final shutdown attempts and the host container lifetime, confirmed container absence, and removed owned work can earn the bounded `negative-public-read-result`. Failure and truncated required proof stay inconclusive. Drained SIGTERM termination proves no clean SQLite close or checkpoint. Present recovery sidecars remain part of the cold snapshot. Native writes affect disposable copies only.
The supported auth-required provider profile uses separate synthetic loopback model and routing-bootstrap origins. Both listeners share the existing HTTP30 limit. All existing RPC, time, page, path, output, progress, entry, memory, tmpfs, image, network, and compiler limits remain. The current qualified client and uncertainty-preserving container owner are unchanged. Eighteen focused inert tests intercept the actual source boundaries and start no native executable, daemon, or listener. The native observations qualify this bounded snapshot experiment only. They do not qualify native x64 hardware, macOS, production accounts, an adapter, or live providers.
This is a snapshot-dependent experiment. It supplies no history-only reconstruction, unique creator attribution, production eligibility classifier, general discovery coverage, adapter support, or pg51 completion. Every original wrong-account, busy, old, corrupt, inaccessible, external discovery and resume, no-rewrite, all-engine, direct and LiteLLM, native-feature, host authority and durability, no blind retry, confinement, SDK, native adapter, live, macOS, and release requirement remains open.

## Legacy tail-record read experiment

Status: native observation, outcome `successful-reads-uncertified` on Linux arm64 and x64.
[legacy-tail-result.json](../../spikes/codex-native/legacy-tail-result.json) pins the outcome and every control's
per-step reply branch, error code and masked message, and the list of tail steps that differ from healthy. `qualify.mjs`
prints its full report and then fails any native run that differs. Evidence: the coordinator's arm64 report at `5e92b3e`
(sha256 `9200ae04…e9`), which predates the mtime control below, and CI x64 runs 44002471188 at `5e92b3e` and 44003944604
at `d044530`, the first with the mtime control. The coordinator reruns arm64 on the final head before merge.

The question is narrow. Genuine Legacy history is created through the public experimental `historyMode: "legacy"` option on
`thread/start`. If that history's rollout file is followed by one malformed JSON tail record, does the public read path
reject it within bounds, read it successfully, or give inconclusive evidence?
[legacy-tail.mjs](../../spikes/codex-native/legacy-tail.mjs) owns the experiment; `discovery.mjs` enters it through the
`prepare-legacy` and `legacy-read <control>` modes, and `qualify.mjs` runs it after the account reads.

The creator runs in its own container. It starts one thread with `historyMode: "legacy"`, runs one synthetic turn to
`turn/completed`, reads the thread back metadata-only, and drains. Only then does it capture the home and verify that the
capture is still unchanged. Start and read-back must both report `legacy`, and the native-returned path must be a plain
`sessions/**.jsonl` file of at most 4 MiB that starts with `{` and ends in `\n`. No other private format fact is used. If
any of this fails, the result is a labelled creator precondition failure and an inconclusive conclusion; no reader runs, the
full report is printed, and the run then fails because the conclusion differs from the pin.

The malformed record is the 14 bytes `{invalid-json\n`, the same bytes as the whole-file `malformed` control. The native
file ends in `\n`, so appending them adds exactly one LF-terminated line and leaves every native byte unchanged. The line
opens an object and is invalid JSON. Tail and whole therefore differ only in the genuine native prefix.

Each control is its own container with a fresh `/root` tmpfs home holding only `sessions` and `archived_sessions`, frozen
by host admission and checked across the container lifetime. No original SQLite or projected history is mounted.
`/tmp/private-index` and `/tmp/private-logs` must not exist before spawn, and every reader must report the same
`config/read` digest. The digest sorts keys and masks only the per-container ephemeral loopback port of the synthetic
Responses server, because the first x64 run showed both varying between otherwise identical homes. Native derives
`recencyAt`, and the loaded read's `updatedAt`, from the rollout's mtime, so the host gives every written rollout the mtime
the creator observed on the native export. Healthy and tail then differ only in the appended bytes.

| Control | Rollout bytes in the home | Requests | It proves |
|---|---|---|---|
| `healthy` | native | native ID and path | actual Legacy saved history: `historyMode: "legacy"`, the exact ID and path, the completed turn and both messages |
| `tail` | native + record | native ID and path | the observation |
| `whole` | record alone | native ID and path | a malformed file is publicly rejected on some step healthy answered |
| `absent-id` | native | native path, never-created ID | the path still resolves to the native ID while the absent ID is rejected |
| `absent-path` | none | native ID and path | the native path, absent from this home, is rejected |

Every control dispatches the same fixed sequence and keeps every reply: `getConversationSummary` by path, `thread/read`
with `includeTurns:false`, `thread/read` with `includeTurns:true`, then `thread/turns/list` and `thread/items/list` in
ascending pages of one, at most eight pages, with non-repeating cursors. The loaded read is there because the binary contains
the message "does not use paginated history", so the page APIs may refuse Legacy threads by design.

`legacyConclusion` is the only conclusion site. A creator precondition failure, a partial or unparsed reader, missing
preservation, inference, progress or stderr truncation, an unclosed client, an incomplete sequence or page refusal, a reply
with no single result or error branch, a configuration mismatch, or a failed healthy, whole, absent-id or absent-path
control gives `inconclusive` with named reasons. Otherwise steps are aligned by method, read shape and ordinal. Only steps
the healthy control answered count. A well-formed JSON-RPC error on one of them in the tail control gives
`bounded-public-rejection`; bounds come from the six-second RPC deadline, clean drain and preserved source. All of them
succeeding with the native ID gives `successful-reads-uncertified`: success does not certify that every saved record is
valid JSON. Each compared step also records whether the tail reply equals the healthy reply or the absent-path error.

### Result

- **Tail.** Public reads of Legacy history whose native bytes are followed by the malformed record succeed. The path
  summary and both `thread/read` shapes return the native ID. The loaded `thread/read` and `thread/turns/list` return the
  same saved turn as the healthy control: the completed turn with its `userMessage` and `agentMessage`. Because they
  succeed, these reads fail to certify the tail's syntax; nothing in the replies reports the record.
- **Equality.** On arm64 before the mtime control, the only tail-versus-healthy differences were `recencyAt` in both
  `thread/read` replies and `updatedAt` in the loaded one; both followed each home's write time. On x64 with the mtime
  control, every home's rollout carried the native mtime, the tail file's ctime fell in a later second, and every tail
  reply equalled the healthy reply, with `recencyAt` on the mtime's second. The pin requires that equality.
- **Whole file.** A rollout holding only the 14-byte malformed record is reported as empty: every step except
  `thread/items/list` returns `-32603` with "failed to read session metadata … rollout at … is empty". No wider parsing
  rule is inferred.
- **Absent controls.** `absent-id` still summarizes the native path, and every ID read returns `-32600`, `thread not
  loaded`. `absent-path` returns `-32600` "failed to resolve rollout path … file does not exist", and its ID reads
  return `thread not loaded`.
- **Items.** `thread/items/list` returns `-32601` "not supported yet" in every control, so it is uninformative.

This classifies no corruption, incompatibility, warning, account, continuation or old-format behavior, and it does not
qualify paginated history, macOS, live providers or an adapter.

## Adapter composition and native proof

Status: **pending native proof**. [sessions-proof-result.json](../../spikes/codex-native/sessions-proof-result.json) has no recorded outcome yet.

The private `src/adapters/codex/sessions.ts` composes the qualified reads above. It borrows an initialized app-server's `request`, the host's `initialize` result and the home path. It checks that `initialize.codexHome` equals the home. The server version is only in the untyped `userAgent` text, so it is not checked; the binding pins `0.169.0`. Every operation reads `config/read` and refuses unless `sqlite_home` and `log_dir` are absolute and outside the home. It then derives the requester from `account/read {refreshToken:false}`. Discovery admits `<home>/sessions` on the host, inventories it without opening a file, then calls `getConversationSummary({rolloutPath})` for each path and `thread/read {includeTurns:false}` for each new ID. A summary whose path differs from the request becomes a diagnostic. Listing, `currentAccountOnly` and `archived_sessions` are not used.

| Required outcome | Typed result | Basis |
| --- | --- | --- |
| Discoverable, resumable | `sessions[]`; `prepareResume` → `ready{threadId}` for paginated history | Qualified reads; exact ID returned, nothing dispatched or reserved |
| Absent | `absent` only for `-32600` `thread not loaded: <id>` | Qualified message; other errors are `native-failure` |
| Wrong account | `binding-mismatch` at resume (reference or changed login); `invalid-input`/`inaccessible` in inspect and discover | Switchboard binding and synthetic requester correspondence. Creator attribution is unqualified and never classified |
| Busy | `busy` when this app-server process has the thread loaded | Per-process status only. Busy writers in other processes are unqualified; x9av owns writer reservation and must reject a resume reply with a different `thread.id` |
| Old format | `incompatible{native-format}` on a `historyMode` mismatch, and for every Legacy resume | Legacy exact resume is unqualified; ajqy qualified reads only. `incompatible{native-version}` is never emitted |
| Corrupt | Discovery diagnostic; known target `native-failure`; `skipped.corrupt` stays 0 | A generic `-32603` also comes back for harmless files |
| Inaccessible | Invalid or symlinked `sessions` tree → `inaccessible` before any native request; host EACCES/EPERM counts | Permission-denied files are unqualified and stay diagnostics |

Bedrock, GCP, null and user-less ChatGPT requesters are refused as `inaccessible`.

`node spikes/codex-native/sessions-proof.mjs <codex-linux-<arch>.tgz> <arm64|x64>` compiles the product module into owned work and mounts it read-only. It reuses the `prepare` and `prepare-legacy` creators unchanged, then runs one reader container per scenario. R1 reads an unindexed home with an auxiliary file and a hardlink alias. R2 replaces one rollout with malformed bytes. R3 makes `sessions` a regular file. R4 starts the server without a private index. R5 uses Legacy history. R6 copies R1 into the container, resumes the prepared ID with `thread/resume {threadId}` and then changes the login. The proof also records that the fixture's `cliVersion` is `0.169.0` and that `thread/read` returns `Thread.path`. Read-only homes are verified over each container lifetime. Cleanup follows the qualifier's owned-container rules. CI runs it on x64 after the qualifier; the coordinator runs arm64. Until an outcome is recorded, a run enforces its R1–R6 checks but not the pin. It covers synthetic Linux homes only, not macOS or live providers.
