import { describe, expect, it } from "vitest";
import { cloneDirName, joinPath, parseCloneDepth, validateClone } from "../clone";
import { outgoingQuery } from "../remoteUi";

describe("cloneDirName", () => {
  it("derives the folder git would create", () => {
    expect(cloneDirName("https://github.com/user/repo.git")).toBe("repo");
    expect(cloneDirName("https://github.com/user/repo")).toBe("repo");
    expect(cloneDirName("https://github.com/user/repo/")).toBe("repo");
    expect(cloneDirName("git@github.com:user/my-lib.git")).toBe("my-lib");
    expect(cloneDirName("ssh://git@host:2222/group/sub/proj.git")).toBe("proj");
    expect(cloneDirName("/srv/git/local.git/")).toBe("local");
    expect(cloneDirName("https://host/a/b.git?ref=x")).toBe("b");
    expect(cloneDirName("  ")).toBe("");
  });
});

describe("joinPath / validateClone", () => {
  it("joins with a single separator", () => {
    expect(joinPath("/Users/me/dev/", "repo")).toBe("/Users/me/dev/repo");
    expect(joinPath("", "repo")).toBe("repo");
    expect(joinPath("/x", "")).toBe("/x");
  });
  it("requires a URL and an absolute directory", () => {
    expect(validateClone("", "/a")).toMatch(/URL/);
    expect(validateClone("--upload-pack=x", "/a")).toMatch(/Invalid/);
    expect(validateClone("https://h/r a", "/a")).toMatch(/spaces/);
    expect(validateClone("https://h/r", "")).toMatch(/directory/i);
    expect(validateClone("https://h/r", "rel/dir")).toMatch(/absolute/);
    expect(validateClone("https://h/r", "/abs/r")).toBeNull();
  });
});

describe("parseCloneDepth", () => {
  it("accepts positive Git depths only", () => {
    expect(parseCloneDepth("1")).toBe(1);
    expect(parseCloneDepth(" 25 ")).toBe(25);
    expect(parseCloneDepth("0")).toBeNull();
    expect(parseCloneDepth("1.5")).toBeNull();
    expect(parseCloneDepth("abc")).toBeNull();
    expect(parseCloneDepth("4294967296")).toBeNull();
  });
});

describe("outgoingQuery", () => {
  it("uses the upstream range when tracked", () => {
    expect(outgoingQuery("origin/main")).toEqual({ branch: "HEAD", range: "@{u}..HEAD", limit: 1000 });
    expect(outgoingQuery(null).range).toBeNull();
  });
});
