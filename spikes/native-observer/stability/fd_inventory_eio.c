#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

DIR *__real_opendir(const char *path);
struct dirent *__real_readdir(DIR *dir);
int __real_closedir(DIR *dir);
int __real_kill(pid_t pid, int signal);
pid_t __real_waitpid(pid_t pid, int *status, int flags);
_Noreturn void __real__exit(int code);

static const struct control {
    const char *name;
    unsigned mask;
    int error, plant_open, plant_entry, close_error;
} controls[] = {
    {"normal-first", 0, EIO, 0, 0, 0},
    {"normal-stdio", 7, EIO, 0, 0, EACCES},
    {"inherited-before9", 7, EINTR, 0, 0, EACCES},
    {"inherited-after9", 15, EBADF, 0, 0, 0},
    {"normal-open", 0, 0, EIO, 0, 0},
    {"normal-entry", 0, 0, 0, EIO, EACCES},
    {"inherited-open", 0, 0, EIO, 0, 0},
    {"inherited-entry", 0, 0, 0, EIO, EACCES}
};
static const struct control *control;
static const char *selector;
static DIR *inventory;
static pid_t tracer;
static unsigned mask, reads, closes, terminal, kills, waits;

static int selected(void) {
    int saved = errno;
    selector = getenv("FD_INVENTORY_CASE");
    if (selector && !control) {
        const char *name = strchr(selector, '/');
        if (name && ((!strncmp(selector, "raw/", 4)) || !strncmp(selector, "prerequisite/", 13))) {
            for (unsigned i = 0; i < sizeof(controls) / sizeof(*controls); i++) {
                if (!strcmp(name + 1, controls[i].name)) control = &controls[i];
            }
        }
        if (!control) {
            dprintf(2, "FD_INVALID selector\n");
            __real__exit(91);
        }
    }
    errno = saved;
    return selector != NULL;
}

DIR *__wrap_opendir(const char *path) {
    if (!selected()) return __real_opendir(path);
    DIR *result = __real_opendir(path);
    int saved = errno, pid = 0, end = 0;
    char canonical[80];
    int parsed = sscanf(path, "/proc/%d/fd%n", &pid, &end);
    snprintf(canonical, sizeof(canonical), "/proc/%d/fd", pid);
    if (inventory || parsed != 1 || !end || path[end] || pid <= 0 || strcmp(path, canonical)) {
        dprintf(2, "FD_INVALID open\n");
    }
    inventory = result;
    tracer = getpid();
    dprintf(2, "FD_OPEN case=%s actor=%d parent=%d target=%d dir=0x%lx result=%d error=%d planted=%d\n",
            selector, tracer, getppid(), pid, (unsigned long)result, result != NULL, saved,
            result ? control->plant_open : 0);
    errno = result && control->plant_open ? control->plant_open : saved;
    return result;
}

struct dirent *__wrap_readdir(DIR *dir) {
    if (!selected()) return __real_readdir(dir);
    int incoming = errno;
    if (dir != inventory || !inventory) dprintf(2, "FD_INVALID read\n");
    unsigned ordinal = ++reads;
    int injected = control->error && !terminal && mask == control->mask;
    struct dirent *entry;
    if (injected) {
        errno = control->error;
        entry = NULL;
    } else {
        errno = incoming;
        entry = __real_readdir(dir);
    }
    int saved = errno;
    if (entry) {
        for (unsigned fd = 0; fd < 3; fd++) {
            char name[] = {(char)('0' + fd), 0};
            if (!strcmp(entry->d_name, name)) mask |= 1U << fd;
        }
        if (!strcmp(entry->d_name, "9")) mask |= 8;
    } else if (!terminal) {
        terminal = ordinal;
    }
    int planted = entry ? control->plant_entry : 0;
    dprintf(2, "FD_READ case=%s actor=%d dir=0x%lx ordinal=%u input=%d name=%s mask=%u error=%d injected=%d planted=%d\n",
            selector, getpid(), (unsigned long)dir, ordinal, incoming, entry ? entry->d_name : "NULL",
            mask, saved, injected, planted);
    errno = planted ? planted : saved;
    return entry;
}

int __wrap_closedir(DIR *dir) {
    if (!selected()) return __real_closedir(dir);
    int incoming = errno;
    if (dir != inventory || !inventory) dprintf(2, "FD_INVALID close\n");
    unsigned long identity = (unsigned long)dir;
    int result = __real_closedir(dir);
    int saved = errno;
    closes++;
    dprintf(2, "FD_CLOSE case=%s actor=%d dir=0x%lx reads=%u closes=%u terminal=%u input=%d result=%d error=%d output=%d\n",
            selector, getpid(), identity, reads, closes, terminal, incoming, result, saved, control->close_error);
    errno = control->close_error;
    return result;
}

int __wrap_kill(pid_t pid, int signal) {
    if (!selected()) return __real_kill(pid, signal);
    int result = __real_kill(pid, signal);
    int saved = errno;
    kills++;
    dprintf(2, "FD_KILL case=%s actor=%d target=%d signal=%d result=%d error=%d\n",
            selector, getpid(), pid, signal, result, saved);
    errno = saved;
    return result;
}

pid_t __wrap_waitpid(pid_t pid, int *status, int flags) {
    if (!selected()) return __real_waitpid(pid, status, flags);
    pid_t result = __real_waitpid(pid, status, flags);
    int saved = errno;
    if (result != 0) {
        waits++;
        dprintf(2, "FD_WAIT case=%s actor=%d target=%d flags=%d result=%d error=%d status=%d\n",
                selector, getpid(), pid, flags, result, saved, result > 0 && status ? *status : -1);
    }
    errno = saved;
    return result;
}

_Noreturn void __wrap__exit(int code) {
    if (selected() && inventory && getpid() == tracer) {
        int saved = errno;
        dprintf(2, "FD_EXIT case=%s actor=%d code=%d reads=%u closes=%u terminal=%u mask=%u kills=%u waits=%u\n",
                selector, getpid(), code, reads, closes, terminal, mask, kills, waits);
        errno = saved;
    }
    __real__exit(code);
}
