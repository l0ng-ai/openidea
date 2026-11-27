#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* FNV-1a 64-bit, one byte at a time: enough of a call stack to inspect. */
static uint64_t mix(uint64_t h, unsigned char byte) {
    h ^= byte;
    h *= 1099511628211ULL;
    return h;
}

static uint64_t hash(uint64_t h, const char *s) {
    for (; *s; s++) {
        h = mix(h, (unsigned char)*s);
    }
    return h;
}

int main(void) {
    const char *fixture = getenv("OPENIDEA_GDB_FIXTURE");
    int environment_ok = getenv("PATH") != NULL && fixture != NULL && strcmp(fixture, "present") == 0;
    const char *words[] = {"openidea", "gdb", "dap"};
    uint64_t hashes[3];
    for (int i = 0; i < 3; i++) {
        hashes[i] = hash(1469598103934665603ULL, words[i]);
    }
    uint64_t value = hashes[0];
    // Set a breakpoint here (QA: debugger) and inspect `value`.
    value = hash(1469598103934665603ULL, words[2]);
    printf("%s %016llx\n", words[2], (unsigned long long)value);
    return environment_ok ? 0 : 1;
}
