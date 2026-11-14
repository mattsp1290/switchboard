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

Every container retains the existing network-disabled, read-only root filesystem, 128-process, two-CPU, 768 MiB memory, 128 MiB `/tmp`, and 64 MiB `/root` limits. The container deadline is 40 seconds and the host deadline is 45 seconds. Each protocol wait has a six-second deadline. The discovery client bounds requests to 128, stdout to 2 MiB, and pagination to eight pages with cursors below 512 characters. The host output limit is 8 MiB. Fixture admission limits source entries to 128 and source bytes to less than 8 MiB. Only the digest-verified executable, fixture code, manifest, and synthetic data enter the container.

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

Admission includes directories, protected indexes, and sidecars in its accounting. It permits at most 128 entries, eight levels, 8 MiB per regular file, 8 MiB aggregate metadata sizes, and one second. It rejects symlinks, special files, unexpected devices, traversal failures, unstable metadata, and paths outside the admitted history trees. Every regular history file qualifies regardless of extension. Directory enumeration stops when the entry or time budget fails. The synthetic fixture owner freezes the namespace. These metadata checks do not establish a production snapshot or exclude a hostile ancestor replacement.

The native client retains its six-second RPC deadline, 2 MiB stdout limit, bounded stderr tail, and container resource limits. The combined discovery client allows at most 128 protocol requests. Path inspection has a separate 32-request budget. Broad listing uses at most eight pages of two records for each archive value, every pinned source kind, all providers, and `currentAccountOnly:false`. It omits cwd, search, section, project, relation, and exclusion restrictions. Exhaustion, page truncation, native failure, and repeated or invalid cursors remain distinct observations. This is ordinary listing, not an all-native-object guarantee.

The host checks source file sets and hashes over the container lifecycle. The client checks them before startup, after initialization, after requests, and after stdio-drained shutdown. Unexpected failures retain bounded request and reply evidence, drained notifications where possible, and preservation checks. A separate 512 KiB progress stream preserves observations in captured container stderr if an outer deadline prevents the final report. Progress truncation is explicit. Inspection must dispatch zero inference. Synthetic fixture preparation keeps its existing loopback inference flow.

The generated public binding consumer also includes the path-only request. The Linux arm64 native run retained compatible active, archived, provider-diverse, cwd-diverse, and synthetic-account identities alongside an explicit malformed unknown-ID path failure. Missing-path and directory-path requests are labeled negative controls. The auxiliary outcome remains an unclassified file observation. Host-only controls cover rejected symlinks and outside paths, distinct hardlinks, and exhausted admission and request budgets. Their dispatch count must remain zero.

A successful path summary reads native metadata. It does not validate the entire history or prove that native inspected exactly the requested physical bytes. Missing, outside, or ambiguous returned paths remain unresolved. This deprecated pinned API does not establish future support. Revert files, compression, logical aliases, attached-thread eligibility, stale indexes, permission-denied diagnosis, old formats, busy-session handling, unreadable-file account attribution, and resume authorization remain unqualified.

The shared discovery contract now preserves successful sessions alongside required `diagnostics` on complete, truncated, and cancelled pages.
Each `file-inspection-failed` diagnostic identifies an admitted failed file observation with an opaque call-local subject, without claiming a session identity or corruption classification.
The installed controlled consumer proves retention and rejects these subjects as session handles. It does not qualify a native adapter or budget enforcement.
A future adapter must construct redacted tokens independently of this qualifier's relative paths and preserve observations across termination.
The experiment still adds no adapter and makes no `complete` claim. Corrupt, inaccessible, incompatible, busy, old-format, account, namespace, alias, and external resume acceptance remain required and unqualified.

The observed arm64 run inspected nine admitted files in each path mode. Indexed and unindexed sources returned eight summaries for seven native identities. Malformed sources returned seven summaries for six identities and a path-specific `-32603` failure for the deliberately malformed file. The auxiliary file also returned `-32603`. Missing and directory controls returned `-32600`. The hardlink alias returned the second fixture's native identity as a separate file observation. Both ordinary listing collections exhausted, every successful returned path was contained, originals remained unchanged, and inspection dispatched zero inference. These observed codes classify these fixtures only. The separate x64 CI execution is linked above.

## Qualification lifecycle

The current discovery variants share `client.mjs`. It rejects malformed and nonobject output, stdout overflow, asynchronous process and stdin errors, and requests beyond 128 before dispatch. Shutdown waits for the process `close` event and drained stdio. After six seconds it sends SIGKILL and waits at most six more seconds for close. Helper imports perform no native or daemon operation.

The qualifier uses `lifecycle.mjs` for every named container. Successful run or removal supplies operation evidence. An independent bounded inventory must also omit the exact name. Failed creation plus failed removal plus empty inventory remains uncertain because daemon-side creation may arrive late. No uncertain creation is retried. Failed execution still fails after confirmed cleanup. Bounded partial stdout and stderr survive failure.

On uncertainty the qualifier retains the actual frozen work directory and emits its exact path and container name. It deletes work only after confirmed absence, and prints success only after work removal. The focused inert tests intercept actual source and transports. They establish branch behavior without running Docker, a native executable, or a listener. Fresh parent arm64 and emulated x64 runs passed all five discovery modes, twelve behavior assertions, and strict compilation of 784 generated public binding files. Parent independently confirmed both exact containers and every qualifier run directory absent. `qualification-lifecycle-result.json` records the retained report and absence hashes. These observations do not qualify native x64 hardware, macOS, H1, or a live provider.

The original behavior probe, strict bindings, and five discovery modes remain unconditional. This lifecycle change does not resolve H1 projected history, requester or creator authority, native account eligibility, source confinement, or pg51. Every original wrong-account, busy, old, corrupt, inaccessible, external discovery and resume requirement remains. All engines, direct and LiteLLM modes, native features, host authorization and durability, compiler and release acceptance, and no blind retry remain required.
