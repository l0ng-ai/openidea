import { beforeEach, describe, expect, it, vi } from "vitest";

const vcsLog = vi.fn();
const vcsConfigGet = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
      vcsConfigGet: (repo: unknown, key: string) => vcsConfigGet(repo, key),
    },
  };
});

import { collapseLinear, computeGraph, hideLongEdges, reachableFrom } from "../graph";
import { DEFAULT_LOG_OPTIONS, parseLogOptions, refLabels, setLogOptions, useLogOptions } from "../logOptions";
import { emptyFilters, goToRef, isMine, reloadLog, updateLogOptions, useGitLog } from "../logStore";
import { defaultWorktreePath, disabledMergeFlags, remoteBranchesOf, validateRemoteName } from "../gitMenuDialogs";
import type { Branch, Commit } from "@/bindings";

const c = (id: string, parents: string[] = [], refs: string[] = []) => ({ id, parents, refs });

describe("Collapse Linear Branches", () => {
  it("hides linear commits and links the remaining ones with dashed edges", () => {
    // m merges f3 into main; f1..f3 is a linear branch from base, b a commit on main.
    const commits = [
      c("t", ["m"], ["main"]),
      c("m", ["b", "f3"]),
      c("f3", ["f2"]),
      c("f2", ["f1"]),
      c("f1", ["base"]),
      c("b", ["base"]),
      c("base"),
    ];
    const { commits: shown, graph } = collapseLinear(commits, new Set());
    expect(shown.map((x) => x.id)).toEqual(["t", "m", "base"]);
    expect(graph.find((g) => g.id === "m")).toEqual({ id: "m", parents: ["base"], dashed: [true] });
    expect(graph.find((g) => g.id === "t")).toEqual({ id: "t", parents: ["m"] });
    const { rows } = computeGraph(graph);
    expect(rows[1]!.down.some((s) => s.dashed)).toBe(true);
    expect(rows[2]!.up.some((s) => s.dashed)).toBe(true);
  });

  it("keeps referenced and kept commits", () => {
    const commits = [c("d", ["c"]), c("c", ["b"], ["tag: v1"]), c("b", ["a"]), c("a")];
    expect(collapseLinear(commits, new Set()).commits.map((x) => x.id)).toEqual(["d", "c", "a"]);
    const chain = [c("e", ["d"]), c("d", ["c"]), c("c", ["b"]), c("b", ["a"]), c("a")];
    expect(collapseLinear(chain, new Set(["c"])).commits.map((x) => x.id)).toEqual(["e", "c", "a"]);
    expect(collapseLinear(chain, new Set()).commits.map((x) => x.id)).toEqual(["e", "a"]);
  });
});

describe("long edges", () => {
  it("hides the middle of a long straight lane and puts arrows on the stubs", () => {
    // t's parent p is 40 rows below; the commits in between sit in lane 0.
    const between = Array.from({ length: 40 }, (_, i) => c(`x${i}`, i < 39 ? [`x${i + 1}`] : []));
    const { rows } = computeGraph([c("t", ["p"]), ...between, c("p")]);
    const hidden = hideLongEdges(rows);
    // The x chain sits in lane 1; the edge t → p passes through lane 0.
    const lane0 = (r: (typeof rows)[number]) => r.up.concat(r.down).filter((s) => s.from === 0 && s.to === 0);
    expect(lane0(rows[20]!)).toHaveLength(2);
    expect(lane0(hidden[20]!)).toHaveLength(0);
    expect(hidden[20]!.lane).toBe(1);
    expect(hidden.some((r) => r.down.some((s) => s.arrow === "down"))).toBe(true);
    expect(hidden.some((r) => r.up.some((s) => s.arrow === "up"))).toBe(true);
    expect(hideLongEdges(rows.slice(0, 10))).toEqual(rows.slice(0, 10));
  });
});

describe("highlighting", () => {
  it("finds the loaded commits of the current branch", () => {
    const commits = [c("s", ["a"]), c("h", ["a"]), c("a", ["r"]), c("r")];
    expect([...reachableFrom(commits, "h")].sort()).toEqual(["a", "h", "r"]);
    expect(reachableFrom(commits, null).size).toBe(0);
  });

  it("matches my commits by email or name", () => {
    const commit = { email: "Me@Corp.test", author: "Me" } as Commit;
    expect(isMine(commit, "me@corp.test")).toBe(true);
    expect(isMine(commit, "me")).toBe(true);
    expect(isMine(commit, null)).toBe(false);
  });
});

describe("reference labels", () => {
  const remotes = new Set(["origin/main", "origin/feat/x"]);
  const refs = ["HEAD", "main", "origin/main", "feat/x", "tag: v1", "tag: v2"];

  it("merges a branch with its remote-tracking branches in the compact view", () => {
    const labels = refLabels(refs, { compact: true, tagNames: false }, remotes);
    expect(labels.map((l) => [l.kind, l.text])).toEqual([
      ["local", "origin & main"],
      ["local", "feat/x"],
      ["tag", ""],
    ]);
    expect(labels[2]!.title).toBe("v1, v2");
  });

  it("lists every reference otherwise", () => {
    const labels = refLabels(refs, { compact: false, tagNames: true }, remotes);
    expect(labels.map((l) => l.text)).toEqual(["HEAD", "main", "feat/x", "origin/main", "v1", "v2"]);
  });
});

describe("log options", () => {
  beforeEach(() => {
    vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vcsConfigGet.mockReset().mockResolvedValue({ status: "ok", data: null });
    useLogOptions.setState(DEFAULT_LOG_OPTIONS);
  });

  it("parses stored options with per-field defaults", () => {
    expect(parseLogOptions(null)).toEqual(DEFAULT_LOG_OPTIONS);
    expect(parseLogOptions({ sort: "topo", longEdges: true, showHash: "yes" })).toEqual({
      ...DEFAULT_LOG_OPTIONS,
      sort: "topo",
      longEdges: true,
    });
  });

  it("previews the selected file's diff by default and remembers turning it off", () => {
    expect(DEFAULT_LOG_OPTIONS.diffPreview).toBe(true);
    expect(parseLogOptions({ diffPreview: false }).diffPreview).toBe(false);
    expect(setLogOptions({ diffPreview: false })).toBe(false);
  });

  it("reloads only for options that change the query", () => {
    expect(setLogOptions({ compactRefs: false })).toBe(false);
    expect(setLogOptions({ noMerges: true })).toBe(true);
    expect(JSON.parse(localStorage.getItem("openidea.vcs.logOptions")!).noMerges).toBe(true);
  });

  it("sends the graph options and the date range to the backend", async () => {
    useGitLog.setState({ filters: { ...emptyFilters(), date: { after: 1000, before: 5000, label: "x" } } });
    updateLogOptions({ sort: "topo", firstParent: true });
    await reloadLog();
    const q = vcsLog.mock.calls.map((x) => x[1] as Record<string, unknown>).find((x) => x.range === null)!;
    expect(q).toMatchObject({ order: "topo", firstParent: true, noMerges: false, sinceMs: 1000, untilMs: 5000 });
  });

  it("goes to a reference by resolving it and selecting the commit", async () => {
    const commit = { id: "abc123", parents: [], refs: [], summary: "s", message: "s" } as unknown as Commit;
    vcsLog.mockImplementation(async (_r: unknown, q: { branch: string | null }) => ({
      status: "ok",
      data: q.branch === "v1" || q.branch === null ? [commit] : [],
    }));
    useGitLog.setState({ filters: emptyFilters(), commits: [], done: false });
    expect(await goToRef("v1")).toBe(true);
    expect(useGitLog.getState().selected).toBe("abc123");
    expect(await goToRef("nope")).toBe(false);
  });
});

describe("Git menu dialogs", () => {
  it("disables merge flags git refuses together", () => {
    expect([...disabledMergeFlags(new Set(["ffOnly"]))].sort()).toEqual(["noCommit", "noFf", "squash"]);
    expect(disabledMergeFlags(new Set(), true).size).toBe(4);
    expect(disabledMergeFlags(new Set()).size).toBe(0);
  });

  it("lists a remote's branches without its prefix", () => {
    const b = (name: string, remote: boolean) => ({ name, remote, current: false }) as Branch;
    const branches = [b("main", false), b("origin/main", true), b("origin/HEAD", true), b("fork/dev", true)];
    expect(remoteBranchesOf(branches, "origin")).toEqual(["main"]);
  });

  it("validates remote names", () => {
    expect(validateRemoteName("origin", ["origin"])).toMatch(/already exists/);
    expect(validateRemoteName("my remote", [])).toBe("Invalid remote name");
    expect(validateRemoteName("", [])).toBe("Enter a remote name");
    expect(validateRemoteName("upstream", ["origin"])).toBeNull();
  });

  it("suggests a worktree folder next to the repository", () => {
    expect(defaultWorktreePath("/src/app", "feature/x")).toBe("/src/app-feature-x");
    expect(defaultWorktreePath("/src/app/", "main")).toBe("/src/app-main");
    expect(defaultWorktreePath("C:\\src\\app", "fix")).toBe("C:\\src\\app-fix");
  });
});
