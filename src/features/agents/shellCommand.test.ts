import { describe, expect, it } from "vitest";
import { readOnlyCommand, splitLeadingCd } from "./shellCommand";

describe("splitLeadingCd", () => {
  it("takes the folder off the front", () => {
    expect(splitLeadingCd("cd /repo && git status")).toEqual({ command: "git status", dir: "/repo" });
    expect(splitLeadingCd(`cd "/my repo/" ; ls`)).toEqual({ command: "ls", dir: "/my repo" });
    expect(splitLeadingCd("cd /tmp")).toEqual({ command: "cd /tmp", dir: null });
  });
});

describe("readOnlyCommand", () => {
  it.each([
    ["git grep -n foo -- src", "search"],
    ["cd /repo && rg -n 'a|b' src | head -20", "search"],
    ["grep -rn foo src 2>/dev/null | wc -l", "search"],
    ["find . -name '*.ts' -not -path './node_modules/*'", "search"],
    ["sed -n 1,40p src/a.ts", "read"],
    ["cat a.ts; echo ---; head -5 b.ts", "read"],
    ["git diff --stat origin/main...HEAD", "read"],
    ["git -C ../other log --oneline -3", "read"],
    ["ls -la src && wc -l src/*.ts", "read"],
    ["git branch --show-current", "read"],
    ["git worktree list | head; grep -n x LICENSE | head", "search"],
    ["pgrep -fl openidea | head", "read"],
    ["FOO=1 cat a.ts 2>&1 | sort | uniq -c", "read"],
  ])("%s → %s", (command, kind) => {
    expect(readOnlyCommand(command)).toBe(kind);
  });

  it.each([
    "pnpm test",
    "cargo build",
    "git commit -m 'x'",
    "git branch -D old",
    "git worktree add ../x",
    "git stash -q",
    "git remote add up url",
    "sed -i '' 's/a/b/' a.ts",
    "sed -n 1p a.ts > out.txt",
    "grep foo a.ts >> log",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} ;",
    "cat a.ts | xargs rm",
    "echo $(rm -rf x)",
    "cat <<'EOF' > a.ts",
    "sort -o a.txt a.txt",
    "sleep 10 &",
    "rm -rf build",
    "",
  ])("%s may change something", (command) => {
    expect(readOnlyCommand(command)).toBeNull();
  });

  it("does not split on operators inside quotes", () => {
    expect(readOnlyCommand(`grep -n "a && rm -rf /" src`)).toBe("search");
    expect(readOnlyCommand(`echo 'x' ; rm a`)).toBeNull();
  });
});
