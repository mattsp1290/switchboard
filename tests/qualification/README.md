# Controlled fixture qualification

Run `npm run verify:package` to execute these tests against the installed tarball.
The verifier copies the consumer tests, typed fixture helpers, and import probe into a clean installation.
`alias.mjs` runs in a separate alias installation.
The reusable scenarios and reference fake ship in `@mattsp1290/switchboard/testkit`.
Import `contracts` and `createFakeFixture` from that entry. Importing it does not register tests.
Each named contract runs its group when called with a fixture factory and an `AbortSignal`.
To qualify another controlled driver, supply an immediate or asynchronous `QualificationFactory`.
The entry exports `QualificationFixture` and its connection, request, result, controls, and counter types.
The compiler checks the scenarios and the fake implementation against those declarations.
The installed consumer checks valid fixture authors and rejects missing cleanup, publish-only events, and recovery dispatch.
It runs all four groups with both immediate and asynchronous fixture acquisition.

The JSDoc in [`src/testkit/types.ts`](../../src/testkit/types.ts) is the authoritative fixture contract.
It ships in `dist/testkit/types.d.ts`; the [root README](../../README.md) summarizes it for installed consumers.

- Samples `a` and `b` share one binding and differ only in `opaque`; approval and tool samples target `a`.
  Approval choices are nonempty.
- Every `close()` call returns the identical Promise and shares one settled outcome object.
  Close ends observers with `closed`; later subscriptions and submits return error `closed`.
  Reconciliation after close returns `lookup-failed` without incrementing `lookupCalls`.
  Each connection increments `transportCloses` once, without completing native work.
- Acknowledgement and authoritative lookup evidence carry the same non-null `nativeOperation` receipt.
  The observation namespace matches the receipt namespace, and its `schemaVersion` is `1`.
- `counts()` returns a fresh plain object with exactly the four declared counter keys, initially zero and shared across connections.
- The caller's signal bounds scenario waits. Acquisition receives no signal and must settle independently.
  Cleanup waits for acquisition, callback exits, gate completion after `release()`, and `dispose()`.
  None of these cleanup waits is bounded by the signal. Gates and disposal must settle.

The retained backend owns accepted records, pending interactions, and session reservations until native completion.
Reservations are shared across connections; overlapping work on one session returns `busy`.
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
A driver with an `async close()` wrapper must fail `close() must return the same promise` and dispose all three acquired fixtures.
A driver that ignores subscription input signals must remain blocked until bounded caller cancellation.
Its callback then settles and fixture disposal closes every acquired connection.
These tests qualify the fixture and reusable assertions, not native engines, auth routes, platforms, real protocols, or crash-durable host admission.
