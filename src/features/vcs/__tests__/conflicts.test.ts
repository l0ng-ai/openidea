import { describe, expect, it } from "vitest";
import { blockAt, initialResult, mergeTitles, parseConflicts, resolveAll, resolutionText } from "../conflicts";

const text = [
  "keep\n",
  "<<<<<<< HEAD\n",
  "ours 1\n",
  "ours 2\n",
  "||||||| base\n",
  "base\n",
  "=======\n",
  "theirs\n",
  ">>>>>>> feature\n",
  "tail\n",
  "<<<<<<< HEAD\n",
  "=======\n",
  "only theirs\n",
  ">>>>>>> feature\n",
].join("");

describe("parseConflicts", () => {
  it("parses diff3 and plain blocks", () => {
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(2);
    const [a, b] = blocks;
    expect(a).toMatchObject({
      ours: "ours 1\nours 2\n",
      base: "base\n",
      theirs: "theirs\n",
      oursLabel: "HEAD",
      theirsLabel: "feature",
    });
    expect(text.slice(a!.from, a!.to)).toMatch(/^<<<<<<< HEAD\n[\s\S]*>>>>>>> feature\n$/);
    expect(b).toMatchObject({ ours: "", base: null, theirs: "only theirs\n" });
    expect(blockAt(blocks, text.indexOf("theirs\n"))).toBe(a);
    expect(blockAt(blocks, 0)).toBeUndefined();
  });

  it("locates the marker lines, without their terminators", () => {
    const [a, b] = parseConflicts(text);
    const lines = (block: typeof a) => block!.markers.map((m) => text.slice(m.from, m.to));
    expect(lines(a)).toEqual(["<<<<<<< HEAD", "||||||| base", "=======", ">>>>>>> feature"]);
    expect(lines(b)).toEqual(["<<<<<<< HEAD", "=======", ">>>>>>> feature"]);
    const crlf = "<<<<<<< a\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n";
    expect(parseConflicts(crlf)[0]!.markers.map((m) => crlf.slice(m.from, m.to))).toEqual([
      "<<<<<<< a",
      "=======",
      ">>>>>>> b",
    ]);
  });

  it("ignores unterminated markers", () => {
    expect(parseConflicts("<<<<<<< HEAD\nx\n=======\ny\n")).toEqual([]);
  });

  it("resolves blocks", () => {
    expect(resolveAll(text, "ours")).toBe("keep\nours 1\nours 2\ntail\n");
    expect(resolveAll(text, "theirs")).toBe("keep\ntheirs\ntail\nonly theirs\n");
    const [a] = parseConflicts(text);
    expect(resolutionText(a!, "both")).toBe("ours 1\nours 2\ntheirs\n");
    expect(resolutionText(a!, "base")).toBe("base\n");
  });

  it("swaps sides during a rebase, where the user's commit is the >>>>>>> section", () => {
    expect(resolveAll(text, "ours", true)).toBe("keep\ntheirs\ntail\nonly theirs\n");
    expect(resolveAll(text, "theirs", true)).toBe("keep\nours 1\nours 2\ntail\n");
    const [a] = parseConflicts(text);
    expect(resolutionText(a!, "both", true)).toBe("theirs\nours 1\nours 2\n");
    expect(resolutionText(a!, "base", true)).toBe("base\n");
  });
});

describe("mergeTitles", () => {
  const sides = (operation: string | null, extra: Record<string, string | boolean | null> = {}) => ({
    operation,
    reversed: operation === "rebase",
    branch: "feature",
    commit: "abc12345",
    otherBranch: "main",
    ...extra,
  });
  it("names the sides like IDEA for each operation", () => {
    expect(mergeTitles(sides("rebase"))).toEqual({
      yours: "Rebasing abc12345 from feature",
      theirs: "Already rebased commits and commits from main",
    });
    expect(mergeTitles(sides("rebase", { otherBranch: null })).theirs).toBe("Already rebased commits");
    expect(mergeTitles(sides("merge"))).toEqual({ yours: "Changes from feature", theirs: "Changes from main" });
    expect(mergeTitles(sides("cherry-pick"))).toEqual({
      yours: "Local Changes",
      theirs: "Changes from cherry-pick abc12345",
    });
    expect(mergeTitles(sides("unstash"))).toEqual({
      yours: "Your uncommitted changes",
      theirs: "Changes from feature",
    });
    expect(mergeTitles(null)).toEqual({ yours: "Your version", theirs: "Theirs (incoming)" });
  });
});

describe("initialResult", () => {
  const merged = "a\n<<<<<<< yours\nmine\n||||||| base\nold\n=======\nhers\n>>>>>>> theirs\nz\n";

  it("replaces each conflict with its base text, without markers", () => {
    const { text, conflicts } = initialResult(merged);
    expect(text).toBe("a\nold\nz\n");
    expect(conflicts).toEqual([{ from: 2, to: 6, ours: "mine\n", base: "old\n", theirs: "hers\n" }]);
    expect(resolutionText(conflicts[0]!, "ours")).toBe("mine\n");
  });

  it("swaps marker sides written in git's order during a rebase", () => {
    const { conflicts } = initialResult(merged, true);
    expect(conflicts[0]).toMatchObject({ ours: "hers\n", theirs: "mine\n" });
  });

  it("keeps text without conflicts as is", () => {
    expect(initialResult("x\n")).toEqual({ text: "x\n", conflicts: [] });
  });
});
