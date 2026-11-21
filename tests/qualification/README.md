# Controlled fixture qualification

Run `npm run verify:package` to execute these tests against the installed tarball.
The verifier copies the consumer tests, typed fixture helpers, and import probe into a clean installation.
`alias.mjs` runs in a separate alias installation.
The reusable scenarios and reference fake ship in `@operatorworks/switchboard/testkit`.
Import `contracts` and `createFakeFixture` from that entry. Importing it does not register tests.
Each named contract runs its group when called with a fixture factory and an `AbortSignal`.
To qualify another controlled driver, supply an immediate or asynchronous `QualificationFactory`.
The entry exports `QualificationFixture` and its connection, request, result, controls, and counter types.
The compiler checks the scenarios and the fake implementation against those declarations.
The installed consumer checks valid fixture authors and rejects missing cleanup, publish-only events, and recovery dispatch.
It runs all four groups with both immediate and asynchronous fixture acquisition.

The [fixture declarations](../../src/testkit/types.ts) define the fixture contract and ship as `dist/testkit/types.d.ts`.
The [root README](../../README.md) shows public usage.

Accepted commands do not prove a real external tool effect.
Continuation checks preserve native result, effect, and delivery as independent facts.
Tool cases cover all four effect and delivery combinations with distinct native evidence.
Every continuation submission receives a deep copy so driver mutation cannot rewrite the expected continuation.
Approval and tool checks reject wrong choices and targets, then check one-time consumption at acceptance.
Event checks use explicit callback entry, release, and exit gates instead of timing sleeps.
An observer drains a retained event after its active callback exits, with exact FIFO order and one active callback.
Input abort, overflow, and disposal detach observers immediately; active callbacks retain their observer leases until they settle.
Input abort drops queued events while other observers and accepted native work continue.
Observer failure and transport close leave accepted native work held until its completion gate is released.
Reconnect starts a fresh event stream with no replay.
Broken drivers perform a real recovery send, replace acknowledgement loss with certainty, or derive delivery from effect.
Each must fail its named contract assertion and then close every acquired connection through real fixture disposal.
A driver with an `async close()` wrapper must fail `close() must return the same promise` and dispose every acquired fixture.
A driver that ignores subscription input signals must remain blocked until bounded caller cancellation.
Its callback then settles and fixture disposal closes every acquired connection.
These tests qualify the fixture and reusable assertions, not native engines, auth routes, platforms, real protocols, or crash-durable host admission.

`host-consumers.mjs` adds private host owners checked against the installed public types.
The installed `host-consumers.consumer.mjs` schedules reconstruct a Crew-like owner from a temporary JSON file.
Its qualification imports resolve in the installed consumer layout created by the verifier.
The host writes complete native session references and separate host correlation before native entry.
Configured grants and host correlation are copied before caller mutation and execution.
Saved unknown outcomes select lookup-only recovery. Intent-only records block fresh admission.
Only `outcome-unknown` advances the journal. Accepted, conclusive, and post-intent aborted results leave blocking intent records and require investigation.
Conclusive lookups leave the saved unknown unchanged, so later calls repeat the lookup.
Malformed records, wrong bindings, and different command identities reject before backend work.
The file proves sequential reconstruction from bytes, not atomic writes, concurrent admission, or process-crash durability.

The AgentUI-like schedule overlaps two views on separate connections while an independent command owner holds work.
If `openAgentView` throws during subscription, the caller retains the connection and must close it.
Closing the old view leaves the replacement observing and the command owner available for reconciliation and replies.
Private pending approval targets, associated tool IDs, and native choices survive client mutations.
Host request IDs cannot substitute for native approval IDs. Malformed or mismatched replies never call command submission.
Single-use enforcement for replayed or overlapping replies remains with the backend.
Capability distinctions and reasons are declared presentation inputs, not reports from the fake backend.
Broken-host controls fail the shared named assertions for missing intent bytes, duplicate sends, mistaken command closes,
and invalid approval replies forwarded to command submission even when the backend rejects them.
The missing-intent control checks the intent-failed result, zero native dispatch, and temporary-directory cleanup without waiting for native entry.
These schedules do not import Crew, AgentUI, native SDKs, or providers and do not complete integrated qualification.
