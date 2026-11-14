#define _GNU_SOURCE
#include <sys/ptrace.h>
#include <linux/ptrace.h>
#include <linux/audit.h>
#include <linux/futex.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/utsname.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pid_t target;
static const char *raw_mode;
static char blocked_input[80];

static int raw_is(const char *name) {
    return raw_mode && !strcmp(raw_mode, name);
}

static void require(int condition, const char *operation) {
    if (condition) return;
    dprintf(2, "FAIL %s errno=%d\n", operation, errno);
    if (target > 0) {
        kill(target, SIGKILL);
        int state;
        pid_t reaped = waitpid(target, &state, __WALL);
        if (raw_mode) dprintf(2, "RAW_CLEANUP target=%d reaped=%d status=%d\n", target, reaped,
                             reaped == target ? state : -1);
    }
    _exit(90);
}

static int pause_for(long milliseconds) {
    struct timespec duration = {milliseconds / 1000, (milliseconds % 1000) * 1000000};
    return clock_nanosleep(CLOCK_MONOTONIC, 0, &duration, NULL);
}

static void delay(long milliseconds) {
    require(pause_for(milliseconds) == 0, "monotonic delay");
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
    int leaked = 0, stdio = 0;
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
        if (fd <= 2) {
            require(strcmp(link, fd ? output : blocked_input[0] ? blocked_input : "/dev/null") == 0,
                    "admitted stdio");
            stdio |= 1 << fd;
        }
        if (fd > 2) {
            require(fd == 9 && strcmp(link, "/outside/sentinel") == 0, "unexpected inherited fd");
            leaked++;
        }
    }
    closedir(dir);
    require(stdio == 7, "complete stdio inventory");
    return leaked;
}

static inline __attribute__((always_inline)) long raw_call(long number, long a, long b, long c) {
    register long x8 __asm__("x8") = number;
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2) : "memory", "cc");
    return x0;
}

static const char raw_bytes[] = "raw-ok\n";
static char raw_input;

__attribute__((noinline, noreturn)) static void raw_target(int registration, int blocked) {
    raw_call(SYS_set_tid_address, 0, 0, 0);
    raw_call(SYS_getpid, 0, 0, 0);
    if (registration) raw_call(SYS_set_robust_list, 0, 0, 0);
    if (blocked) raw_call(SYS_read, 0, (long)&raw_input, 1);
    raw_call(SYS_write, 1, (long)raw_bytes, sizeof(raw_bytes) - 1);
    raw_call(SYS_exit, 0, 0, 0);
    __builtin_unreachable();
}

static long milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
    return now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

typedef struct {
    int (*poll)(struct pollfd *, nfds_t, int);
    ssize_t (*read)(int, void *, size_t);
    int (*kill)(pid_t, int);
    long (*clock)(void);
    pid_t (*waitpid)(pid_t, int *, int);
    int (*access)(const char *, int);
    int (*delay)(long);
} NoticeIO;

static const NoticeIO native_io = {poll, read, kill, milliseconds, waitpid, access, pause_for};

static int bounded_wait(pid_t pid, int *state, long duration, const NoticeIO *io) {
    long now = io->clock();
    if (now < 0) return -1;
    long end = now + duration;
    do {
        pid_t result = io->waitpid(pid, state, __WALL | WNOHANG);
        if (result < 0) return -1;
        if (result == pid) return 1;
        if (io->delay(2)) return -1;
        now = io->clock();
        if (now < 0) return -1;
    } while (now < end);
    return 0;
}

typedef struct {
    int kind;
    pid_t pid;
} Notice;

_Static_assert(sizeof(Notice) == 8, "fixed private notice record");

typedef struct {
    pid_t root;
    int ready, death_sent;
} NoticeReceipt;

static void notify(int fd, int kind) {
    Notice record = {.kind = kind, .pid = target};
    require(write(fd, &record, sizeof(record)) == sizeof(record), "supervisor notice write");
}

static int read_notices(int fd, pid_t tracer, int death, NoticeReceipt *receipt, const NoticeIO *io) {
    long now = io->clock();
    if (now < 0) return 0;
    long deadline = now + 3000;
    for (;;) {
        struct pollfd channel = {.fd = fd, .events = POLLIN};
        now = io->clock();
        if (now < 0) return 0;
        long remaining = deadline - now;
        if (remaining <= 0 || io->poll(&channel, 1, (int)remaining) != 1 ||
                channel.revents & (POLLERR | POLLNVAL) || !(channel.revents & (POLLIN | POLLHUP))) return 0;
        Notice record = {0};
        ssize_t count = io->read(fd, &record, sizeof(record));
        now = io->clock();
        if (now < 0 || now >= deadline) return 0;
        if (!count) return receipt->root > 0 && receipt->ready == death;
        if (count != sizeof(record) || record.pid <= 0 || record.pid == tracer) return 0;
        if (record.kind == 1) {
            if (receipt->root || receipt->ready) return 0;
            receipt->root = record.pid;
        } else if (record.kind == 2) {
            if (!death || !receipt->root || receipt->ready || record.pid != receipt->root) return 0;
            receipt->ready = 1;
            if (io->kill(tracer, SIGKILL)) return 0;
            receipt->death_sent = 1;
        } else return 0;
    }
}

static int target_absent(pid_t pid, const NoticeIO *io) {
    char path[80];
    snprintf(path, sizeof(path), "/proc/%d", pid);
    for (int i = 0; i <= 100; i++) {
        int result = io->access(path, F_OK);
        if (result == -1) return errno == ENOENT;
        if (result != 0 || i == 100 || io->delay(10)) return 0;
    }
    return 0;
}

typedef struct {
    NoticeReceipt receipt;
    int state, expired, valid;
} NoticeOutcome;

static NoticeOutcome supervise_notices(int fd, pid_t tracer, int raw, int death, const NoticeIO *io) {
    NoticeOutcome outcome = {0};
    int protocol = read_notices(fd, tracer, death, &outcome.receipt, io);
    int action = 1;
    if (!protocol && !outcome.receipt.death_sent)
        action = io->kill(tracer, SIGKILL) == 0 || errno == ESRCH;
    int reaped = bounded_wait(tracer, &outcome.state, 5000, io);
    if (!reaped) {
        outcome.expired = 1;
        action = (io->kill(tracer, SIGKILL) == 0 || errno == ESRCH) && action;
        reaped = bounded_wait(tracer, &outcome.state, 1000, io);
    }
    int absent = outcome.receipt.root && target_absent(outcome.receipt.root, io);
    int terminal = WIFEXITED(outcome.state) || WIFSIGNALED(outcome.state);
    int completion = raw || (death ? WIFSIGNALED(outcome.state) && WTERMSIG(outcome.state) == SIGKILL :
                            WIFEXITED(outcome.state) && WEXITSTATUS(outcome.state) == 0);
    outcome.valid = protocol && action && reaped == 1 && !outcome.expired && absent && terminal && completion;
    return outcome;
}

typedef struct {
    int polled;
    short events;
    ssize_t count;
    Notice record;
} NoticeStep;

typedef struct {
    int result, error;
} NoticeAccess;

static struct {
    NoticeStep steps[4];
    unsigned cursor, polls, reads, actions, clocks, expiry, waits, accesses, absence_delays, wait_delays;
    unsigned clock_error;
    unsigned late_poll, late_read;
    int delay_error, access_error;
    NoticeAccess access_steps[3];
    unsigned access_step_count;
    unsigned reader_clocks, expected_actions, expected_waits;
    int action_error, timeouts_wrong, order_wrong, wait_results[2], state, absent;
    long now;
} notice_script;

static int scripted_poll(struct pollfd *channels, nfds_t count, int timeout) {
    if (count != 1 || channels[0].fd != 17 || timeout <= 0 || timeout > 3000 || notice_script.cursor >= 4) {
        notice_script.order_wrong = 1;
        return -1;
    }
    if (timeout != 2990 - (int)notice_script.polls * 20) notice_script.timeouts_wrong = 1;
    notice_script.polls++;
    if (notice_script.polls == notice_script.late_poll) notice_script.now += 3000;
    channels[0].revents = notice_script.steps[notice_script.cursor].events;
    int result = notice_script.steps[notice_script.cursor].polled;
    if (result != 1) notice_script.cursor++;
    return result;
}

static ssize_t scripted_read(int fd, void *data, size_t size) {
    if (fd != 17 || size != sizeof(Notice) || notice_script.cursor >= 4) {
        notice_script.order_wrong = 1;
        return -1;
    }
    NoticeStep step = notice_script.steps[notice_script.cursor++];
    notice_script.reads++;
    if (notice_script.reads == notice_script.late_read) notice_script.now += 3000;
    memcpy(data, &step.record, sizeof(Notice));
    return step.count;
}

static int scripted_kill(pid_t pid, int signal) {
    if (pid != 91 || signal != SIGKILL) {
        notice_script.order_wrong = 1;
        return -1;
    }
    notice_script.actions++;
    errno = EIO;
    return notice_script.action_error;
}

static long scripted_clock(void) {
    unsigned index = notice_script.clocks++;
    if (index + 1 == notice_script.clock_error) return -1;
    long next = index && index == notice_script.expiry ? 3000 : index * 10;
    if (!notice_script.waits && next > notice_script.now) notice_script.now = next;
    return notice_script.now;
}

static pid_t scripted_waitpid(pid_t pid, int *state, int flags) {
    unsigned index = notice_script.waits++;
    if (!index) notice_script.reader_clocks = notice_script.clocks - 1;
    if (notice_script.actions != notice_script.expected_actions + index) notice_script.order_wrong = 1;
    if (pid != 91 || index >= 2 || flags != (__WALL | WNOHANG)) {
        notice_script.order_wrong = 1;
        return -1;
    }
    *state = notice_script.state;
    return notice_script.wait_results[index] == 1 ? pid : notice_script.wait_results[index];
}

static int scripted_access(const char *path, int mode) {
    unsigned index = notice_script.accesses++;
    if (strcmp(path, "/proc/23") || mode != F_OK || notice_script.waits != notice_script.expected_waits)
        notice_script.order_wrong = 1;
    if (index < notice_script.access_step_count) {
        NoticeAccess step = notice_script.access_steps[index];
        errno = step.error;
        return step.result;
    }
    errno = notice_script.access_error ? notice_script.access_error : ENOENT;
    return notice_script.access_error || notice_script.absent ? -1 : 0;
}

static int scripted_delay(long duration) {
    if (duration == 2) {
        notice_script.wait_delays++;
        notice_script.now += notice_script.waits == 1 ? 5000 : 1000;
    } else if (duration == 10) notice_script.absence_delays++;
    else notice_script.order_wrong = 1;
    return duration == notice_script.delay_error ? EIO : 0;
}

static int notice_tests(void) {
    const NoticeStep root = {1, POLLIN, 8, {1, 23}};
    const NoticeStep ready = {1, POLLIN, 8, {2, 23}};
    const NoticeStep end = {1, POLLHUP, 0, {0, 0}};
    const struct {
        const char *name;
        NoticeStep steps[4];
        int death, valid;
        pid_t root;
        unsigned actions, polls, reads;
        int action_error;
        unsigned expiry, clock_error, late_poll, late_read;
    } cases[] = {
        {"normal", {root, end}, 0, 1, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"death", {root, ready, end}, 1, 1, 23, 1, 3, 3, 0, 0, 0, 0, 0},
        {"empty-root", {end}, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"short-root", {{1, POLLIN, 1, {1, 23}}, root, ready, end}, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"zero-root", {{1, POLLIN, 8, {1, 0}}}, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"negative-root", {{1, POLLIN, 8, {1, -1}}}, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"unknown-root", {{1, POLLIN, 8, {9, 23}}}, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"duplicate-root", {root, root}, 0, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"different-root", {root, {1, POLLIN, 8, {1, 24}}}, 0, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"short-ready", {root, {1, POLLIN, 7, {2, 23}}}, 1, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"early-ready", {ready}, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"wrong-ready-root", {root, {1, POLLIN, 8, {2, 24}}}, 1, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"unexpected-ready", {root, ready}, 0, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"wrong-ready-kind", {root, {1, POLLIN, 8, {3, 23}}}, 1, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"duplicate-ready", {root, ready, ready}, 1, 0, 23, 1, 3, 3, 0, 0, 0, 0, 0},
        {"root-after-ready", {root, ready, root}, 1, 0, 23, 1, 3, 3, 0, 0, 0, 0, 0},
        {"missing-ready", {root, end}, 1, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"poll-timeout", {{0, 0, 0, {0, 0}}}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0},
        {"poll-error", {{-1, 0, 0, {0, 0}}}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0},
        {"poll-invalid", {{1, POLLNVAL, 8, {1, 23}}}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0},
        {"read-error", {{1, POLLIN, -1, {1, 23}}}, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"oversize-root", {{1, POLLIN, 9, {1, 23}}}, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"poll-no-events", {{1, 0, 8, {1, 23}}}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0},
        {"poll-broken", {{1, POLLERR, 8, {1, 23}}}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0},
        {"kill-error", {root, ready}, 1, 0, 23, 1, 2, 2, -1, 0, 0, 0, 0},
        {"later-poll-error", {root, {-1, 0, 0, {0, 0}}}, 1, 0, 23, 0, 2, 1, 0, 0, 0, 0, 0},
        {"later-read-error", {root, {1, POLLIN, -1, {2, 23}}}, 1, 0, 23, 0, 2, 2, 0, 0, 0, 0, 0},
        {"tracer-as-root", {{1, POLLIN, 8, {1, 91}}, root, ready, end}, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0},
        {"first-expiry", {root, ready, end}, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0},
        {"root-expiry", {root, ready, end}, 1, 0, 23, 0, 1, 1, 0, 3, 0, 0, 0},
        {"ready-expiry", {root, ready, end}, 1, 0, 23, 1, 2, 2, 0, 5, 0, 0, 0},
        {"ready-poll-error", {root, ready, {-1, 0, 0, {0, 0}}}, 1, 0, 23, 1, 3, 2, 0, 0, 0, 0, 0},
        {"ready-read-error", {root, ready, {1, POLLIN, -1, {0, 0}}}, 1, 0, 23, 1, 3, 3, 0, 0, 0, 0, 0},
        {"ready-short", {root, ready, {1, POLLIN, 1, {0, 0}}}, 1, 0, 23, 1, 3, 3, 0, 0, 0, 0, 0},
        {"later-timeout", {root, {0, 0, 0, {0, 0}}}, 1, 0, 23, 0, 2, 1, 0, 0, 0, 0, 0},
        {"late-root-poll", {root, ready, end}, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0},
        {"late-root-read", {root, ready, end}, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1},
        {"late-ready-poll", {root, ready, end}, 1, 0, 23, 0, 2, 2, 0, 0, 0, 2, 0},
        {"late-ready-read", {root, ready, end}, 1, 0, 23, 0, 2, 2, 0, 0, 0, 0, 2},
        {"late-eof-poll", {root, ready, end}, 1, 0, 23, 1, 3, 3, 0, 0, 0, 3, 0},
        {"late-eof-read", {root, ready, end}, 1, 0, 23, 1, 3, 3, 0, 0, 0, 0, 3},
        {"root-clock-error", {root, ready, end}, 1, 0, 23, 0, 1, 1, 0, 0, 4, 0, 0},
        {"ready-clock-error", {root, ready, end}, 1, 0, 23, 1, 2, 2, 0, 0, 6, 0, 0},
        {"root-read-clock-error", {root, ready, end}, 1, 0, 23, 0, 2, 2, 0, 0, 5, 0, 0},
        {"ready-read-clock-error", {root, ready, end}, 1, 0, 23, 1, 3, 3, 0, 0, 7, 0, 0}
    };
    const NoticeIO io = {scripted_poll, scripted_read, scripted_kill, scripted_clock,
                         scripted_waitpid, scripted_access, scripted_delay};
    unsigned failures = 0, id = 0;
    for (unsigned i = 0; i < sizeof(cases) / sizeof(*cases); i++) {
        for (int caller = 0; caller < 3; caller++) {
            memset(&notice_script, 0, sizeof(notice_script));
            memcpy(notice_script.steps, cases[i].steps, sizeof(notice_script.steps));
            notice_script.action_error = cases[i].action_error;
            notice_script.expiry = cases[i].expiry;
            notice_script.clock_error = cases[i].clock_error;
            notice_script.late_poll = cases[i].late_poll;
            notice_script.late_read = cases[i].late_read;
            notice_script.wait_results[0] = notice_script.absent = 1;
            int sent = cases[i].actions && !cases[i].action_error;
            unsigned actions = cases[i].actions + (caller && !cases[i].valid && !sent);
            notice_script.expected_actions = actions;
            notice_script.expected_waits = 1;
            notice_script.state = cases[i].death || !cases[i].valid ? SIGKILL : 0;
            NoticeOutcome outcome = {0};
            int valid;
            if (caller) {
                outcome = supervise_notices(17, 91, caller == 2, cases[i].death, &io);
                valid = outcome.valid;
            } else valid = read_notices(17, 91, cases[i].death, &outcome.receipt, &io);
            int correct = valid == cases[i].valid && outcome.receipt.root == cases[i].root &&
                notice_script.actions == actions && notice_script.polls == cases[i].polls &&
                notice_script.reads == cases[i].reads && !notice_script.timeouts_wrong &&
                (caller ? notice_script.reader_clocks : notice_script.clocks) ==
                    (cases[i].clock_error ? cases[i].clock_error :
                     cases[i].polls + cases[i].reads + 1 + !!cases[i].expiry) &&
                outcome.receipt.ready == (cases[i].actions != 0) && outcome.receipt.death_sent == sent &&
                notice_script.waits == !!caller && notice_script.accesses == (caller && cases[i].root > 0 ? 1U : 0U) &&
                !notice_script.order_wrong && !notice_script.wait_delays && !notice_script.absence_delays;
            failures += !correct;
            dprintf(1, "NOTICE_TEST %u %s-%s result=%d\n", id++,
                    caller == 2 ? "raw" : caller ? "prerequisite" : "reader", cases[i].name, correct);
        }
    }
    const struct {
        const char *name;
        int death, waits[2], state, action_error, absent, valid;
        unsigned actions, wait_count, delay_count, clock_error;
        int delay_error, access_error;
        unsigned access_count, absence_delay_count;
        NoticeAccess access_steps[3];
        unsigned access_step_count;
    } cleanup[] = {
        {"completion-failure", 0, {1, 0}, 90 << 8, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, {{0, 0}}, 0},
        {"absence-failure", 0, {1, 0}, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 101, 100, {{0, 0}}, 0},
        {"wait-error", 1, {-1, 0}, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, {{0, 0}}, 0},
        {"wait-deadline", 1, {0, 1}, SIGKILL, 0, 1, 0, 2, 2, 1, 0, 0, 0, 1, 0, {{0, 0}}, 0},
        {"fallback-signal-failure", 0, {0, 1}, SIGKILL, -1, 1, 0, 1, 2, 1, 0, 0, 0, 1, 0, {{0, 0}}, 0},
        {"fallback-reap-failure", 0, {0, 0}, SIGKILL, 0, 1, 0, 1, 2, 2, 0, 0, 0, 1, 0, {{0, 0}}, 0},
        {"initial-wait-clock-error", 1, {1, 0}, SIGKILL, 0, 1, 0, 1, 0, 0, 8, 0, 0, 1, 0, {{0, 0}}, 0},
        {"later-wait-clock-error", 1, {0, 0}, SIGKILL, 0, 1, 0, 1, 1, 1, 9, 0, 0, 1, 0, {{0, 0}}, 0},
        {"wait-delay-error", 1, {0, 0}, SIGKILL, 0, 1, 0, 1, 1, 1, 0, 2, 0, 1, 0, {{0, 0}}, 0},
        {"absence-delay-error", 1, {1, 0}, SIGKILL, 0, 0, 0, 1, 1, 0, 0, 10, 0, 1, 1, {{0, 0}}, 0},
        {"access-error", 1, {1, 0}, SIGKILL, 0, 1, 0, 1, 1, 0, 0, 0, EACCES, 1, 0, {{0, 0}}, 0},
        {"immediate-access-eacces", 1, {1, 0}, SIGKILL, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, {{-1, EACCES}, {-1, ENOENT}}, 2},
        {"later-access-eacces", 1, {1, 0}, SIGKILL, 0, 1, 0, 1, 1, 0, 0, 0, 0, 2, 1, {{0, 0}, {-1, EACCES}, {-1, ENOENT}}, 3},
        {"immediate-access-eio", 1, {1, 0}, SIGKILL, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, {{-1, EIO}, {-1, ENOENT}}, 2},
        {"later-access-eio", 1, {1, 0}, SIGKILL, 0, 1, 0, 1, 1, 0, 0, 0, 0, 2, 1, {{0, 0}, {-1, EIO}, {-1, ENOENT}}, 3}
    };
    for (unsigned i = 0; i < sizeof(cleanup) / sizeof(*cleanup); i++) {
        for (int raw = 0; raw < 2; raw++) {
            memset(&notice_script, 0, sizeof(notice_script));
            notice_script.steps[0] = root;
            notice_script.steps[1] = cleanup[i].death ? ready : end;
            notice_script.steps[2] = end;
            memcpy(notice_script.wait_results, cleanup[i].waits, sizeof(notice_script.wait_results));
            notice_script.state = cleanup[i].state;
            notice_script.action_error = cleanup[i].action_error;
            notice_script.absent = cleanup[i].absent;
            notice_script.clock_error = cleanup[i].clock_error;
            notice_script.delay_error = cleanup[i].delay_error;
            notice_script.access_error = cleanup[i].access_error;
            memcpy(notice_script.access_steps, cleanup[i].access_steps, sizeof(notice_script.access_steps));
            notice_script.access_step_count = cleanup[i].access_step_count;
            notice_script.expected_actions = cleanup[i].death;
            notice_script.expected_waits = cleanup[i].wait_count;
            NoticeOutcome outcome = supervise_notices(17, 91, raw, cleanup[i].death, &io);
            int correct = outcome.valid == (raw && cleanup[i].valid) && outcome.receipt.root == 23 &&
                notice_script.actions == cleanup[i].actions && notice_script.waits == cleanup[i].wait_count &&
                outcome.receipt.ready == cleanup[i].death && outcome.receipt.death_sent == cleanup[i].death &&
                notice_script.polls == (cleanup[i].death ? 3U : 2U) && notice_script.reads == notice_script.polls &&
                !notice_script.timeouts_wrong && !notice_script.order_wrong &&
                notice_script.accesses == cleanup[i].access_count &&
                notice_script.absence_delays == cleanup[i].absence_delay_count &&
                notice_script.clocks == (cleanup[i].death ? 8U : 6U) + (cleanup[i].wait_count == 2) +
                    cleanup[i].delay_count - (cleanup[i].delay_error == 2) &&
                notice_script.wait_delays == cleanup[i].delay_count &&
                outcome.expired == (cleanup[i].wait_count == 2);
            failures += !correct;
            dprintf(1, "NOTICE_TEST %u %s-%s result=%d\n", id++,
                    raw ? "raw" : "prerequisite", cleanup[i].name, correct);
        }
    }
    dprintf(1, "NOTICE_TESTS count=%u failed=%u\n", id, failures);
    return failures ? 90 : 0;
}

static void raw_maps(void) {
    char name[80], line[512];
    snprintf(name, sizeof(name), "/proc/%d/maps", target);
    FILE *maps = fopen(name, "r");
    require(maps != NULL, "maps open");
    int output_seen = 0, input_seen = 0;
    while (fgets(line, sizeof(line), maps)) {
        unsigned long start, end, offset, inode;
        char permissions[5], device[24], path[256] = "";
        require(strchr(line, '\n') != NULL, "complete map record");
        int fields = sscanf(line, "%lx-%lx %4s %lx %23s %lu %255[^\n]",
                            &start, &end, permissions, &offset, device, &inode, path);
        dprintf(2, "MAP %s", line);
        require(fields >= 6 && start < end, "map structure");
        require(!path[0] || !strcmp(path, "/probe") || !strcmp(path, "[stack]") ||
                !strcmp(path, "[vvar]") || !strcmp(path, "[vdso]"), "inventoried map origin");
        if ((unsigned long)raw_bytes >= start && (unsigned long)raw_bytes + sizeof(raw_bytes) <= end)
            output_seen = permissions[0] == 'r' && permissions[1] == '-' && !strcmp(path, "/probe");
        if ((unsigned long)&raw_input >= start && (unsigned long)&raw_input < end)
            input_seen = permissions[1] == 'w' && permissions[3] == 'p';
        if (permissions[1] == 'w')
            require(permissions[3] == 'p' && (!path[0] || !strcmp(path, "/probe") ||
                    !strcmp(path, "[stack]")), "private inventoried writable mapping");
    }
    require(!ferror(maps) && feof(maps) && output_seen && input_seen, "maps and argument ranges complete");
    fclose(maps);
}

static void registration_absent(void) {
    struct robust_list_head *head = (void *)1;
    size_t length = 0;
    long result = syscall(SYS_get_robust_list, target, &head,
                          raw_is("query-bad") ? NULL : &length);
    dprintf(2, "ROBUST result=%ld errno=%d pointer=%p size=%zu expected=%zu\n",
            result, errno, (void *)head, length, sizeof(struct robust_list_head));
    require(result == 0 && !head && length == sizeof(struct robust_list_head), "robust absence query");
    struct ptrace_rseq_configuration configuration = {0};
    size_t requested = raw_is("query-short") ? 1 : sizeof(configuration);
    result = ptrace(PTRACE_GET_RSEQ_CONFIGURATION, target, requested, &configuration);
    dprintf(2, "RSEQ requested=%zu returned=%ld pointer=%llu size=%u signature=%u flags=%u pad=%u\n",
            requested, result, configuration.rseq_abi_pointer, configuration.rseq_abi_size,
            configuration.signature, configuration.flags, configuration.pad);
    require(requested == sizeof(configuration) && result == (long)sizeof(configuration) &&
            !configuration.rseq_abi_pointer && !configuration.rseq_abi_size &&
            !configuration.signature && !configuration.flags && !configuration.pad, "rseq absence query");
}

static void raw_trace(int notification) {
    raw_maps();
    unsigned step = 0;
    int entering = 1, state;
    const long recipe[] = {SYS_set_tid_address, SYS_getpid, SYS_write, SYS_exit};
    for (;;) {
        require(ptrace(PTRACE_SYSCALL, target, NULL, NULL) == 0, "raw resume");
        int waited = bounded_wait(target, &state, 700, &native_io);
        require(waited >= 0, "bounded wait");
        if (!waited) {
            if (raw_is("deadline") && step == 2 && !entering) {
                char path[80];
                snprintf(path, sizeof(path), "/proc/%d/syscall", target);
                FILE *blocked = fopen(path, "r");
                long number;
                unsigned long fd, address, length;
                require(blocked != NULL, "blocked syscall open");
                require(fscanf(blocked, "%ld %lx %lx %lx", &number, &fd, &address, &length) == 4,
                        "blocked syscall observation");
                fclose(blocked);
                require(number == SYS_read && fd == 0 && address == (unsigned long)&raw_input && length == 1,
                        "actual blocked read");
                dprintf(2, "BLOCKED_READ nr=%ld fd=%lu pointer=%lx size=%lu\n", number, fd, address, length);
            }
            dprintf(2, "RAW_DEADLINE step=%u entering=%d\n", step, entering);
            require(0, "raw deadline");
        }
        dprintf(2, "RAW_WAIT status=%d\n", state);
        if (WIFEXITED(state)) {
            require(step == 3 && !entering && WEXITSTATUS(state) == 0, "raw terminal");
            dprintf(2, "RAW_ADMISSION_OBSERVED\n");
            _exit(0);
        }
        require(WIFSTOPPED(state) && WSTOPSIG(state) == (SIGTRAP | 0x80) &&
                !(state >> 16), "raw classified stop");
        struct ptrace_syscall_info info = {0};
        size_t requested = raw_is("info-short") ? 1 : sizeof(info);
        long count = ptrace(PTRACE_GET_SYSCALL_INFO, target, requested, &info);
        dprintf(2, "RAW_INFO requested=%zu returned=%ld op=%u arch=%x\n", requested, count, info.op, info.arch);
        dprintf(2, "RAW_INFO_BYTES ");
        for (size_t i = 0; i < requested && count > 0 && i < (size_t)count; i++)
            dprintf(2, "%02x", ((unsigned char *)&info)[i]);
        dprintf(2, "\n");
        require(count >= (entering ? 80 : 33) && requested >= (entering ? 80U : 33U) &&
                count <= (long)sizeof(info), "raw syscall info size");
        require(info.arch == AUDIT_ARCH_AARCH64 &&
                info.op == (entering ? PTRACE_SYSCALL_INFO_ENTRY : PTRACE_SYSCALL_INFO_EXIT), "raw pairing");
        if (entering) {
            dprintf(2, "RAW_ENTRY step=%u nr=%llu args=%llu,%llu,%llu,%llu,%llu,%llu\n", step,
                    info.entry.nr, info.entry.args[0], info.entry.args[1], info.entry.args[2],
                    info.entry.args[3], info.entry.args[4], info.entry.args[5]);
            if (step == 2 && raw_is("registration")) {
                require(info.entry.nr == SYS_set_robust_list, "registration control entry");
                dprintf(2, "RAW_REJECT_REGISTRATION_BEFORE_EXECUTION\n");
                require(0, "unsupported registration");
            }
            long operation = step == 2 && raw_is("deadline") ? SYS_read : recipe[step];
            require(info.entry.nr == (unsigned long)operation, "fixed raw recipe");
            require(info.entry.args[0] == (step == 2 && !raw_is("deadline") ? 1U : 0U), "raw argument zero");
            require(info.entry.args[1] == (step == 2 ? (unsigned long)(raw_is("deadline") ?
                    &raw_input : (const void *)raw_bytes) : 0U), "raw argument pointer");
            require(info.entry.args[2] == (step == 2 ? (raw_is("deadline") ? 1U : sizeof(raw_bytes) - 1) : 0U),
                    "raw argument size");
            if (step == 1 && raw_is("death")) {
                notify(notification, 2);
                for (;;) pause();
            }
        } else {
            require(step < 3, "unexpected exit syscall return");
            dprintf(2, "RAW_EXIT step=%u result=%lld error=%u\n", step, info.exit.rval, info.exit.is_error);
            require(!info.exit.is_error && info.exit.rval == (step < 2 ? target : (long)sizeof(raw_bytes) - 1),
                    "raw matching successful exit");
            if (!step) registration_absent();
            step++;
        }
        entering = !entering;
    }
}

static void child(int inherited, int readiness) {
    int registration = raw_is("registration"), blocked = raw_is("deadline");
    target = 0;
    for (int fd = 3; fd < 128; fd++) if (fd != inherited && fd != readiness) close(fd);
    require(dup2(1, 2) == 2, "separate target output");
    require(chroot("/sealed") == 0 && chdir("/") == 0, "target root");
    if (raw_is("bad-root")) require(chdir("/fixture") == 0, "malformed cwd");
    drop();
    require(prctl(PR_SET_DUMPABLE, 1) == 0 && prctl(PR_GET_DUMPABLE) == 1, "target dumpable");
    char ready;
    require(read(readiness, &ready, 1) == 1 && ready == 'R', "final tracer ready");
    close(readiness);
    require(ptrace(PTRACE_TRACEME, 0, NULL, NULL) == 0, "final identity traceme");
    require(syscall(SYS_tgkill, getpid(), gettid(), SIGSTOP) == 0, "initial stop signal");
    if (raw_mode) raw_target(registration, blocked);
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
    if (!strcmp(mode, "inherited") || raw_is("inherited")) {
        int fd = open("/outside/sentinel", O_RDONLY);
        require(fd >= 0 && dup2(fd, 9) == 9, "inject outside fd");
        if (fd != 9) close(fd);
        inherited = 9;
    }
    target = fork();
    require(target >= 0, "target fork");
    if (!target) child(inherited, readiness[0]);
    close(readiness[0]);
    if (raw_mode) {
        dprintf(2, "OWNED_TARGET %d\n", target);
        notify(notification, 1);
    }
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
    if (raw_mode) dprintf(2, "RAW_OPTIONS mask=%d result=0\n", PTRACE_O_TRACESYSGOOD | PTRACE_O_EXITKILL);
    status(getpid());
    status(target);
    link_equals(target, "root", "/sealed");
    link_equals(target, "cwd", "/sealed");
    int leaked = descriptors(target);
    dprintf(2, "TARGET %d\n", target);
    if (!raw_mode) notify(notification, 1);
    if (leaked) {
        require(!strcmp(mode, "inherited") || raw_is("inherited"), "leak mode");
        kill(target, SIGKILL);
        require(waitpid(target, &wait_status, __WALL) == target && WIFSIGNALED(wait_status), "reject reap");
        dprintf(2, "REJECT_INHERITED_FD\n");
        _exit(0);
    }
    if (raw_mode) raw_trace(notification);
    if (!strcmp(mode, "death")) {
        notify(notification, 2);
        for (;;) pause();
    }
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
    require(argc == 2, "mode");
    if (!strcmp(argv[1], "notice-tests")) return notice_tests();
    alarm(15);
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
    if (!strncmp(argv[1], "raw-", 4)) {
        raw_mode = argv[1] + 4;
        const char *modes[] = {"normal", "inherited", "bad-root", "info-short", "query-bad",
                               "query-short", "registration", "deadline", "death"};
        int found = 0;
        for (unsigned i = 0; i < sizeof(modes) / sizeof(*modes); i++) found |= raw_is(modes[i]);
        require(found, "known raw control");
    }
    link_equals(1, "exe", "/sbin/docker-init");
    int subreaper = -1;
    require(prctl(PR_GET_CHILD_SUBREAPER, &subreaper) == 0 && !subreaper, "supervisor not subreaper");
    if (!strcmp(argv[1], "hold")) { delay(10000); return 0; }
    struct sigaction disposition;
    require(sigaction(SIGCHLD, NULL, &disposition) == 0 && disposition.sa_handler == SIG_DFL &&
            !(disposition.sa_flags & SA_NOCLDWAIT), "supervisor child disposition");
    dprintf(2, "SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0\n");
    int output[2] = {-1, -1}, blocked[2] = {-1, -1};
    if (raw_mode) require(pipe(output) == 0, "isolated raw output");
    if (raw_is("deadline")) {
        require(pipe(blocked) == 0, "idle writer pipe");
        char path[80];
        snprintf(path, sizeof(path), "/proc/self/fd/%d", blocked[0]);
        ssize_t count = readlink(path, blocked_input, sizeof(blocked_input) - 1);
        require(count > 0 && count < (ssize_t)sizeof(blocked_input) - 1, "blocked pipe identity");
        dprintf(2, "BLOCKED_PIPE %s supervisor_writer=%d target_reader=0\n", blocked_input, blocked[1]);
    }
    int notification[2];
    require(pipe(notification) == 0, "notification pipe");
    pid_t tracer = fork();
    require(tracer >= 0, "tracer fork");
    if (!tracer) {
        close(notification[0]);
        if (raw_mode) {
            close(output[0]);
            require(dup2(output[1], 1) == 1, "raw target pipe");
            close(output[1]);
        }
        if (blocked[0] >= 0) {
            require(dup2(blocked[0], 0) == 0, "blocked read endpoint");
            close(blocked[0]);
            close(blocked[1]);
        }
        trace(argv[1], notification[1]);
    }
    if (raw_mode) close(output[1]);
    target = tracer;
    if (blocked[0] >= 0) close(blocked[0]);
    close(notification[1]);
    drop();
    status(getpid());
    NoticeOutcome outcome = supervise_notices(notification[0], tracer, raw_mode != NULL,
                                               raw_is("death") || !strcmp(argv[1], "death"), &native_io);
    close(notification[0]);
    target = 0;
    if (outcome.expired) dprintf(2, "SUPERVISOR_DEADLINE\n");
    require(outcome.valid, "supervisor notices and cleanup");
    dprintf(2, "NOTICE_RECEIPT root=%d ready=%d\n", outcome.receipt.root, outcome.receipt.ready);
    dprintf(2, "TRACER_TERMINAL %d wait_status=%d\n", tracer, outcome.state);
    dprintf(2, "REAPED %d SUPERVISOR %d\n", outcome.receipt.root, getpid());
    if (raw_mode) {
        if (blocked[1] >= 0) close(blocked[1]);
        unsigned char bytes[32];
        ssize_t count = read(output[0], bytes, sizeof(bytes));
        require(count >= 0 && count < (ssize_t)sizeof(bytes), "bounded target output");
        dprintf(2, "TARGET_BYTES %zd ", count);
        for (ssize_t i = 0; i < count; i++) dprintf(2, "%02x", bytes[i]);
        dprintf(2, "\n");
        require(read(output[0], bytes, 1) == 0, "target output complete");
        close(output[0]);
    }
    delay(3000);
    return 0;
}
