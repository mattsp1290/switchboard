# Controlled fixture qualification

Run `npm run verify:package` to execute these tests against the installed tarball.
The verifier copies this directory into a clean consumer. These files are not shipped.
`contracts` registers the uncertainty and sessions groups through one factory argument.
To qualify another controlled driver, supply an immediate or asynchronous factory with the same methods.

The factory returns immutable `samples`, `connect(recordIntent)`, `controls`, and idempotent `dispose()`.
Each connection exposes `identity`, subscribe-only `events`, `submit(request, signal)`, `recover(saved)`, and `close()`.
Requests contain `session`, `hostOperationId`, and an optional `continuation`. Recovery exposes only `reconcile(signal)`.
The retained backend owns accepted records, pending interactions, and session reservations until native completion.
The simulated host owns fixed grants and in-memory command admission across reconnects.
Completion gates expose `entered`, `release()`, and `completed`; connection close does not release native work.
Counters distinguish dispatch attempts, accepted fixture commands, native lookups, and transport closes.
Accepted commands do not prove a real external tool effect.
These tests qualify the fixture and reusable assertions, not native engines, auth routes, platforms, real protocols, or crash-durable host admission.
