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
An uncertain create never observed or removed remains owned in `cleanup.json`, alongside any unresolved image.
Run `python3 spikes/native-observer/stability/test_cleanup.py` for inert create/remove timeout and daemon-failure regressions.

The profile remains default-deny with the existing capabilities, network-none, read-only root, and resource limits.
Its added `fstatfs`, `statx`, and `futex` calls are runtime launch prerequisites, demonstrated by recorded failures and a trusted `/bin/true` control.
The pinned runc applies seccomp before its procfs FIFO reopen, which uses [filesystem and mount identity checks](https://github.com/cyphar/filepath-securejoin/tree/v0.5.2/pathrs-lite/internal).
The actual runc failure stack then identified its Go runtime futex wake. No privilege expansion was required.

This prerequisite does not implement shared-thread or separate CLONE_VM epochs, stale/stable controls, failed-path controls, paired outside worlds, or the full fault suite.
Static musl does not establish the later freestanding fixture's kernel-writer exclusion.
All ten mechanism-judgment corrections still govern the later complete proof. Full stability, Node compatibility, SDK imports, and Unit B remain open.
