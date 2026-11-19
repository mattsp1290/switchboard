# Native import isolation

Switchboard's tests that import a native SDK run only under `npm run test:native-isolated`.
The ordinary `npm test` loads no native SDK.
This gate is the isolated-import gate of `switchboard-j3r0`, as re-scoped by the owner decision of 2026-11-18.
It replaces the ptrace observer chain on the adapters' path.

## What runs where

`npm test` preloads `tests/support/native-sdk-tripwire.mjs` into every test process.
Loading any module from `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `@openai/codex-sdk`, `@openai/codex`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core` or `@modelcontextprotocol/sdk` fails that load and sets a failing exit code, so a caught error still fails the file.
`tests/native-sdk-tripwire.test.mjs` checks that the tripwire is present and that it trips.

The SDK-importing suites live in `tests/native-isolated/` with the suffix `.native.mjs`, which the `npm test` glob does not match.
They import the packed package by name (`@mattsp1290/switchboard/claude`, `/codex` and `/pi`), not the adapter sources.
`tests/package.test.mjs` still runs the packed-package consumer check.
While the tripwire is loaded, that check skips the Pi and Codex consumers that execute native SDKs.
`npm run verify:package` runs those consumers, and CI runs it as its own step.

## The gate

`scripts/isolated-native-tests.mjs` builds, packs and stages, then runs each entry in a fresh container.

- Image `node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54` (Node 24.22.3, Debian 12), pulled before any run and never during one.
- `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, user 65534, 512 processes, 2 GiB of memory, and Docker's default seccomp profile, which denies `io_uring_setup` with EPERM.
- A writable `/tmp` tmpfs with `noexec`. Nothing else is writable.
- Three read-only mounts. `/stage` holds the packed tarball installed as `node_modules/@mattsp1290/switchboard`, the installed closure of the SDK packages (`dependencies`, plus `optionalDependencies` and `peerDependencies` where installed), the suites, the three controls and the three fixtures they launch. A macOS install omits the Linux platform packages. The gate downloads each omitted optional package the pinned Debian image can load (linux, the container CPU, and glibc when the package selects a libc), checks the lockfile's sha512 integrity, and stages it. `/home/switchboard-decoy` holds decoy files. `/opt/strace` holds strace.
- The traced command's environment is only `PATH`, `TMPDIR=/tmp` and `HOME=/home/switchboard-decoy`. No SDK home variable is set, so each SDK's default lookup lands on a decoy.
- Decoys sit at `.claude.json`, `.claude/.credentials.json`, `.codex/auth.json`, `.pi/agent/auth.json`, `.aws/credentials`, `.config/gcloud/application_default_credentials.json` and `.netrc`. Each holds a fixed marker line and no credential.
- strace 6.1-0.1 from Debian bookworm, checked by package and executable SHA-256 for arm64 and amd64, runs `strace -f -q -y -s 4096 -e trace=%file,%network,%process,io_uring_setup` around Node. The trace leaves on a descriptor separate from the program's output. The arm64 binary links only to libc. The amd64 binary also needs libunwind8 1.6.2-3, which bookworm-slim does not contain. That package is pinned by its SHA-256, extracted beside strace, and checked at the three libraries strace loads. `LD_LIBRARY_PATH` points strace at them, and `strace -E LD_LIBRARY_PATH` removes that variable before the traced command starts.

`scripts/support/isolated-native/verdict.mjs` reads the trace line by line. A run fails, whatever its exit status, on any of these records:

- `decoy`: any record that names a path under the decoy home, including stats, directory changes and descriptor paths shown by `-y`.
- `network`: any `socket`, `connect`, `bind`, `listen`, `accept` or `accept4` call, whatever its result, or a send call with a destination address. `socketpair` is allowed because Node uses it for child stdio.
- `launch`: an `execve` the kernel accepted, or whose result is missing, of anything other than Node running an admitted script or inline code, the Codex CLI fixture, or the pinned Codex binary from the staged platform package. Any `execveat` fails. An `execve` the kernel refused launched nothing and is counted, not failed. The Codex suite probes missing and non-executable paths on purpose.
- `io_uring`: a successful `io_uring_setup`, because io_uring I/O would bypass the trace. Docker's default seccomp denies the call with EPERM, and that denial is not a violation.
- `trace`: an empty or unparsed trace, a truncated `execve` argument, a first record other than the entry's own `execve`, a process with no end record, an entry that did not exit 0, any `strace:` diagnostic, or a run past its five-minute deadline.

A suite passes only when its trace has no violation, it exits 0, and its TAP summary reports at least one pass and no failures.

## Controls

Before the suites run, three controls run through the same gate. Each exits 0, and each must fail for exactly its own reason, or the command fails.

| Control | Action | Required verdict |
| --- | --- | --- |
| `controls/decoy-read.mjs` | Reads `~/.codex/auth.json` and swallows the result | `decoy` only |
| `controls/network.mjs` | Opens a TCP connection to `192.0.2.1:443` and swallows the failure | `network` only |
| `controls/launch.mjs` | Runs `/bin/true` | `launch` only |

## Measured run

On 2026-11-18 on Docker Desktop for macOS (Linux arm64), the command took 85 seconds, including build, staging, and the two platform packages the macOS install omitted.
Each control exited 0 and was rejected for its own reason.
The suites passed with no violations: Claude runtime 22 of 22, Codex SDK chat 21 of 21, and Pi runtime 23 of 23.
The CI job's 15-minute limit allows for install, the image pull, and x64.

## Limits

- The gate observes system calls through ptrace. A thread that rewrites its own system-call arguments after strace has read them can make the trace disagree with what the kernel did. The gate does not defend against this.
- Detection is by path. A file reached through a descriptor that was opened outside the trace, or passed over a socket, is not attributed to a decoy. The container starts with no descriptor open to a decoy beyond inherited fds.
- The traced program shares its user with strace and inherits the trace descriptor. It can append lines to the trace, but it cannot remove lines already written.
- Reads outside the decoy home are allowed. The root is read-only, the image holds no credentials, and only the staged tree is mounted. The gate does not claim a general read allowlist.
- Network enforcement is the empty network namespace. Loopback exists, and any attempt to use it is still a `network` violation.
- The suites use synthetic fixtures and fetch stubs. This gate proves confinement of imports and fixture runs, not native engine behaviour against a model.
