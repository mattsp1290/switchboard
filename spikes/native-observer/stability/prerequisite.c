#define _GNU_SOURCE
#include <sys/ptrace.h>
#include <linux/ptrace.h>
#include <linux/audit.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/utsname.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pid_t target;

static void require(int condition, const char *operation) {
    if (condition) return;
    dprintf(2, "FAIL %s errno=%d\n", operation, errno);
    if (target > 0) {
        kill(target, SIGKILL);
        waitpid(target, NULL, __WALL);
    }
    _exit(90);
}

static void delay(long milliseconds) {
    struct timespec duration = {milliseconds / 1000, (milliseconds % 1000) * 1000000};
    require(clock_nanosleep(CLOCK_MONOTONIC, 0, &duration, NULL) == 0, "monotonic delay");
}

static void drop(void) {
    require(setgroups(0, NULL) == 0, "setgroups");
    require(setresgid(65534, 65534, 65534) == 0, "setresgid");
    require(setresuid(65534, 65534, 65534) == 0, "setresuid");
}

static void status(pid_t pid) {
    char path[80], text[8192];
    snprintf(path, sizeof(path), "/proc/%d/status", pid);
    int fd = open(path, O_RDONLY);
    require(fd >= 0, "status open");
    ssize_t count = read(fd, text, sizeof(text) - 1);
    require(count > 0 && count < (ssize_t)sizeof(text) - 1, "status complete");
    text[count] = 0;
    close(fd);
    dprintf(2, "STATUS %d\n%sEND_STATUS\n", pid, text);
    require(strstr(text, "Uid:\t65534\t65534\t65534\t65534\n") != NULL, "uids");
    require(strstr(text, "Gid:\t65534\t65534\t65534\t65534\n") != NULL, "gids");
    const char *groups = strstr(text, "\nGroups:\t");
    require(groups && groups[9 + strspn(groups + 9, " \t")] == '\n', "groups");
    const char *fields[] = {"CapInh", "CapPrm", "CapEff", "CapAmb"};
    for (unsigned i = 0; i < 4; i++) {
        snprintf(path, sizeof(path), "%s:\t0000000000000000\n", fields[i]);
        require(strstr(text, path) != NULL, "active capabilities");
    }
    require(strstr(text, "NoNewPrivs:\t1\n") != NULL, "no new privileges");
}

static void link_equals(pid_t pid, const char *name, const char *expected) {
    char path[80], value[256];
    snprintf(path, sizeof(path), "/proc/%d/%s", pid, name);
    ssize_t length = readlink(path, value, sizeof(value) - 1);
    require(length > 0 && length < (ssize_t)sizeof(value) - 1, "readlink complete");
    value[length] = 0;
    dprintf(2, "LINK %s %s\n", name, value);
    require(strcmp(value, expected) == 0, "link identity");
}

static int descriptors(pid_t pid) {
    char path[80], link[256], evidence[256], output[256];
    ssize_t length = readlink("/proc/self/fd/2", evidence, sizeof(evidence) - 1);
    require(length > 0 && length < (ssize_t)sizeof(evidence) - 1, "evidence identity");
    evidence[length] = 0;
    length = readlink("/proc/self/fd/1", output, sizeof(output) - 1);
    require(length > 0 && length < (ssize_t)sizeof(output) - 1, "output identity");
    output[length] = 0;
    require(strcmp(evidence, output) != 0, "distinct evidence channel");
    dprintf(2, "EVIDENCE_FD %s OUTPUT_FD %s\n", evidence, output);
    snprintf(path, sizeof(path), "/proc/%d/fd", pid);
    DIR *dir = opendir(path);
    require(dir != NULL, "fd inventory");
    int leaked = 0;
    struct dirent *entry;
    while ((entry = readdir(dir))) {
        if (entry->d_name[0] == '.') continue;
        int fd = atoi(entry->d_name);
        snprintf(path, sizeof(path), "/proc/%d/fd/%d", pid, fd);
        ssize_t count = readlink(path, link, sizeof(link) - 1);
        require(count > 0 && count < (ssize_t)sizeof(link) - 1, "fd link");
        link[count] = 0;
        dprintf(2, "FD %d %s\n", fd, link);
        require(strcmp(link, evidence) != 0, "target evidence writer excluded");
        if (fd <= 2) require(strcmp(link, fd ? output : "/dev/null") == 0, "admitted stdio");
        if (fd > 2) {
            require(fd == 9 && strcmp(link, "/outside/sentinel") == 0, "unexpected inherited fd");
            leaked++;
        }
    }
    closedir(dir);
    return leaked;
}

static void child(int inherited, int readiness) {
    target = 0;
    for (int fd = 3; fd < 128; fd++) if (fd != inherited && fd != readiness) close(fd);
    require(dup2(1, 2) == 2, "separate target output");
    require(chroot("/sealed") == 0 && chdir("/") == 0, "target root");
    drop();
    require(prctl(PR_SET_DUMPABLE, 1) == 0 && prctl(PR_GET_DUMPABLE) == 1, "target dumpable");
    char ready;
    require(read(readiness, &ready, 1) == 1 && ready == 'R', "final tracer ready");
    close(readiness);
    require(ptrace(PTRACE_TRACEME, 0, NULL, NULL) == 0, "final identity traceme");
    require(syscall(SYS_tgkill, getpid(), gettid(), SIGSTOP) == 0, "initial stop signal");
    int fd = open("/fixture/allowed", O_RDONLY);
    char bytes[8];
    require(fd >= 0 && read(fd, bytes, 8) == 8, "target read");
    require(write(1, bytes, 8) == 8, "target raw output");
    close(fd);
    _exit(0);
}

static void trace(const char *mode, int notification) {
    int readiness[2];
    require(pipe(readiness) == 0, "credential barrier");
    int inherited = -1;
    if (!strcmp(mode, "inherited")) {
        int fd = open("/outside/sentinel", O_RDONLY);
        require(fd >= 0 && dup2(fd, 9) == 9, "inject outside fd");
        if (fd != 9) close(fd);
        inherited = 9;
    }
    target = fork();
    require(target >= 0, "target fork");
    if (!target) child(inherited, readiness[0]);
    close(readiness[0]);
    if (inherited >= 0) close(inherited);
    drop();
    require(prctl(PR_SET_DUMPABLE, 0) == 0 && prctl(PR_GET_DUMPABLE) == 0, "tracer protected");
    dprintf(2, "TRACER dumpable=0\n");
    require(write(readiness[1], "R", 1) == 1, "release final credentials");
    close(readiness[1]);
    int wait_status;
    require(waitpid(target, &wait_status, __WALL) == target, "initial wait");
    require(WIFSTOPPED(wait_status) && WSTOPSIG(wait_status) == SIGSTOP, "initial stop");
    require(ptrace(PTRACE_SETOPTIONS, target, NULL, PTRACE_O_TRACESYSGOOD | PTRACE_O_EXITKILL) == 0, "ptrace options");
    status(getpid());
    status(target);
    link_equals(target, "root", "/sealed");
    link_equals(target, "cwd", "/sealed");
    int leaked = descriptors(target);
    dprintf(2, "TARGET %d\n", target);
    require(write(notification, &target, sizeof(target)) == sizeof(target), "notify supervisor");
    if (leaked) {
        require(!strcmp(mode, "inherited"), "leak mode");
        kill(target, SIGKILL);
        require(waitpid(target, &wait_status, __WALL) == target && WIFSIGNALED(wait_status), "reject reap");
        dprintf(2, "REJECT_INHERITED_FD\n");
        _exit(0);
    }
    if (!strcmp(mode, "death")) for (;;) pause();
    int entering = 1, opened = 0;
    unsigned long long operation = 0;
    for (;;) {
        require(ptrace(PTRACE_SYSCALL, target, NULL, NULL) == 0, "resume");
        require(waitpid(target, &wait_status, __WALL) == target, "syscall wait");
        if (WIFEXITED(wait_status)) {
            require(WEXITSTATUS(wait_status) == 0 && opened, "terminal");
            break;
        }
        require(WIFSTOPPED(wait_status) && WSTOPSIG(wait_status) == (SIGTRAP | 0x80), "classified stop");
        struct ptrace_syscall_info info = {0};
        long count = ptrace(PTRACE_GET_SYSCALL_INFO, target, sizeof(info), &info);
        require(count >= (entering ? 80 : 33) && count <= (long)sizeof(info), "syscall info length");
        require(info.arch == AUDIT_ARCH_AARCH64, "syscall architecture");
        require(info.op == (entering ? PTRACE_SYSCALL_INFO_ENTRY : PTRACE_SYSCALL_INFO_EXIT), "syscall pairing");
        if (!entering) dprintf(2, "EXIT %llu result=%lld size=%ld\n", operation, info.exit.rval, count);
        if (entering) {
            operation = info.entry.nr;
            dprintf(2, "ENTRY %llu size=%ld arch=%x\n", operation, count, info.arch);
            require(operation == SYS_openat || operation == SYS_read || operation == SYS_write ||
                    operation == SYS_close || operation == SYS_exit_group, "finite operation");
            if (operation == SYS_openat) {
                char path[24] = {0};
                for (unsigned offset = 0; offset < sizeof(path); offset += sizeof(long)) {
                    errno = 0;
                    long word = ptrace(PTRACE_PEEKDATA, target, info.entry.args[1] + offset, NULL);
                    require(errno == 0, "ptrace memory read");
                    memcpy(path + offset, &word, sizeof(word));
                }
                require(memchr(path, 0, sizeof(path)) && strcmp(path, "/fixture/allowed") == 0, "complete pathname");
                dprintf(2, "PATH %s\n", path);
            }
        } else if (operation == SYS_openat) {
            require(info.exit.rval >= 0, "open result");
            char name[40], path[80], bytes[9] = {0};
            snprintf(name, sizeof(name), "fd/%lld", (long long)info.exit.rval);
            link_equals(target, name, "/sealed/fixture/allowed");
            snprintf(path, sizeof(path), "/proc/%d/%s", target, name);
            int fd = open(path, O_RDONLY);
            require(fd >= 0 && pread(fd, bytes, 8, 0) == 8, "returned fd inspection");
            close(fd);
            require(!strcmp(bytes, "allowed\n"), "returned content");
            opened++;
        }
        entering = !entering;
    }
    dprintf(2, "PREREQUISITES_OBSERVED\n");
    _exit(0);
}

int main(int argc, char **argv) {
    alarm(15);
    require(argc == 2, "mode");
    if (!strcmp(argv[1], "init")) {
        int fd = open("/proc/1/exe", O_RDONLY);
        require(fd >= 0, "executed init open");
        char bytes[4096];
        ssize_t count, total = 0;
        while ((count = read(fd, bytes, sizeof(bytes))) > 0) {
            total += count;
            require(total <= 1048576, "executed init bound");
            require(write(1, bytes, count) == count, "executed init export");
        }
        require(count == 0, "executed init complete");
        return 0;
    }
    link_equals(1, "exe", "/sbin/docker-init");
    int subreaper = -1;
    require(prctl(PR_GET_CHILD_SUBREAPER, &subreaper) == 0 && !subreaper, "supervisor not subreaper");
    if (!strcmp(argv[1], "hold")) { delay(10000); return 0; }
    struct sigaction disposition;
    require(sigaction(SIGCHLD, NULL, &disposition) == 0 && disposition.sa_handler == SIG_DFL &&
            !(disposition.sa_flags & SA_NOCLDWAIT), "supervisor child disposition");
    dprintf(2, "SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0\n");
    int notification[2];
    require(pipe(notification) == 0, "notification pipe");
    pid_t tracer = fork();
    require(tracer >= 0, "tracer fork");
    if (!tracer) { close(notification[0]); trace(argv[1], notification[1]); }
    close(notification[1]);
    drop();
    status(getpid());
    pid_t owned = 0;
    ssize_t received = read(notification[0], &owned, sizeof(owned));
    close(notification[0]);
    if (!strcmp(argv[1], "death") && received == sizeof(owned)) require(kill(tracer, SIGKILL) == 0, "tracer death");
    int state;
    require(waitpid(tracer, &state, 0) == tracer, "supervisor reap tracer");
    require(received == sizeof(owned), "supervisor target record");
    require(!strcmp(argv[1], "death") ? WIFSIGNALED(state) && WTERMSIG(state) == SIGKILL :
            WIFEXITED(state) && WEXITSTATUS(state) == 0, "tracer completion");
    dprintf(2, "TRACER_TERMINAL %d wait_status=%d\n", tracer, state);
    char path[80];
    snprintf(path, sizeof(path), "/proc/%d", owned);
    for (int i = 0; i < 100 && access(path, F_OK) == 0; i++) delay(10);
    require(access(path, F_OK) == -1 && errno == ENOENT, "independent target reaping");
    dprintf(2, "REAPED %d SUPERVISOR %d\n", owned, getpid());
    delay(3000);
    return 0;
}
