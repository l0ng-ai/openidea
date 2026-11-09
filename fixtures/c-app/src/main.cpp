#include <iostream>
#include <string>
#include <vector>

static std::string banner(const std::string &project, int n) {
    return project + " #" + std::to_string(n);
}

int main() {
    std::vector<std::string> log;
    for (int i = 1; i <= 3; i++) {
        log.push_back(banner("openidea", i));
    }
    std::string line;
    // Set a breakpoint here (QA: debugger) and inspect `line`.
    line = banner("openidea", 3);
    std::cout << line << "\n";
    return 0;
}
