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
