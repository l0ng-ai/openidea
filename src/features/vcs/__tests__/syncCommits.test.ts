import { describe, expect, it } from "vitest";
import type { Commit } from "@/bindings";
import { syncRange, syncRow, syncSections, truncateSubject, type SyncBranch } from "../syncCommits";

const branch = (overrides: Partial<SyncBranch> = {}): SyncBranch => ({
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...overrides,
});

const commit = (overrides: Partial<Commit> = {}): Commit => ({
  id: "0123456789abcdef",
  shortId: "0123456",
  parents: [],
  author: "Ada Lovelace",
  email: "ada@example.com",
  committer: "Ada Lovelace",
  committerEmail: "ada@example.com",
  timeMs: 1_700_000_000_000,
  summary: "Fix the parser",
  message: "Fix the parser\n\nBody.",
  messageTruncated: false,
  refs: [],
  commitTimeMs: 1_700_000_000_000,
  ...overrides,
});

describe("syncSections", () => {
  it("lists only incoming commits when the branch is behind", () => {
    expect(syncSections(branch({ behind: 3 }))).toEqual([
      { direction: "incoming", count: 3, range: "main..origin/main" },
    ]);
  });

  it("lists only outgoing commits when the branch is ahead", () => {
    expect(syncSections(branch({ ahead: 2 }))).toEqual([
      { direction: "outgoing", count: 2, range: "origin/main..main" },
    ]);
  });

  it("lists incoming then outgoing when the branch has diverged", () => {
    expect(syncSections(branch({ behind: 3, ahead: 2 }))).toEqual([
      { direction: "incoming", count: 3, range: "main..origin/main" },
      { direction: "outgoing", count: 2, range: "origin/main..main" },
    ]);
  });

  it("has no section without an upstream, even with stale counts", () => {
    expect(syncSections(branch({ upstream: null, behind: 3, ahead: 2 }))).toEqual([]);
  });

  it("has no section for a detached HEAD", () => {
    expect(syncSections(branch({ branch: null, behind: 1 }))).toEqual([]);
  });

  it("has no section when both sides are in sync", () => {
    expect(syncSections(branch())).toEqual([]);
  });

  it("keeps only the direction a marker asked for", () => {
    const diverged = branch({ behind: 3, ahead: 2 });
    expect(syncSections(diverged, "incoming")).toEqual([
      { direction: "incoming", count: 3, range: "main..origin/main" },
    ]);
    expect(syncSections(diverged, "outgoing")).toEqual([
      { direction: "outgoing", count: 2, range: "origin/main..main" },
    ]);
  });

  it("asks a marker of a side with no commits for nothing", () => {
    expect(syncSections(branch({ ahead: 2 }), "incoming")).toEqual([]);
  });
});

describe("syncRange", () => {
  it("puts the upstream on the right for incoming commits and on the left for outgoing ones", () => {
    expect(syncRange("incoming", "feature/x", "origin/feature/x")).toBe("feature/x..origin/feature/x");
    expect(syncRange("outgoing", "feature/x", "origin/feature/x")).toBe("origin/feature/x..feature/x");
  });
});

describe("truncateSubject", () => {
  it("leaves a short subject as written", () => {
    expect(truncateSubject("Fix the parser")).toBe("Fix the parser");
  });

  it("collapses whitespace and trims the subject", () => {
    expect(truncateSubject("  Fix\n the\tparser  ")).toBe("Fix the parser");
  });

  it("cuts a long subject at the limit and marks the cut", () => {
    const subject = "a".repeat(100);
    const shortened = truncateSubject(subject, 20);
    expect(shortened).toHaveLength(20);
    expect(shortened.endsWith("…")).toBe(true);
    expect(shortened.slice(0, -1)).toBe("a".repeat(19));
  });
});

describe("syncRow", () => {
  it("shows the short hash, the subject and the author", () => {
    expect(syncRow(commit())).toEqual({
      id: "0123456789abcdef",
      hash: "0123456",
      subject: "Fix the parser",
      author: "Ada Lovelace",
    });
  });

  it("falls back to the first eight characters of an id without a short one", () => {
    expect(syncRow(commit({ shortId: "" })).hash).toBe("01234567");
  });

  it("uses the first line of the message when the summary is empty", () => {
    expect(syncRow(commit({ summary: "", message: "Only the message\n\nBody." })).subject).toBe("Only the message");
  });

  it("shortens a long subject", () => {
    expect(syncRow(commit({ summary: "word ".repeat(40) })).subject.endsWith("…")).toBe(true);
  });
});
