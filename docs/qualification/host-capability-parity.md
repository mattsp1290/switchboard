# Host and runtime capability matrix

Image capabilities promise adapter input transport. Hosts own attachment integrity, storage, resizing and presentation; a capability does not promise that every model understands every accepted image. All supported inputs share canonical PNG/JPEG data URLs, at most 16 images and 4,194,304 decoded bytes total per call. Empty arrays mean omission. Malformed input never silently becomes text-only input.

| Adapter/API | Approvals | Images | Models | Command/file activity | Native errors |
| --- | --- | --- | --- | --- | --- |
| ./host/codex | Direct native choices; combined calls/approvals | Direct only | Direct sessionless native catalog; route unavailable | Opt-in native items, including late activity | Bounded native causes on failed results |
| ./cursor | Runtime offers no approval API | Structured native send on create/resume | Explicit-key sessionless native Cursor records | Existing tool observations | Existing generic failures |
| ./claude | Tools/permissions remain off | Finite structured user prompt, with resume | Deferred: SDK discovery belongs to a query lifecycle | Existing observations | Existing generic failures |
| ./pi | Tools remain off | Native prompt images when the selected model accepts them | Deferred: offline registry is separate | Existing observations | Existing generic failures |
| ./host/pi | approvals:[]; host owns tool decisions | Unsupported | Unsupported; synthetic host model is not a catalog | Existing host-tool events | Existing stream/route failures |
| ./host/opencode | approvals:[]; permissions remain cancelled | Unsupported | Unsupported; existing per-session selection | Existing tool traffic remains fail-closed | Existing numeric/generic behavior |
| Claude-host discovery | No execution adapter | No execution API | No catalog API | No execution API | Existing discovery failure contract |

The runtime APIs remain separate from HostAdapter. Their media support does not enable native tools, approval decisions, generic native errors or the raw host-item contract. No native SDK type is exported through the root package. Installed consumers separately type-check the Codex/core additions and each runtime API.

## Evidence and limits

The isolated suite runs the real pinned SDKs with deterministic provider/CLI fixtures in Docker, with no network, read-only package mounts, decoy credentials and syscall tracing. It verifies actual Claude user frames, Cursor SDK send arguments and Pi provider requests/history. The pinned local Cursor SDK then emits base64-only executor items without mimeType; executor acceptance and media-type handling have not been qualified. Cursor fixtures do not prove executor MIME preservation. Cursor catalog fixtures exercise only the SDK catalog seam, including explicit-key isolation and uncancellable-call lease behavior. Fixture success does not prove current account entitlement, live provider access or image understanding.

[Codex direct qualification](codex-host-direct.md) records the separate exact-pin native command accept/cancel/held interrupt and valid 4 MiB image proof. File-change accept/cancel has inert public-event correlation coverage; its optional native proof remains separately labelled. The common root tripwire continues to forbid importing SDK suites through npm test.

## Deliberate deferrals

Pi-host media requires a lossless PiHostTurn/state schema version and validators, turnsFrom/messagesFrom, stream/route-body contracts, a host capability declaration, fingerprint bounds and fresh-process media resume together. Enabling only run.images would lose persisted or routed media, so Pi-host rejects it before dispatch.

OpenCode media requires ACP-v1 initialization image-capability negotiation, a complete frame/echo audit, and proof that model/permission controls survive. The current host rejects images before dispatch.

Full native approval/activity/error parity on Claude/Cursor/Pi needs a host execution adapter or an explicit runtime event/error contract. This milestone builds neither. Claude query-scoped discovery needs its own lifecycle contract; Pi's registry is not an account catalog. AG-UI approval projection, offline descriptors (switchboard-ooyu), typed generic runtime failures (switchboard-f7nt) and native-version upgrades remain separate work.

These adapter choices do not claim that the underlying SDKs lack native features. Main merge, publication, OpenPane vendoring and its client removal remain delivery/consumer acceptance steps, separate from this branch's implementation and qualification.
