// Docker seccomp profiles that reproduce the Pi-mode filter of Crew's launcher (crew:native/member-launch.c,
// install_filter with pi set, lines 142-212 at Crew ef86e62) as closely as a container profile allows. The worker is
// PID 1 in its container, so "only this process" becomes "PID 1" (and 0 where the launcher also accepts 0).
// `launcher-locks` adds denials of flock and fcntl record locks, which the launcher does not have.
const EPERM = 1;
const ENOSYS = 38;
const deny = (names, errnoRet = EPERM) => ({ names, action: 'SCMP_ACT_ERRNO', errnoRet });
const denyWhen = (name, args, errnoRet = EPERM) => ({ names: [name], action: 'SCMP_ACT_ERRNO', errnoRet, args });
const arg = (index, op, value, valueTwo = 0) => ({ index, value, valueTwo, op });
const CLONE_THREAD = 0x10000;

export function seccompProfile(variant, arch) {
  if (!['launcher', 'launcher-locks'].includes(variant)) throw new Error(`Unknown seccomp variant ${variant}`);
  const syscalls = [
    deny(['setsid', 'setpgid']), // :158-159, every engine
    deny(['socket', 'socketpair', 'io_uring_setup']), // :161-163
    deny(['fork', 'vfork']), // :165-166, x86-64 only in the launcher; aarch64 has neither call
    deny(['clone3'], ENOSYS), // :169, so glibc falls back to clone for threads
    deny(['tkill', 'pidfd_send_signal', 'rt_sigqueueinfo', 'rt_tgsigqueueinfo']), // :170-173
    deny(['shmget', 'msgget', 'semget', 'mq_open', 'ptrace']), // :174-178
    deny(['chmod', 'utime', 'utimes', 'futimesat']), // :180-183, x86-64 only
    deny(['fchmodat', 'fchmodat2', 'utimensat', 'setxattr', 'lsetxattr', 'removexattr', 'lremovexattr', 'setxattrat',
      'removexattrat', 'file_setattr']), // :185-195
    denyWhen('clone', [arg(0, 'SCMP_CMP_MASKED_EQ', CLONE_THREAD, 0)]), // :111-117 threads_only
    denyWhen('prctl', [arg(0, 'SCMP_CMP_EQ', 1)]), // :119-125 keep_death_signal, PR_SET_PDEATHSIG = 1
    denyWhen('kill', [arg(0, 'SCMP_CMP_NE', 1)]), // :127-134 signal_only_self
    denyWhen('tgkill', [arg(0, 'SCMP_CMP_NE', 1)]),
    ...['prlimit64', 'sched_setaffinity', 'sched_setattr', 'sched_setparam', 'sched_setscheduler']
      .map((name) => denyWhen(name, [arg(0, 'SCMP_CMP_GT', 1)])), // :84-91 only_self, :199-203
    denyWhen('setpriority', [arg(0, 'SCMP_CMP_NE', 0)]), // :93-102 only_self_process, PRIO_PROCESS = 0, :204
    denyWhen('setpriority', [arg(0, 'SCMP_CMP_EQ', 0), arg(1, 'SCMP_CMP_GT', 1)]),
    denyWhen('ioprio_set', [arg(0, 'SCMP_CMP_NE', 1)]), // IOPRIO_WHO_PROCESS = 1, :205
    denyWhen('ioprio_set', [arg(0, 'SCMP_CMP_EQ', 1), arg(1, 'SCMP_CMP_GT', 1)]),
    denyWhen('fcntl', [arg(1, 'SCMP_CMP_EQ', 8)]), // :103-110 refuse_commands, F_SETOWN, :206
    denyWhen('fcntl', [arg(1, 'SCMP_CMP_EQ', 15)]), // F_SETOWN_EX
    denyWhen('ioctl', [arg(1, 'SCMP_CMP_EQ', 0x8901)]), // FIOSETOWN, :207
    denyWhen('ioctl', [arg(1, 'SCMP_CMP_EQ', 0x8902)]), // SIOCSPGRP
  ];
  if (variant === 'launcher-locks') {
    syscalls.push(deny(['flock']));
    // F_SETLK, F_SETLKW, F_OFD_SETLK, F_OFD_SETLKW
    for (const command of [6, 7, 37, 38]) syscalls.push(denyWhen('fcntl', [arg(1, 'SCMP_CMP_EQ', command)]));
  }
  // The launcher kills a foreign architecture (:143-151); a profile that lists only the native one leaves the others to
  // libseccomp's bad-architecture action, which also kills.
  return { defaultAction: 'SCMP_ACT_ALLOW', architectures: [arch === 'arm64' ? 'SCMP_ARCH_AARCH64' : 'SCMP_ARCH_X86_64'], syscalls };
}
