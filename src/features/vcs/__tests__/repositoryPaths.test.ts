import { describe, expect, it } from "vitest";
import { repositoryPath } from "../repositoryPaths";

describe("repository-relative paths", () => {
  it.each([
    ["/repo", "src/a.txt", "/repo/src/a.txt"],
    ["/project/项目A", "src/a.txt", "/project/项目A/src/a.txt"],
    ["/project/repoB/", "src/a.txt", "/project/repoB/src/a.txt"],
    ["/repo", "subproject/a.txt", "/repo/subproject/a.txt"],
    ["C:\\project\\项目A", "src\\a.txt", "C:/project/项目A/src/a.txt"],
    ["C:/project/repoB", "src\\a.txt", "C:/project/repoB/src/a.txt"],
    ["C:\\", "a.txt", "C:/a.txt"],
    ["\\\\server\\share\\repo", "src\\a.txt", "//server/share/repo/src/a.txt"],
    ["\\\\?\\C:\\repo", "src\\a.txt", "C:/repo/src/a.txt"],
    ["/", "a.txt", "/a.txt"],
    ["/repo", "src/a\\b.txt", "/repo/src/a\\b.txt"],
    [null, "src/a.txt", "src/a.txt"],
  ])("%s + %s → %s", (root, path, expected) => {
    expect(repositoryPath(root, path)).toBe(expected);
  });
});
