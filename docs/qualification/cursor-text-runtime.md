# Cursor text runtime qualification

`createCursorTextRuntime(options: CursorRuntimeOptions): CursorRuntime` is exported
from `@operatorworks/switchboard/cursor`. The candidate control contract is
`cursor-text-v1`, with `@cursor/sdk` exactly `1.4.2` and Node `>=24.22.3 <25`.
Build and test tools are Node `24.22.3` and npm `11.19.1`. This is an upstream
adapter candidate. Crew's deployment, provider-context and ownership audit must
pass before merge or adoption. No Linux architecture is qualified for production
by the adapter tests alone.

## Resume requires host ownership

The user approved this boundary on November 23, 2026. Hosts must keep text
sessions in private, policy-specific stores and use durable ownership records
to admit only IDs created under the same text contract. Generic, imported,
wrong-policy and unowned sessions must be rejected before calling Switchboard.
Crew owns that check, including recovery after a process restart. If its existing
records cannot enforce ownership, adoption remains blocked until it adds the
check. Separate directories alone do not authenticate an ID or prevent imports.

Switchboard does not inspect SDK-owned metadata, authenticate provenance, rewrite
transcripts, migrate sessions, or silently retry with a new identity. Native
resume remains available for admitted text-created sessions. Same-policy state
must not reintroduce execution controls or ambient model context.

SDK 1.4.2 converts `agents: {}` to `undefined` and falls back to stored custom
subagents during resume. This was confirmed offline with a generic-created
sentinel session. The tools allowlist stayed empty. That probe proved retained
definitions, not execution or provider receipt. SDK request-context construction
can use subagent definitions independently of the tools header. Consequently,
cross-policy conversion is unsupported; empty tools alone is not a context
isolation guarantee. SDK modifications are prohibited. Upgrades are permitted,
but the public registry's newest release at the recovery check was still 1.4.2.

The original probe and log remain at
`/tmp/switchboard-cursor-text-audit.HLYRj5/`. They describe the pre-amendment gate,
not the acceptance criteria for the current candidate.

## Fixed controls and source audit

The generic factory retains its existing project-settings and sandbox policy.
The text factory builds one complete options object for both create and resume:

| Location | Controls |
|---|---|
| Top level | Validated `apiKey`, exact caller `model.id`, `tools: []`, `mcpServers: {}`, `agents: {}` |
| Local | Validated `cwd`, new `JsonlLocalAgentStore(sessionDirectory)`, `settingSources: []`, `sandboxOptions: { enabled: false }`, `enableAgentRetries: false` |
| Local | One retained `emptyFs()` tree per runtime, `reportedWorkspacePath: '/'`, `customTools: {}`, `hostMcpBridgeUrls: []`, `dirs: []`, `autoReview: false` |

No cloud, prompt, inheritance, resource-provider, plugin, hook or send overrides
are accepted. JavaScript caller extras are discarded by the four-field input
copy. Text images are refused before admission. Tool and task stream messages
fail the turn before publishing tool callbacks or observations. This defensive
refusal cannot undo an operation and does not replace launch controls.

Installed declarations in `dist/esm/options.d.ts` place top-level tools at line
625, local at 682, MCP at 684 and agents at 685. Local controls are cwd 218,
dirs 225, autoReview 231, store 240, settingSources 247, sandboxOptions 248,
customTools 259, retries 273, bridges 298, reported workspace 331 and fs 361.
The package verifier compiles the real private boundary against cloned SDK
declarations and removes each required field in isolation. Public declarations
remain independent of the optional SDK.

The SDK implementation in `dist/esm/index.js` maps tools to allowed proto tools
and reapplies them on resume. The SDK serializes `tools: []` as an empty-string allowed-tools header. Its backend meaning is unqualified: an empty value may be interpreted as absent. Before merge, Crew must inspect the serialized request and prove that the executor cannot execute a tool for a text-policy session. A guard observing a tool event cannot undo execution.
It forwards settings, sandbox, bridges, MCP and subagents to executor creation.
`dist/esm/977.js` uses the virtual-tree resource provider to suppress the host
shell, hooks, project MCP, host git context and skill discovery. Its `YW` helper
uses virtual rules only when project sources are enabled; this contract leaves
them disabled. Virtual-tree session MCP and custom callback registries are empty.
The SDK mounts a fresh in-memory `/tmp` for each run, separate from host temp
files. Restored subagents remain the documented cross-policy limitation above.

These control decisions are bundled in the owning SDK package. No additional
package identity is treated as a runtime control authority. Native platform
assets and the complete locked transitive closure remain mandatory qualification
inputs; changing them invalidates qualification reuse. Runtime identity checks
do not attest arbitrary transitive bytes or backend behavior.

## Host access inventory

This inventory distinguishes host activity from model-visible context. Static
inspection is not a deployment trace.

| Host surface | Access and control | Deployment evidence still required from Crew |
|---|---|---|
| Authentication | Explicit API key is supplied for launch and catalog. SDK default auth is `~/.cursor/sdk/auth.json`; the adapter never invokes login. | Verify no ambient credential source wins or is exposed during actual execution. Do not mount user credentials. |
| SDK state | Default session state is `{project}/sdk-agent-store/{sha256(workspaceRef)}`; explicit store replaces that selection. Global executor initialization may still consult other SDK state. | Trace actual state paths and required writes with a read-only root. No extra writable consumer volume is authorized. |
| Session store | Read and write JSONL agent/run/event/checkpoint records under the explicit private root. Checkpoint save/patch errors can be logged and swallowed by the SDK while a run still completes; completion alone does not prove durable latest context. | Private writable mount, durable policy ownership, exact erasure inventory and cross-process write coordination. Before owned resume, verify that the latest expected provider context survived checkpoint persistence; stale persisted context must stop resume. |
| Physical transcripts | At each checkpoint the SDK writes conversation JSONL, including available nested transcripts, through a physical writer outside `local.fs` and the explicit session store. Its project root is `$CURSOR_DATA_DIR/projects/<cwd-slug>` when set, otherwise writable `~/.cursor/projects/<cwd-slug>`, otherwise `<tmpdir>/cursor-transcripts-*/<cwd-slug>`. Files live under `agent-transcripts/<id>/<id>.jsonl`; run completion joins pending writes. Unwritable home and temp storage can fail writer construction. | Crew must use existing private storage, pin or exclude `CURSOR_DATA_DIR`, trace the selected path and content, and include transcripts in erasure. Deleting the session store alone is insufficient. A required path that cannot fit existing hardened mounts stops the candidate. |
| Host temporary files | SDK infrastructure can use OS temporary files. Virtual `/tmp` is separately in-memory and per-run. | Trace host paths and lifetimes; provide only existing private temp storage. |
| Physical cwd and git | Readable private cwd remains needed. Executor initialization can discover physical workspace/git information. Virtual resources suppress host git/workspace context in model requests. | Trace physical access and inspect serialized request context with outside-cwd canaries and seeded files. |
| Host sandbox policy | Executor creation reads `~/.cursor/sandbox.json` when an API key is present, before applying `sandboxOptions.enabled: false`. A virtual filesystem does not redirect this host read. | Do not mount the user home; trace the private home policy path, including malformed or unreadable files. |
| Ambient environment | `CURSOR_DATA_DIR` redirects physical project/transcript storage. `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` takes precedence over the catalog and can rewrite an explicit caller model through aliases. The ordinary provider catalog also normalizes aliases even without this override; an explicit alias is not a canonical model pin. `CURSOR_RIPGREP_PATH` selects a helper; `CURSOR_TREE_SITTER_VENDOR_DIR` selects parser assets. `CURSOR_BACKEND_URL` and `CURSOR_WEBSITE_URL` select endpoints; a localhost backend can set `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide. `CURSOR_SDK_MOCK_PROMPT_TIME` and `CURSOR_SDK_DEV_FORCE_NEXT_SMART_MODE_CLASSIFIER_BLOCK_TOKEN` alter request behavior. SDK and native dependencies also consult standard home, path, shell, temporary-directory and platform variables. | Crew must launch with an explicit allowlist, exclude model-catalog and development overrides, and exclude or pin helper and endpoint overrides. Verify the actual worker environment and compare the effective model ID with the caller's canonical selection, and trace destinations, helpers and host reads at the pre-merge candidate gate. |
| Native helpers | SDK platform assets can be resolved during initialization. Sandbox is disabled before launch and the tools allowlist is empty; actual executor exclusion remains unqualified. | Inventory actual helpers and descendants on the target architecture. No privileges or relaxed hardening are authorized. |
| SDK analytics and attribution | Executor startup can make an authenticated analytics bootstrap call. Ordinary run-created and run-completed analytics can include the effective model, prompt length and an available prompt hash, independently of PR attribution or physical Git metadata. After finished or errored runs, the facade schedules PR attribution using physical cwd values, regardless of the virtual filesystem. A privacy-mode lookup gates attribution; when permitted, it can invoke `git`, `gh` and `origin` in those directories and submit PR metadata through SDK analytics. Agent disposal waits for attribution and analytics flushing. | Trace startup, post-terminal work and close under the hardened worker. Verify destinations, metadata fields, private home/CLI credential isolation, helper denial and close latency. Neither the launch tuple nor fixture completion qualifies these paths. |
| Provider transport | SDK model/catalog and inference calls need provider network transport. Disabling model tools does not disable this transport. | Qualify destination policy and serialized contents under the unchanged hardened deployment. |

No deployment requirement is inferred as passed from imports, fake SDK calls,
completion, cancellation or close. A required undisablable source in a valid
text session stops the candidate. Unknown helper termination and erasure
inventory remain unknown.

## Local verification and external gates

The isolated suite captures actual create arguments and resume's second argument,
checks every fixed key/value and omission, exercises real `emptyFs`, checks
manifest identity and Node boundaries, swaps captured bindings, and runs shared
admission/cancellation/disposal cases through both policies. Ordinary tests never
import the native SDK.

The real SDK test creates a text session, saves a synthetic empty protobuf
checkpoint through the SDK's real store, and reopens it through fresh store and
platform instances. Repeated resumes retain empty registries and the supplied
controls. This proves disk persistence/reopen behavior without inference. The
ownership harness is an example boundary, not evidence that Crew implements it.
It is not a real provider transcript, OS process restart, or live context audit.

Required local commands, in order, are `npm ci`, `npm run build`, `npm run lint`,
`npm run check`, `npm test`, `npm run test:native-isolated`, and
`npm run verify:package`. The package verifier includes the no-peer public
consumer and 17 independent declaration-control omission checks.

Before merge/adoption, Crew must demonstrate durable host rejection of foreign
IDs, process restart and same-policy resume with real saved state, serialized
model context without seeded definitions, and feasibility under its existing
hardened container. After pinning, Crew's full deterministic/live matrices,
replay/recovery/privacy/erasure and actual architecture checks block release.
The qualification reuse key includes payload hashes, resolved SDK dependency
closure and integrity, Node version, image digest and architecture. Any changed
member requires a fresh candidate audit. This branch does not modify Crew or
its vendor pin and does not claim those external gates have passed.


Crew source inspection at `984d0462502904a834bfb27447989ded53a11c60` found that
`src/service/cursor-turn.ts` exposes a start input with text and an event listener,
and its call supplies no agent ID. Its current one-turn path therefore does not
invoke native resume. It still imports the older generic factory from its vendor
pin. This is inspection evidence only; adopting this candidate and qualifying
its private cwd, storage and ownership remain Crew work. Any future resume path
must enforce the ownership boundary above.
