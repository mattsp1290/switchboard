# Descriptor inventory qualification

On 2026-11-14, the frozen switchboard-xp2c repair passed its finite native descriptor controls on Lunus macOS with Linux AArch64 Docker.
This qualifies the captured descriptor error handling only. Overall pathname stability remains `INCONCLUSIVE`.
This exact-source evidence supersedes the earlier SOURCE ONLY and UNRUN statement in the observer README for the hashes below.

The repair clears errno before each readdir, preserves the terminating errno through one closedir, and refuses through the existing target cleanup owner.
Both raw and prerequisite callers ran each of these eight controls, for sixteen cases.

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
The actual binary resolves native_io kill and waitpid pointers to their linker wrappers. Each wrapper branches to the real libc operation.
The unchanged nine raw modes run first, in order normal, inherited, bad-root, info-short, query-bad, query-short, registration, deadline, and death.
The separate current-source prerequisite run observes normal, inherited, and death. Its overall status remains `INCONCLUSIVE`.
Both runs pass all 165 native notice controls. The instrumented binary retains all 36 raw-target instructions and the six expected syscall sites.
The retained host log reports 56 passing standard-library tests. This independent inspection did not execute candidate code.
Live inventories retain only init and the hold or supervisor process. Raw death includes init's matched target-reaping log. Prerequisite death establishes reaping by orphan disappearance only.
All case streams have EOF, byte counts, and hash bindings in the 345-command ledgers. Final cleanup reports contain no owned resources or errors.
Independent final inspection records absence of all fourteen unique containers and both scratch images.

Evidence is retained under `~/.codex/orchestrate/switchboard-epic/fd-native-v3-evidence/`, with the sibling archive `fd-native-v3-evidence.tar`.
Archive SHA256 is `b280378d32b77860d298d0a6ff3aa04daf7f52b018b82b094a33b5814b9f131c`, 24,176,640 bytes and 232 verified file members.
The 21-file source manifest `source-manifest.json` has SHA256 `93caa79dddb61e9c9423153ed6a6e9730b6fd52dc401b12b9b02617b86267c3c`.
The helper, shim, and driver source SHA256 values are `3891e8c10341e58896219380ca74c68d8810e69a7b06e8f53a788efc33dc7f10`, `742d63451ac9f59543316e7ac1c76af0c041e873d59abe617c54d8a5787e7bf4`, and `e961b43b4365406a0a5e0031fcfb74d183c07a137929a2a9237b3cece13d351d`.
The preserved source base is `1b4730f9dd53e77cc1c9b8bb62f0f7dfbfda96e8`. Run IDs are prerequisite `1794687947550194000` and inventory `1794688001793541000`.
Prerequisite and instrumented binary SHA256 values are `ceceda0fd8c368de7a22abcaa4d5e4c65326749b88d11c486d142ac1c3e804c1` and `e74d42f7e611995f87892d844472b250f4dbf7be29d2fc6840e2fef9a7659df7`.
Prerequisite and inventory command-ledger SHA256 values are `899182a247cb001edc56aa085ac90dccb6d42ba620a303152019ad25c011b254` and `74cbf72923dcfb5e8fa6d7a0e1e58054387c6066e4b3d9a1d0641f0ddda4b0e6`.
Their result SHA256 values are `c3873886f34aca741137994f49a442dcba2bc90c3fbdd875591b775e706682aa` and `51108afca175dbd65d2e1046f08ec8b78ecc2008260b32ff862fce6265454e73`.
Both cleanup reports hash to `35378ab045c42033478c9e26f6467c90c5b15018f61cd8aa7bbc0f5a90e83298`. Independent absence receipts hash to `66784cb4cc647db329b42ded13851422c6d5c4e328f3954d907a536475b0912d`.
The original RED evidence `recovered-xp2c/raw-normal.evidence` hashes to `cce49b405e8e58c6121f0e816d4713e70e47b4f3839caf855dc6c00d1386c0c6` and shows injected EIO followed by raw admission and seven target bytes.
That baseline used the same helper lineage and shared resource owner. It does not establish spontaneous kernel failure or concealed FD 9.

The admitted commands use Python 3.13.12 with `-B`, first `spikes/native-observer/stability/run.py`, then `spikes/native-observer/stability/repro_fd_inventory_eio.py`.
Host pins are Docker client 29.5.2, server 29.2.1 commit 6bc6209, Linux 6.8.0-100-generic, Zig 0.17.0, runc 1.3.4, and docker-init 0.19.0 commit de40ad0.
Docker, Zig, and llvm-objdump executable SHA256 pins are `d79e988b423edbe34460a2e4d86ecc841997f16c5e2a2ee5263f679d0c483a84`, `9fb480d3398506f5e2bef77f175766a8de0ee191dbdfbfb0c117a1150f141c91`, and `1dcc1432db4d828cf8cd71a84cb8d9bf63a7ca80b5eeec711a9e5f13a3f5f98e`.
Executed init SHA256 is `d286e5df628bc2ceafe66dfb82e57fdf6ff66995a1cad073c9347e9bccc3dfb1`. The inspected base image is `node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`.
The host tools are pinned by the admitted executor and source checks. Their executable bytes are not in the retained archive.

Full stability, thread and CLONE_VM families, all 72 birth cases, full lifetime and epochs, authority, checked releases, imports, Node compatibility, native SDKs, adapters, providers, and consumer live gates remain unqualified.
Review gauntlet, current-head CI, and final independent approval remain required before merge. This evidence inspection grants no merge approval.
