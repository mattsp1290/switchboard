# Frontend tool restore

Status: accepted for the core contract. Bean: `switchboard-9wpi`. Supersedes the `switchboard-aa2d` gate.

## Decision

Upstream Codex will not provide a cold restore API for an original frontend tool call.
Switchboard does not pick one workaround.
Switchboard surfaces a typed restore situation for a pending frontend batch after process loss.
The importing application chooses the mechanism. Crew and AgentUI desktop or iOS may choose differently.
Switchboard owns no persistence. The application persists the batch envelope, its results, and the decision.
No policy means `defer`. Defer leaves native state untouched.

## Data shape

`src/core/frontend-restore.ts` defines the contract. The root entry exports it.

- `PendingFrontendBatch` is the envelope the application persists with the frontend stop.
  It holds the adapter, the bound `SessionReference`, the native turn ID, the process epoch, and the AG-UI source run ID.
  Its calls are in native order. Each call holds a `ToolTarget`, the public tool call ID, and argument and definition digests.
  The session reference identifies the native thread.
- Each digest is `sha256:` and the lowercase hex SHA-256 of UTF-8 bytes.
  `argumentsDigest` hashes `JSON.stringify` of the arguments value the native provider sent for that call, in the provider's key order.
  `definitionDigest` hashes `JSON.stringify` of the frontend tool definition object the application registered for that tool, as passed to the adapter.
  Switchboard checks only the format and never recomputes either digest. Every writer to one ledger must hash the same bytes, or the same batch gets different situation keys.
- `parsePendingFrontendBatch` validates a persisted envelope against the expected adapter and session.
  It rejects unknown fields, empty or oversized batches, duplicate call IDs, malformed digests, and calls bound to another session.
  A batch whose `[sourceRunId, publicToolCallIds]` JSON exceeds `frontendRestoreLimits.maxPublicIdBytes` returns `bounds-exceeded`.
- `RestoreObservation` is what an adapter reports about native state: a live original, a rejoined original, ended native work with its settled call IDs, or an unobservable state.
- `assessFrontendRestore` turns a batch and an observation into a `RestoreSituation`.
  The kinds are `warm`, `rejoinable`, `original-lost`, `already-settled`, and `indeterminate`.
  An epoch mismatch, partial native output, or an unobservable state is `indeterminate`.
- Each situation lists only the options the adapter supports for that kind. `defer` is always first.
- Each situation has a key. The key is a SHA-256 digest of the batch, the classified observation, the admission, and the options.
  The same facts produce the same key after a restart within one library version.
  A new observation or a capability change in a later version changes the key.
  A decision that names another key is `stale-situation`. Look up a stored decision by batch before running policy again.
- The epoch must be unique per native process lifetime. Only an adapter that holds the live waiter may report `live-original`.
- Every function that takes a situation re-derives it from its batch, kind, and admission.
  Options are compared field by field, so a situation persisted with reordered keys, such as Postgres `jsonb`, is accepted.
  A key or option list that does not match the re-derivation returns `tampered-situation`. That covers forgery, corruption, and a situation persisted under another capability table.
  A malformed situation returns `invalid-input`.
- Parsers of persisted values read only own data properties of plain objects and dense arrays.
  They reject accessors, custom prototypes, explicit `undefined`, and unknown fields. This covers batches, observations, situations with their options, and decisions.
- `RestoreDecision` is one of `defer`, `deliver-original`, `settle-interrupted`, `paired-repair`, `continue-new-turn`, or `redispatch`.
  Each variant has its own required fields. Every decision names its situation key and policy revision.
  `frontendRestoreDefaultRevision` is reserved for the null-policy `defer`. Any other choice under that revision is `invalid-input`.
- `validateRestoreDecision` rejects a decision for another situation key and a mechanism the situation does not offer.
- `decideFrontendRestore` runs an optional application policy. A null policy defers under `frontendRestoreDefaultRevision`.
  The policy is an in-process object, not persisted data. Any object works, including a class instance or one with extra fields.
  Switchboard reads `revision` and `decide` with ordinary property access and calls `decide` as a method, so `this` is the policy.
  An invalid `revision` or a reserved one, or a `decide` that is not a function, returns `invalid-policy` with the `field` named.
  A `decide` that throws, rejects, or returns a malformed choice returns `policy-failed`. Native state is untouched, and the application decides what to persist.
  A policy that picks an unoffered mechanism returns `mechanism-unavailable`. The application owns any timeout on `decide`.
- `compareRestoreDecisions` takes the situation, the stored decision or `null`, and the proposed decision.
  Both decisions must be admissible for the situation.
  The effect is `write` for an empty slot, `replay` for the same choice, `replace-defer` over a stored `defer`, and `defer-ignored` when a proposed `defer` meets a stored final decision.
  A different final choice is `decision-conflict`. Policy revision is not part of the comparison.
- The function is pure. The application must persist with compare-and-set against the exact stored value it passed in.

## Mechanisms and delivery classes

| Mechanism | Delivery class | Native means |
| --- | --- | --- |
| `defer` | `not-delivered` | None. |
| `deliver-original` | `original-call` | Reply to the live native waiter. |
| `settle-interrupted` | `not-delivered` | None. The application records the disposition. |
| `paired-repair` | `paired-by-id` | Codex `thread/inject_items` or `turn/start.toolOutput`; Claude resume with a `tool_result`; Pi `appendMessage` then `continue()`. |
| `continue-new-turn` | `unpaired-input` | A new user turn that carries the recorded result. |
| `redispatch` | `not-delivered` | A new frontend execution generation. |

Only `deliver-original` claims `original-call`. No cold situation offers it.
Codex `turn/start.toolOutput` has no call ID. Qualification must prove pairing before it can carry `paired-by-id`.

## Capability tables

`frontendRestoreCapabilities` uses the core `Capability` type for each adapter and mechanism.

| Mechanism | Codex | Claude | Pi |
| --- | --- | --- | --- |
| `defer` | supported, native-free | supported, native-free | supported, native-free |
| `settle-interrupted` | supported, native-free | supported, native-free | supported, native-free |
| `deliver-original` | supported, fixture-only, warm only | unavailable | unavailable |
| `paired-repair` | unavailable | unavailable | unavailable |
| `continue-new-turn` | unavailable | unavailable | unavailable |
| `redispatch` | unavailable | unavailable | unavailable |

Native-free mechanisms perform no native call. They need no native qualification.
Fixture-only means a diagnostic fixture observed the behavior. It is not production-qualified.
Assessment takes a required admission. `production` hides fixture-only options. `fixture` shows them with their label.
`settle-interrupted` applies to `warm`, `rejoinable`, and `original-lost`.
Settling a `warm` batch does not release the native waiter. The application cancels the native turn separately if it wants that.
`already-settled` and `indeterminate` offer only `defer`. Settling them could misreport native output that already exists.

## AG-UI projection

`frontendRestoreFact` builds a versioned CUSTOM fact for the existing `./agui` mapper.
The namespace is `switchboard.frontend-restore`. The schema version is `1`. The name is `frontend-restore`.
The payload phase is `required` or `decided`. Each phase has its own required fields.
The payload carries the source run ID, the public tool call IDs, the situation kind and key, and the offered or chosen mechanism.
Each mechanism carries its `deliveryClass` and `qualification`, the same `RestoreOption` shape the situation lists.
`decided` records intent. Its `deliveryClass` is what the mechanism can achieve, not a delivery result.
A future executed phase will report actual delivery.
A `decided` fact for `defer` may be followed by one later `decided` fact for the same situation key, the `replace-defer` effect. Any other `decided` fact is final.
Parsing bounds the batch, so every fact payload is at most `frontendRestoreLimits.maxFactBytes` (65536) UTF-8 bytes.
A projection with `maxPayloadBytes` of `maxFactBytes` plus 1024 and `maxJsonNodes` of `maxCalls` plus 64 accepts every fact. The AG-UI test checks both bounds.
It carries no native IDs, session envelope, epoch, arguments, or results.
The fact is never a terminal. A finished source run rejects it. The host emits it on a separate recovery run.

## Follow-up qualification

- Fake app-server crash-point tests for the Codex observation and executor.
- Real-binary qualification of paired repair: the next provider input holds exactly one output for the original call ID, and client effects do not repeat.
- Custody qualification before `rejoinable` can offer `deliver-original`.
- Production qualification of Codex warm `deliver-original`.
- Claude and Pi frontend callbacks and their evidence.
- Executors for `continue-new-turn` and `redispatch` through `createDispatchOperation`.
