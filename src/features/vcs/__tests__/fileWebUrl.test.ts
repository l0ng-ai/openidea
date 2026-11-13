import { describe, expect, it } from "vitest";
import { fileWebUrl, remoteHosting } from "../model";

describe("remoteHosting", () => {
  it.each([
    ["git@github.com:o/r.git", "GitHub", "github"],
    ["https://github.example.com/o/r", "GitHub", "github"],
    ["https://gitee.com/o/r.git", "Gitee", "github"],
    ["git@bitbucket.org:o/r.git", "Bitbucket", "bitbucket"],
    ["ssh://git@gitlab.example.com:2222/group/sub/r.git", "GitLab", "gitlab"],
    ["git@git.example.com:group/r.git", "git.example.com", "gitlab"],
  ])("%s → %s", (url, name, kind) => {
    expect(remoteHosting(url)).toEqual({ name, kind });
  });

  it("has none for a local remote", () => {
    expect(remoteHosting("/srv/git/r.git")).toBeNull();
  });
});

describe("fileWebUrl", () => {
  it("opens a file at a line on GitHub", () => {
    expect(fileWebUrl("git@github.com:o/r.git", "main", "src/a b.ts", { line: 9 })).toBe(
      "https://github.com/o/r/blob/main/src/a%20b.ts#L10",
    );
  });

  it("keeps a branch's slashes and opens directories as trees", () => {
    expect(fileWebUrl("git@github.com:o/r.git", "feature/x", "src", { dir: true, line: 3 })).toBe(
      "https://github.com/o/r/tree/feature/x/src",
    );
  });

  it("uses GitLab's /-/ routes, including subgroups", () => {
    expect(fileWebUrl("ssh://git@gitlab.example.com:2222/group/sub/r.git", "abc123", "docs/中文.md", { line: 0 })).toBe(
      "https://gitlab.example.com/group/sub/r/-/blob/abc123/docs/%E4%B8%AD%E6%96%87.md#L1",
    );
    expect(fileWebUrl("git@gitlab.com:g/r.git", "main", "", { dir: true })).toBe("https://gitlab.com/g/r/-/tree/main");
  });

  it("uses Bitbucket's /src/ routes", () => {
    expect(fileWebUrl("git@bitbucket.org:o/r.git", "main", "a.py", { line: 4 })).toBe(
      "https://bitbucket.org/o/r/src/main/a.py#lines-5",
    );
  });
});
