# Pathname stability prerequisite

Run `python3 spikes/native-observer/stability/run.py` from this checkout.
The command retains exact commands, raw outputs, source and executable hashes, inventories, and results below `local/`.
It requires the recorded local Docker socket and pinned Docker, Zig, image, kernel, runc, and actual init executable identities.
It builds a static AArch64 musl probe and synthetic scratch image. No Node program or SDK is loaded.

The final run observed all three prerequisites. Overall pathname stability remains `INCONCLUSIVE`.
Normal mode traces after both processes reach UID/GID 65534, with no supplementary groups or active capabilities.
A readiness pipe enforces credential ordering. The tracer is nondumpable, and no-new-privileges remains set.
The tracer independently checks target root, cwd, and every inherited FD, including exclusion of its evidence pipe.
It reads pathname memory at syscall entry and checks actual returned-FD identity and contents at syscall exit.
The target's separate raw output must equal `allowed\n`.
Inherited mode deliberately preserves `/outside/sentinel` on FD 9 and rejects it before target work.
Death mode actually kills the tracer with SIGKILL. EXITKILL terminates the stopped target.
A separate supervisor independently checks target disappearance before the container is removed.
The supervisor is nonroot, is not a subreaper, and uses default SIGCHLD without SA_NOCLDWAIT.
The host observes only the live init and supervisor, with no target survivor or zombie.
Init adoption and reaping are inferred from orphan disappearance under these conditions; no init wait syscall was instrumented.
The inspector exports bounded actual `/proc/1/exe` bytes for host hashing. Docker cp saw only an empty mount placeholder.
Every case compares the executed init against its pinned hash, waits for container exit, removes it, and verifies absence.
The runner registers a unique run/mode name before create and records timed-out argv and partial output.
Cleanup makes up to three removal attempts and requires the pinned CLI's exact absent-object response.
An uncertain create or build never acknowledged, observed or removed remains owned in `cleanup.json` after bounded reconciliation.
Run `python3 spikes/native-observer/stability/test_cleanup.py` for nine inert container/image timeout and daemon-failure cases.

The profile remains default-deny with the existing capabilities, network-none, read-only root, and resource limits.
Its added `fstatfs`, `statx`, and `futex` calls are runtime launch prerequisites, demonstrated by recorded failures and a trusted `/bin/true` control.
The pinned runc applies seccomp before its procfs FIFO reopen, which uses [filesystem and mount identity checks](https://github.com/cyphar/filepath-securejoin/tree/v0.5.2/pathrs-lite/internal).
The actual runc failure stack then identified its Go runtime futex wake. No privilege expansion was required.

This prerequisite does not implement shared-thread or separate CLONE_VM epochs, stale/stable controls, failed-path controls, paired outside worlds, or the full fault suite.
Static musl does not establish the later freestanding fixture's kernel-writer exclusion.
All ten mechanism-judgment corrections still govern the later complete proof. Full stability, Node compatibility, SDK imports, and Unit B remain open.

## Single raw target admission

Run `python3 spikes/native-observer/stability/run_admission.py` to rerun the bounded admission suite.
The retained run passed all nine native controls after independent source, instruction, ledger, and inert-test verification.
The original result above is historical evidence. A fresh `run.py` execution on this source passed its three controls at `local/1794630610575412000`.
The second caller uses `run.execute(raw=True)` and the same container/image owner, compiler, root inventory, identity pins, and finalizer.
The C driver shares the trusted child setup, admission, and supervisor. Named `raw_target` and `raw_trace` functions own the new fixed recipe.
No source is textually included, and no second launcher or task ledger is introduced.

The raw body clears `clear_child_tid` with `set_tid_address(NULL)`, reaches `getpid`, writes seven separate target bytes, and exits with `SYS_exit`.
The tracer requires the clearing entry and matching successful return before querying absent robust-list and rseq registrations under final identity.
The AArch64 robust-list head and rseq configuration structures are each 24 bytes. Unsupported, malformed, or short queries prevent admission.
Registration alone would not prove overlap. This suite clears and checks absence, then rejects every syscall outside the fixed recipe before execution.
An executable inspection pins the local objdump, retains all raw-body instructions, and rejects calls, returns, unexpected syscalls, or branches outside that body.
The admitted output buffer is immutable executable data. The blocked-read destination is separately inventoried private writable storage.
The trusted bootstrap uses static musl. The admitted recipe after clearing has no libc, pthread, compiler-helper, mapping, registration, signal, or process-memory call.
The compiled registration site is a negative control rejected at entry.
Every inherited descriptor is checked. The ordinary input is `/dev/null`; the deadline case instead admits the exact synthetic pipe created by its supervisor.
The supervisor holds that pipe's idle writer, the target holds its reader as FD 0, and neither tracer nor target holds the writer.
Target stdout and stderr share a separate bounded pipe. Only the supervisor frames its bytes into evidence; the target cannot write tracer or init evidence.

The fixed controls are normal, injected outside FD 9, malformed cwd, short syscall-info, malformed robust query, short rseq query, rejected registration, blocked-read deadline, and actual tracer death.
The deadline case requires the actual blocked read from `/proc/<pid>/syscall`, a monotonic native timeout, killing and reaping, and independent disappearance.
The death case kills the admitted tracer with SIGKILL. EXITKILL must terminate the target, and the pinned verbose init must name that target in an actual waitpid reaping log.
Every case retains a process inventory while init remains alive, then waits for init exit and retains complete flushed init records separately from target bytes.
Ordinary failures retain their actual wait status. Missing cleanup evidence or unresolved external ownership forces `INCONCLUSIVE`.
The retained run yielded `SUPPORTED_SINGLE_TARGET_ADMISSION`; pathname stability remains `INCONCLUSIVE`.
`ADMISSION_RESULT.json` records the run and evidence hashes. The death log names the actual orphan target in the pinned init waitpid reaping record.
All nine cases retained live-init inventories; independent post-run inspection confirmed ten containers and the scratch image absent.
Run `python3 spikes/native-observer/stability/test_admission.py` for the original nine ownership cases plus import, shared-caller, evidence-loss, and delayed-init-flush checks.
These transport/evidence mocks are not native kernel observations. The policy adds only `get_robust_list` and `clock_gettime`; capabilities remain unchanged.

Complete family custody still owes both exact sharing forms, four-way creation reconciliation, provisional stops, options, incarnations, and missing/duplicate/terminal/tracer-death faults.
Complete epochs still owe stale and stable returned-FD/content controls, live mutation, both outside worlds, absent absolute names, admitted dirfd/symlink spelling, malformed context, omitted peers, real signals/restarts, and independent complete cleanup.
All task/FD lifecycle, exec, descriptor transfer, pidfd, mappings, external writers, namespace changes, and peer-dependent blocking obligations remain open.
The full ftwo result requires the current complete family and epoch suites. j3r0, Unit B, Node compatibility, and installed SDK imports remain unqualified.
Separate enforced OS/Node preflights, readable/existence sentinels, caught-attempt rejection, outside writes, every network form, native execution, second Node, fork, execve/execveat, exact loader negatives, and cleanup remain required.
The accepted strict core/native compiler policies, full public SDK types/options/handles, installed consumers, SDK-free host declaration closure, exact negative diagnostics, dependency provenance, and restored positives remain required.
All three engines, direct/LiteLLM modes, selection/history/external-writer admission, discovery/resume, no-blind-retry, host durability/authorization, route enforcement, credential renewal, cancellation, and live adapter journeys keep their gates.
