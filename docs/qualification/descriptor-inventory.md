# Descriptor inventory qualification

On 2026-11-14, the frozen switchboard-xp2c repair passed its finite native descriptor controls on Lunus macOS with Linux AArch64 Docker.
This qualifies the captured descriptor error handling only. Overall pathname stability remains `INCONCLUSIVE`.
This exact-source evidence supersedes the FD section's SOURCE ONLY, UNRUN, missing-hash, and pending-native-qualification statements in the observer README for the hashes below.

The repair clears errno before each readdir, preserves the terminating errno through one closedir, and refuses through the existing target cleanup owner.
The pinned Zig 0.17.0 musl readdir leaves errno unchanged when getdents returns -ENOENT, so a vanished /proc task appears as clean EOF after the caller clears errno.
This behavior is established by local source inspection of `/opt/homebrew/Cellar/zig/0.17.0/lib/zig/libc/musl/src/dirent/readdir.c` on Lunus.
The inspected source has SHA256 `e3f239d10c9305f61949f8f70b0ff138f6d9eef19e43a89889380f3fcb6ed743` and is retained in `~/.codex/orchestrate/switchboard-epic/fd-pinned-musl-readdir.txt`.
That inspection establishes the pinned source behavior only. It does not establish an observed native ENOENT case.
That case relies on the later stdio and ptrace refusals rather than the descriptor read-error refusal.
Both raw and prerequisite helper modes ran each of these eight controls, for sixteen cases, each launched by docker exec into a live hold container.

| Control | Captured behavior |
| --- | --- |
| normal-first | EIO before the first entry refuses before target work. |
| normal-stdio | EIO after real descriptors 0, 1, and 2 refuses. |
| inherited-before9 | EINTR after real stdio, before natural FD 9, refuses. |
| inherited-after9 | EBADF after the actual outside FD 9 refuses. |
| normal-open | Stale EIO after successful open reaches clean EOF and completes. |
| normal-entry | Stale EIO after successful entries reaches clean EOF and completes. |
| inherited-open | Stale open errno reaches clean EOF, then rejects the actual outside FD 9. |
| inherited-entry | Stale entry errno reaches clean EOF, then rejects the actual outside FD 9. |

Close contamination includes zero and EACCES. Every case closes once and preserves the read outcome.
Refusals record successful target SIGKILL and matched terminal waitpid. Prerequisite read errors also record the supervisor fallback operation and exit 90 without a root receipt.
Clean normal controls complete their original syscall recipe. Inherited clean controls kill and reap before rejection.
The instrumented inventory binary `3a1b4a84` resolves native_io kill and waitpid pointers to their linker wrappers. Each wrapper branches to the real libc operation.
The unchanged nine raw modes run first on that instrumented binary with no selector set, in order normal, inherited, bad-root, info-short, query-bad, query-short, registration, deadline, and death.
The uninstrumented prerequisite binary `8f732188` ran only the notice controls and normal, inherited, and death. Its overall status remains `INCONCLUSIVE`.
No uninstrumented current-source run_admission.py execution is retained. Its raw admission and raw-target instruction inspection were not executed at this source.
Both runs pass all 165 native notice controls. The instrumented binary retains all 36 raw-target instructions and the six expected syscall sites.
The clean macOS Python 3.13.12 host log reports 56 passing discovered executions, 49 defined methods plus 7 imported repeats. This inspection executed no candidate code.
The retained local host run has three failures in unchanged short-deadline capture tests. Their cause is unproven. The current main fault test covers twenty success and fault schedules.
Live inventories retain only init and the hold or supervisor process. Raw death includes init's matched target-reaping log. Prerequisite death establishes reaping by orphan disappearance only.
All case streams have EOF, byte counts, and hash bindings in the 349-command ledgers. Final cleanup reports contain no owned resources or errors.
Independent final inspection records absence of all fourteen unique containers and both scratch images.

Current evidence is `~/.codex/orchestrate/switchboard-epic/fd-native-v4-evidence/` and sibling archive `fd-native-v4-evidence.tar`. The v3 artifacts remain historical.
Archive SHA256 is `92ee3f048c8e363d5f5e444a87c4f25d7d64ccc78bed8b639dbf3983ba6f5fa0`, 24,207,360 bytes and 233 verified regular file members.
The 21-file source manifest `source-manifest.json` has SHA256 `b0cf8a9886ac3f96accb3710f1b3c5ff9b44488c8c040f0da286dc43322429d2`.
The helper, shim, and driver source SHA256 values are `3891e8c10341e58896219380ca74c68d8810e69a7b06e8f53a788efc33dc7f10`, `742d63451ac9f59543316e7ac1c76af0c041e873d59abe617c54d8a5787e7bf4`, and `42ef209c621dd42d910f0432317efe71983fbc4b7f49ffb2a6836df587d1dd0a`.
The source is `c7e12ccf983b3ec8f8b6911d834082fdc2a38a20` plus the six approved owner-refactor postimages. Run IDs are prerequisite `1794693887605534000` and inventory `1794693912735137000`.
`run.main(raw, compile_args)` returns the suite result. `execute(raw, suite, finalize)` owns cleanup, final hashes, the single finalizer, and atomic publication through `result.pending`.
The owner refactor migrated the original cleanup, finalization, and notice fault oracles in `test_cleanup.py`, `test_finalization.py`, and `test_notices.py` to drive the actual `execute` with the returned-result contract.
This supersedes the observer README statement that the original 48 host tests remain unchanged.
Prerequisite and instrumented binary SHA256 values are `8f7321887dccd8b2321e96ab92bf764f7ba9a5fd1b3bdcf8ded2f72bb39608a1` and `3a1b4a84ba90d2c2187b27c6b0f3fd3f1f9a15413bf4a74e19fdf501b6225de1`.
Prerequisite and inventory command-ledger SHA256 values are `c9aa1b9edd46dc01b7e0c0b54b9ff3e64c51626c9e055a83bee0bb57699c3e69` and `471404ccb6863fdcedf35f3b8f18908ab60d433d1a2afa6b0522181cacca201f`.
Their result SHA256 values are `f09dcd791d70c512ca01265e7112ad8ca49e76e813518a635091d3a84607d08e` and `79ea77b910fb209f55cae0cc0d98d21dfbd96b2dbb80a468da9d5902ff0cfbc3`.
Both cleanup reports hash to `35378ab045c42033478c9e26f6467c90c5b15018f61cd8aa7bbc0f5a90e83298`. Independent absence receipts hash to `2c3d4c02d7bf362872c50d2c12eca9e57755161cabbcdc68f15b75fb91bf822d`.
The original RED evidence `recovered-xp2c/raw-normal.evidence` hashes to `cce49b405e8e58c6121f0e816d4713e70e47b4f3839caf855dc6c00d1386c0c6` and shows injected EIO followed by raw admission and seven target bytes.
That historical baseline establishes the helper lineage. It does not qualify the refactored owner, spontaneous kernel failure, or concealed FD 9.

The admitted commands use Python 3.13.12 with `-B`, first `spikes/native-observer/stability/run.py`, then `spikes/native-observer/stability/repro_fd_inventory_eio.py`.
Host pins are Docker client 29.5.2, server 29.2.1 commit 6bc6209, Linux 6.8.0-100-generic, Zig 0.17.0, runc 1.3.4, and docker-init 0.19.0 commit de40ad0.
Docker, Zig, and llvm-objdump executable SHA256 pins are `d79e988b423edbe34460a2e4d86ecc841997f16c5e2a2ee5263f679d0c483a84`, `9fb480d3398506f5e2bef77f175766a8de0ee191dbdfbfb0c117a1150f141c91`, and `1dcc1432db4d828cf8cd71a84cb8d9bf63a7ca80b5eeec711a9e5f13a3f5f98e`.
Executed init SHA256 is `d286e5df628bc2ceafe66dfb82e57fdf6ff66995a1cad073c9347e9bccc3dfb1`. The inspected base image is `node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`.
The host tools are pinned by the admitted executor and source checks. Their executable bytes are not in the retained archive.
Both v4 binaries differ from v3 by whole-file SHA256 for an unproven reason. Fresh ELF inspection verifies all seven native_io pointers, six wrapper real-operation branches, and 36 raw-target instruction words.

Full stability, thread and CLONE_VM families, all 72 birth cases, full lifetime and epochs, authority, checked releases, imports, Node compatibility, native SDKs, adapters, providers, and consumer live gates remain unqualified.
Review gauntlet, current-head CI, and final independent approval remain required before merge. This evidence inspection grants no merge approval.
