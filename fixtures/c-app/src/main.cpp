#include <iostream>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static std::string banner(const std::string &project, int n) {
    return project + " #" + std::to_string(n);
}

int main() {
    const char *fixture = std::getenv("OPENIDEA_GDB_FIXTURE");
    int environment_ok = std::getenv("PATH") != nullptr && fixture != nullptr && std::strcmp(fixture, "present") == 0;
    std::vector<std::string> log;
    for (int i = 1; i <= 3; i++) {
        log.push_back(banner("openidea", i));
    }
    std::string line;
    // Set a breakpoint here (QA: debugger) and inspect `line`.
    line = banner("openidea", 3);
    std::cout << line << "\n";
    return environment_ok ? 0 : 1;
}
