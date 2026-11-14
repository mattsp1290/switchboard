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
