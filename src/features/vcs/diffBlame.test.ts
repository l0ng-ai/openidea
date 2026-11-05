import { describe, expect, it } from "vitest";
import { diffBlameTarget } from "./diffBlame";

describe("diffBlameTarget", () => {
  it("blames a revision on its own history, at the path it had there", () => {
    expect(diffBlameTarget({ type: "rev", rev: "abc123^" }, "/p/A.java", true)).toEqual({
      path: "/p/A.java",
      revision: "abc123^",
    });
    expect(diffBlameTarget({ type: "rev", rev: "abc123", path: "/p/Old.java" }, "/p/A.java", true)).toEqual({
      path: "/p/Old.java",
      revision: "abc123",
    });
  });

  it("blames the index on HEAD and the working file like the editor", () => {
    expect(diffBlameTarget({ type: "rev", rev: ":0" }, "/p/A.java", true)).toEqual({
      path: "/p/A.java",
      revision: "HEAD",
    });
    expect(diffBlameTarget({ type: "worktree" }, "/p/A.java", true)).toEqual({ path: "/p/A.java" });
  });

  it("offers nothing for content outside Git", () => {
    for (const side of [
      { type: "file", path: "/p/B.java" },
      { type: "text", text: "x", label: "Clipboard" },
      { type: "history", id: "1", label: "Local History" },
    ] as const)
      expect(diffBlameTarget(side, "/p/A.java", true)).toBeNull();
    expect(diffBlameTarget({ type: "worktree" }, "/p/A.java", false)).toBeNull();
  });
});
