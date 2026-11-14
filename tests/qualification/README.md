# Controlled fixture qualification

Run `npm run verify:package` to execute these tests against the installed tarball.
The verifier copies this directory into a clean consumer. These files are not shipped.
`contracts` registers the uncertainty, sessions, interaction, and events groups through one factory argument.
To qualify another controlled driver, supply an immediate or asynchronous factory with the same methods.

The factory returns immutable `samples`, `connect(recordIntent)`, `controls`, and idempotent `dispose()`.
Each connection exposes `identity`, subscribe-only `events`, `submit(request, signal)`, `recover(saved)`, and `close()`.
Requests contain `session`, `hostOperationId`, and an optional `continuation`. Recovery exposes only `reconcile(signal)`.
The retained backend owns accepted records, pending interactions, and session reservations until native completion.
The simulated host owns fixed grants and in-memory command admission across reconnects.
Completion gates expose `entered`, `release()`, and `completed`; connection close does not release native work.
Counters distinguish dispatch attempts, accepted fixture commands, native lookups, and transport closes.
Accepted commands do not prove a real external tool effect.
Continuation checks preserve native result, effect, and delivery as independent facts.
Tool cases cover all four effect and delivery combinations with distinct native evidence.
Every continuation submission receives a deep copy so driver mutation cannot rewrite the expected continuation.
Pending approval choices and tool targets must match exactly and are consumed once at acceptance.
Event checks use explicit callback entry, release, and exit gates instead of timing sleeps.
An observer drains a retained event after its active callback exits, with exact FIFO order and one active callback.
Input abort, overflow, and disposal detach observers immediately; active callbacks retain their observer leases until they settle.
Input abort drops queued events while other observers and accepted native work continue.
Observer failure and transport close leave accepted native work held until its completion gate is released.
Reconnect starts a fresh event stream with no replay.
Broken drivers perform a real recovery send, replace acknowledgement loss with certainty, or derive delivery from effect.
Each must fail its named contract assertion and then close every acquired connection through real fixture disposal.
A driver that ignores subscription input signals must remain blocked until bounded caller cancellation.
Its callback then settles and fixture disposal closes every acquired connection.
These tests qualify the fixture and reusable assertions, not native engines, auth routes, platforms, real protocols, or crash-durable host admission.

`host-consumers.mjs` adds private host owners checked against the installed public types.
The installed `host-consumers.consumer.mjs` schedules reconstruct a Crew-like owner from a temporary JSON file.
Its qualification imports resolve in the installed consumer layout created by the verifier.
The host writes complete native session references and separate host correlation before native entry.
Configured grants and host correlation are copied before caller mutation and execution.
Saved unknown outcomes select lookup-only recovery. Intent-only records block fresh admission.
Malformed records, wrong bindings, and different command identities reject before backend work.
The file proves sequential reconstruction from bytes, not atomic writes, concurrent admission, or process-crash durability.

The AgentUI-like schedule overlaps two views on separate connections while an independent command owner holds work.
Closing the old view leaves the replacement observing and the command owner available for reconciliation and replies.
Private pending approval targets, associated tool IDs, and native choices survive client mutations.
Host request IDs cannot substitute for native approval IDs, and invalid replies never call command submission.
Capability distinctions and reasons are declared presentation inputs, not reports from the fake backend.
Broken-host controls fail the shared named assertions for missing intent bytes, duplicate sends, mistaken command closes,
and invalid approval replies forwarded to command submission even when the backend rejects them.
The missing-intent control checks the intent-failed result, zero native dispatch, and temporary-directory cleanup without waiting for native entry.
These schedules do not import Crew, AgentUI, native SDKs, or providers and do not complete integrated qualification.
