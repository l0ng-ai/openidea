import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit, LogQuery } from "@/bindings";
const log = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: string | null, query: LogQuery) => log(repo, query),
      vcsBranchInfo: () => Promise.resolve({ status: "ok", data: { upstream: null } }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});
import { commitKey, graphCommit, mergeRepoLogs, type RepoCommit } from "../multiRoot";
import { buildRepositoryBranchTree } from "../branches";
import {
  emptyFilters,
  installGitLog,
  loadMore,
  openLogTab,
  PAGE,
  reloadLog,
  selectCommit,
  selectedCommits,
  selectGitTab,
  toggleCommitSelection,
  useGitLog,
} from "../logStore";
import { useVcs } from "../store";
import { commitFileDiffData } from "../diffInput";

const commit = (id: string, timeMs = 0): Commit => ({
  id,
  shortId: id,
  parents: [],
  refs: [],
  author: "a",
  email: "a@test",
  summary: id,
  message: id,
  timeMs,
});
const branch = (name: string, remote = false): Branch => ({
  name,
  remote,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "same",
});

beforeEach(() => {
  useVcs.setState({ root: "/project", roots: ["/project/front", "/project/back"], repo: "/project/front" });
  useGitLog.setState({
    filters: emptyFilters(),
    commits: [],
    done: false,
    selection: [],
    selected: null,
    shownLog: "log",
    tab: "log",
    logTabs: [],
    generation: useGitLog.getState().generation + 1,
  });
  log.mockReset().mockResolvedValue({ status: "ok", data: [] });
});

describe("multi-root Git log", () => {
  it("merges streams by time without violating each root's topological order", () => {
    const child = { ...commit("child", 1), repo: "a", parents: ["parent"] };
    const parent = { ...commit("parent", 100), repo: "a" };
    const other = { ...commit("other", 50), repo: "b" };
    expect(mergeRepoLogs([[child, parent], [other]], 3)).toEqual([other, child, parent]);
    expect(graphCommit(child).parents).toEqual([commitKey(parent)]);
  });

  it("keeps identical SHAs distinct in selection and file paths", () => {
    const front = { ...commit("same"), repo: "/project/front" };
    const back = { ...commit("same"), repo: "/project/back" };
    useGitLog.setState({ commits: [front, back] });
    selectCommit(commitKey(front));
    expect(selectedCommits()).toEqual([front]);
    toggleCommitSelection(commitKey(back));
    expect(selectedCommits()).toEqual([back]);
    expect(commitFileDiffData(back, { path: "main.ts", oldPath: null, kind: "added" }).path).toBe(
      "/project/back/main.ts",
    );
  });

  it("pages each root by the number of its emitted commits, without gaps or duplicates", async () => {
    const data: Record<string, Commit[]> = Object.fromEntries(
      useVcs
        .getState()
        .roots.map((r, index) => [
          r,
          Array.from({ length: PAGE + 5 }, (_, i) => commit(`${index}-${i}`, 10000 - i * 2 - index)),
        ]),
    );
    log.mockImplementation(async (repo: string, q: LogQuery) => ({
      status: "ok",
      data: data[repo]!.slice(q.skip, q.skip + q.limit),
    }));
    await reloadLog();
    expect(useGitLog.getState().commits).toHaveLength(PAGE);
    await loadMore();
    await loadMore();
    const rows = useGitLog.getState().commits;
    expect(rows).toHaveLength((PAGE + 5) * 2);
    expect(new Set(rows.map(commitKey)).size).toBe(rows.length);
    expect(rows.map((c) => c.timeMs)).toEqual([...rows.map((c) => c.timeMs)].sort((a, b) => b! - a!));
  });

  it("filters repositories and keeps history tabs pinned when the selected root changes", async () => {
    log.mockImplementation(async () => ({ status: "ok", data: [commit("same")] }));
    useGitLog.setState({ filters: { ...emptyFilters(), repositories: ["/project/back"] } });
    await reloadLog();
    expect((useGitLog.getState().commits as RepoCommit[]).map((c) => c.repo)).toEqual(["/project/back"]);
    const off = installGitLog();
    const id = openLogTab("history", "/project/back/main.ts");
    await reloadLog();
    useVcs.setState({ repo: "/project/front" });
    selectGitTab("log");
    useVcs.setState({ repo: "/project/back" });
    selectGitTab(id);
    expect(useGitLog.getState().filters.path).toBe("/project/back/main.ts");
    expect((useGitLog.getState().commits as RepoCommit[])[0]?.repo).toBe("/project/back");
    off();
  });

  it("groups identical local and remote names under distinct repository nodes", () => {
    const roots = buildRepositoryBranchTree(
      ["front", "back"].map((name) => ({
        root: `/project/${name}`,
        name,
        branches: [branch("main"), branch("origin/main", true)],
        tags: ["v1"],
      })),
      [],
    );
    for (const group of roots.filter((r) => r.kind === "group")) {
      expect(group.children?.map((c) => c.label)).toEqual(["front", "back"]);
      const children = group.children!.flatMap((r) => r.children!);
      expect(new Set(children.map((c) => c.key)).size).toBe(children.length);
      expect(children.map((c) => c.repo)).toEqual(["/project/front", "/project/back"]);
    }
  });
});
