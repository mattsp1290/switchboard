# Guarded Codex tests

`npm run test:codex-guarded` runs the three Codex spike suites in `tests/spikes/` under a test-hygiene guard:
`codex-account.test.mjs` (4 tests), `codex-history.test.mjs` (3) and `codex-lifecycle.test.mjs` (13).
It exists so these 20 tests cannot start or signal a contributor's processes or open network connections by accident.
It is the first step on the Codex adapter path.

```sh
npm ci
npm run test:codex-guarded
```

The command takes no arguments and installs nothing. It fails before starting any child when it gets an argument,
runs on a Node other than 24.22.3, has launcher flags, a non-empty `NODE_OPTIONS` or a `NODE_TEST_CONTEXT`,
misses a planned file, or finds an oracle test name missing from its suite source. A full run takes about 22 seconds,
most of it lifecycle's real termination deadlines. CI runs it in the `verify` job after `npm test`.
`npm test` still runs the same suites unguarded.

## How it runs

[`scripts/codex-guarded-tests.mjs`](../../scripts/codex-guarded-tests.mjs) is the only process that launches children.
For each run it starts one fresh `node` with the suite file as its entry, no `node --test` orchestrator in between,
an owned working directory, and an environment that holds only `TMPDIR`. Every run gets its own process, hook registry and module cache.

Two preloads load before the entry:

- [`tripwire.mjs`](../../scripts/support/codex-guard/tripwire.mjs) refuses every bare package specifier before resolution.
  It is independent of the guard, so a missing guard still loads no package.
- [`guard.mjs`](../../scripts/support/codex-guard/guard.mjs) replaces subprocess, other-process signals, network, socket/listener, DNS, worker,
  inspector, loader-thread and native-addon entry points with refusers, and checks each slot by identity before arming.
  Its resolve and load hooks admit only the run's exact file closure and builtin allowlist from
  [`plan.mjs`](../../scripts/support/codex-guard/plan.mjs). Query re-imports such as `discovery.mjs?cold=…` are admitted by path.
  A guest hook set with a `load` member is refused, because it could bypass final load admission.

The guard is also the run's `node:test` reporter. It writes nonce-tagged records to file descriptor 3:
arming, first loads, every refusal at the moment it happens, test events, the summary, and an exit record with its
private refusal count. Stdout and stderr belong to the suites and are kept only as bounded diagnostic tails.

## Acceptance

[`verdict.mjs`](../../scripts/support/codex-guard/verdict.mjs) is pure. A suite run passes only when:

- the guard armed first and the entry loaded first, and every closure file loaded;
- each oracle name started once and passed once, with no failure, skip, todo, nested, extra or duplicate test;
- the single summary reports exactly that many passes;
- no refusal was recorded, including one the guest caught or one after the exit record,
  and the exit record's refusal count matches the channel;
- the exit record and the process exit are both 0, with no signal, and the child is confirmed gone.

The command passes only when all three runs pass in distinct processes and their passed names equal the 20-name oracle.
A per-test inactivity deadline of 30 seconds, a per-run total, a command total, and caps on stdout, stderr,
the channel and line length kill the child with `SIGKILL`. The owned temporary root is removed only after every child is
confirmed terminated. A child that is not confirmed gone, or a failed removal, fails the command and names the retained root.

Before the suites, 20 inert controls from [`control.mjs`](../../tests/fixtures/codex-guard/control.mjs) must each fail
with exactly their expected failure codes, or pass when they should. They cover guard ordering and event identity,
missing, substituted, duplicate, failed, skipped, nested and unstarted tests, early `process.exit(0)`, a nonzero exit code,
a throwing `after()` hook, a crash, a hang, an output flood, signalling another process, caught and exit-phase refusals, builtin aliases, excluded and
short-circuited files, bare packages with and without the guard, and a sabotaged guard slot. If any control misbehaves,
the suites do not run. [`codex-guard.test.mjs`](../../tests/codex-guard.test.mjs) unit-tests the verdict rules.

## Maintenance

The file closures in `plan.mjs` are exact. When a guarded suite or product module adds or removes an import, the run fails
with `refusal: file …` or `closure-unused`, and the closure must be updated in review. A renamed test fails preflight.

## Not claimed

- No filesystem confinement. The suites keep their real owned-temporary filesystem use, and the guard never patches `fs`.
- The builtin allowlist applies to `import` and `require`. `process.getBuiltinModule` bypasses it, so a guest can still reach
  unrefused parts of other builtins (for example `vm`) that way; the denied entry points it returns are the guard's refusers.
- No protection against a hostile guest, which could forge channel records. The threat model is accidental effects.
- No SDK, native Codex or provider qualification. Nothing here exercises those paths.
- POSIX only: the channel is file descriptor 3 and termination is confirmed with `kill(pid, 0)`.
