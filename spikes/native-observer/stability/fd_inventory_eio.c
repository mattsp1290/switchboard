#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

struct dirent *__real_readdir(DIR *dir);

struct dirent *__wrap_readdir(DIR *dir) {
    static DIR *inventory;
    static unsigned stdio_seen;
    static int injected;
    if (!inventory) inventory = dir;
    if (dir == inventory && stdio_seen == 7 && !injected) {
        injected = 1;
        dprintf(2, "FD_INVENTORY_INJECTED_EIO stdio=7\n");
        errno = EIO;
        return NULL;
    }
    struct dirent *entry = __real_readdir(dir);
    if (dir == inventory && entry) {
        for (unsigned fd = 0; fd < 3; fd++) {
            char name[] = {(char)('0' + fd), 0};
            if (!strcmp(entry->d_name, name)) stdio_seen |= 1U << fd;
        }
    }
    return entry;
}
