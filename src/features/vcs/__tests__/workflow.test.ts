import { describe, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";
import { messageProblems, wrapAtMargin } from "../CommitView";
import { linkifyIssues } from "../issueLinks";
import {
  defaultPushChecked,
  isProtectedBranch,
  isPushRejected,
  pushCandidates,
  pushRepoCommits,
  type RepoPush,
} from "../remoteUi";
import { attentionRepo } from "../store";
import { statusDecorations } from "../model";

const vcsLog = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
    },
  };
});

const cfg = { blankLineAfterSubject: true, limitSubject: true, subjectLimit: 10, limitBody: true, bodyLimit: 8 };

describe("commit message inspections", () => {
  it("reports subject length, missing blank line and long body lines", () => {
    expect(messageProblems("short", cfg)).toEqual([]);
    expect(messageProblems("a subject that is long\nbody", cfg)).toEqual([
      "Subject line is longer than 10 characters",
      "Missing blank line between subject and body",
    ]);
    expect(messageProblems("ok\n\nthis body line is long", cfg)).toEqual(["Body line 3 is longer than 8 characters"]);
    expect(messageProblems("x".repeat(20), { ...cfg, limitSubject: false })).toEqual([]);
  });

  it("wraps body lines at the last space before the margin", () => {
    const text = "subject\n\nhello world again";
    expect(wrapAtMargin(text, text.length, 12)).toEqual({ text: "subject\n\nhello world\nagain", caret: text.length });
    expect(wrapAtMargin("a very long subject line", 5, 5)).toBeNull();
  });
});

describe("issue navigation", () => {
  it("links every match with $0 / $n substitution", () => {
    const links = [
      { pattern: "[A-Z]+-\\d+", link: "https://jira/browse/$0" },
      { pattern: "#(\\d+)", link: "https://gh/issues/$1" },
      { pattern: "(", link: "broken" },
    ];
    expect(linkifyIssues("Fix OPENIDEA-12 and #7.", links)).toEqual([
      "Fix ",
      { text: "OPENIDEA-12", url: "https://jira/browse/OPENIDEA-12" },
      " and ",
      { text: "#7", url: "https://gh/issues/7" },
      ".",
    ]);
  });
});

describe("git settings helpers", () => {
  it("matches protected branch globs", () => {
    expect(isProtectedBranch("main", "master; main")).toBe(true);
    expect(isProtectedBranch("release/1.2", "release/*")).toBe(true);
    expect(isProtectedBranch("feature", "master, main")).toBe(false);
  });

  it("recognises rejected pushes", () => {
    expect(isPushRejected(" ! [rejected]        main -> main (fetch first)")).toBe(true);
    expect(isPushRejected("Permission denied (publickey)")).toBe(false);
  });

  it("propagates folder colours only when enabled", () => {
    const status = [
      { path: "/p/src/a.ts", relPath: "src/a.ts", staged: null, unstaged: "modified" as const, renamedFrom: null },
    ];
    expect(statusDecorations(status).get("/p/src/a.ts")?.propagate).toBe(true);
    expect(statusDecorations(status, false).get("/p/src/a.ts")?.propagate).toBeUndefined();
  });
});

describe("several repositories", () => {
  it("selects a repository that just stopped in an operation", () => {
    expect(attentionRepo("/p", {}, { "/p/lib": "merge" })).toBe("/p/lib");
    expect(attentionRepo("/p", { "/p/lib": "merge" }, { "/p/lib": "merge" })).toBeNull();
    expect(attentionRepo("/p", {}, { "/p": "rebase", "/p/lib": "merge" })).toBeNull();
    expect(attentionRepo("/p", {}, {})).toBeNull();
  });

  it("lists repositories with something to push", () => {
    const branch = (head: string | null, upstream: string | null) => ({
      head,
      headCommit: "c1",
      upstream,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    const commit = { id: "c1", shortId: "c1" } as RepoPush["commits"][number];
    const repos: RepoPush[] = [
      { root: "/p", branch: branch("main", "origin/main"), commits: [commit] },
      { root: "/p/a", branch: branch("main", "origin/main"), commits: [] },
      { root: "/p/b", branch: branch("feature", null), commits: [commit] },
      { root: "/p/c", branch: branch(null, null), commits: [] },
    ];
    const candidates = pushCandidates(repos);
    expect(candidates.map((r) => r.root)).toEqual(["/p", "/p/b"]);
    expect([...defaultPushChecked(candidates, "/p")]).toEqual(["/p"]);
    expect([...defaultPushChecked(candidates, "/p/b")]).toEqual(["/p", "/p/b"]);
  });
});

describe("pushRepoCommits", () => {
  const branch = (head: string | null, upstream: string | null): BranchInfo => ({
    head,
    headCommit: "c1",
    upstream,
    ahead: 0,
    behind: 0,
    operation: null,
  });

  it("falls back to recent history when the upstream no longer resolves", async () => {
    vcsLog.mockImplementation((_repo: unknown, q: { range: string | null }) =>
      q.range === "@{u}..HEAD"
        ? Promise.resolve({
            status: "error",
            error: "fatal: ambiguous argument '@{u}..HEAD': unknown revision or path not in the working tree.",
          })
        : Promise.resolve({ status: "ok", data: [{ id: "c1" }] }),
    );
    await expect(pushRepoCommits("/p", branch("feature", "origin/feature"))).resolves.toEqual([{ id: "c1" }]);
    expect(vcsLog).toHaveBeenLastCalledWith("/p", expect.objectContaining({ branch: "HEAD", range: null, limit: 50 }));
  });

  it("passes the upstream range through when it resolves", async () => {
    vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [] });
    await pushRepoCommits("/p", branch("main", "origin/main"));
    expect(vcsLog).toHaveBeenCalledWith("/p", expect.objectContaining({ range: "@{u}..HEAD", limit: 1000 }));
  });

  it("lists no commits for a detached HEAD", async () => {
    vcsLog.mockClear();
    await expect(pushRepoCommits("/p", branch(null, null))).resolves.toEqual([]);
    expect(vcsLog).not.toHaveBeenCalled();
  });
});
