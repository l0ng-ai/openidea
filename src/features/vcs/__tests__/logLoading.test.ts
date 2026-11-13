import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, LogQuery } from "@/bindings";

const api = vi.hoisted(() => ({ log: vi.fn(), refs: vi.fn(), cancel: vi.fn(), choose: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: string | null, query: LogQuery) => api.log(repo, query),
      vcsLogRefs: () => api.refs(),
      cancelRequest: (id: number) => api.cancel(id),
      vcsBranches: () => Promise.resolve({ status: "ok", data: [] }),
      vcsBranchInfo: () => Promise.resolve({ status: "ok", data: { upstream: null } }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
      vcsOpenExternalLog: (repo: string) => Promise.resolve({ status: "ok", data: repo }),
    },
  };
});
vi.mock("../CommitChooser", () => ({ chooseLogCommit: (commits: Commit[]) => api.choose(commits) }));

import { commitKey } from "../multiRoot";
import { useVcs } from "../store";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import {
  displayedLogGraph,
  emptyFilters,
  extendCommitSelection,
  goToChild,
  goToParent,
  goToRef,
  logState,
  openLogTab,
  selectGitTab,
  PAGE,
  reloadLog,
  revealCommit,
  setLogBranches,
  toggleCommitSelection,
  updateLogOptions,
  useGitLog,
} from "../logStore";

const c = (id: string, parents: string[] = [], refs: string[] = []): Commit => ({
  id,
  shortId: id,
  parents,
  refs,
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary: id,
  message: id,
});
const ok = <T>(data: T) => ({ status: "ok" as const, data });

beforeEach(() => {
  api.log.mockReset().mockResolvedValue(ok([]));
  api.refs.mockReset().mockResolvedValue(ok({}));
  api.cancel.mockReset().mockResolvedValue(undefined);
  api.choose.mockReset().mockImplementation(async (commits: Commit[]) => commits[1]);
  useVcs.setState({ root: "/repo", repo: "/repo", roots: ["/repo"], branches: [] });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    logTabs: [],
    filters: emptyFilters(),
    commits: [],
    selection: [],
    selected: null,
    done: false,
    fragments: { expanded: new Set(), collapsed: new Set(), merges: new Set() },
    generation: useGitLog.getState().generation + 1,
  });
});

afterEach(async () => {
  api.log.mockResolvedValue(ok([]));
  await reloadLog();
});

describe("incremental log refresh", () => {
  it("lets an inactive visible scope finish its own request without cancelling the active scope", async () => {
    let finish!: (value: ReturnType<typeof ok<Commit[]>>) => void;
    api.log.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const main = reloadLog();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const request = api.log.mock.lastCall![1].request;
    const other = openLogTab("log", "Other");
    api.log.mockResolvedValue(ok([c("other")]));
    await reloadLog();
    finish(ok([c("main")]));
    await main;
    expect(api.cancel).not.toHaveBeenCalledWith(request);
    expect(logState("log").commits[0]!.id).toBe("main");
    expect(logState(other).commits[0]!.id).toBe("other");
    selectGitTab("log");
    expect(useGitLog.getState().commits[0]!.id).toBe("main");
  });
  it("joins a proven linear prefix and refreshes decorations without dropping loaded history", async () => {
    useGitLog.setState({ filters: { ...emptyFilters(), branches: ["HEAD"] } });
    api.log.mockResolvedValue(ok([c("old", ["base"], ["HEAD", "main"]), c("base")]));
    await reloadLog();
    api.log.mockResolvedValue(ok([c("new", ["old"], ["HEAD", "main"]), c("old", ["base"])]));
    api.refs.mockResolvedValue(ok({ HEAD: "new", main: "new", "tag: v1": "base" }));
    await reloadLog({ preserve: true });
    expect(api.log.mock.lastCall?.[1]).toMatchObject({ stopAt: "old", skip: 0 });
    expect(useGitLog.getState().commits.map((c) => [c.id, c.refs])).toEqual([
      ["new", ["HEAD", "main"]],
      ["old", []],
      ["base", ["tag: v1"]],
    ]);
    expect(useGitLog.getState().done).toBe(true);
  });

  it("fetches a full replacement when the prefix introduces a merge", async () => {
    useGitLog.setState({ filters: { ...emptyFilters(), branches: ["HEAD"] } });
    api.log.mockResolvedValue(ok([c("old"), c("stale")]));
    await reloadLog();
    const replacement = [c("merge", ["old", "side"]), c("side", ["old"]), c("old")];
    api.log.mockResolvedValue(ok(replacement));
    await reloadLog({ preserve: true });
    expect(api.log.mock.calls.slice(-2).map((call) => call[1].stopAt)).toEqual(["old", null]);
    expect(useGitLog.getState().commits.map((c) => c.id)).toEqual(["merge", "side", "old"]);
  });

  it("intersects repository and path filters and clears rows for an empty intersection", async () => {
    useVcs.setState({ roots: ["/repo/front", "/repo/back"] });
    useGitLog.setState({
      filters: { ...emptyFilters(), paths: ["/repo/front/a", "/repo/back/b"], repositories: ["/repo/back"] },
    });
    api.log.mockResolvedValue(ok([c("back")]));
    await reloadLog();
    expect(api.log.mock.lastCall).toEqual([
      "/repo/back",
      expect.objectContaining({ paths: ["/repo/back/b"], authorsExact: true }),
    ]);
    api.log.mockClear();
    useGitLog.setState({ filters: { ...emptyFilters(), path: "/repo/front/a", repositories: ["/repo/back"] } });
    await reloadLog({ preserve: true });
    expect(api.log).not.toHaveBeenCalled();
    expect(useGitLog.getState().commits).toEqual([]);
    expect(useGitLog.getState().error).toBeNull();
  });

  it("keeps multi-path filters scoped to their owning external repositories", async () => {
    useVcs.setState({ root: null, repo: null, roots: [] });
    openLogTab("external", "/a", "toolWindow", ["/a", "/b", "/c"]);
    useGitLog.setState({ filters: { ...emptyFilters(), paths: ["/a/src", "/b/test"] } });
    await reloadLog();
    expect(api.log.mock.calls).toEqual([
      ["/a", expect.objectContaining({ paths: ["/a/src"] })],
      ["/b", expect.objectContaining({ paths: ["/b/test"] })],
    ]);
    api.log.mockClear();
    useGitLog.setState({ filters: { ...emptyFilters(), path: "/outside/file" } });
    await reloadLog();
    expect(api.log).not.toHaveBeenCalled();
    expect(useGitLog.getState().commits).toEqual([]);
  });

  it("cancels a superseded page and ignores its later response", async () => {
    let finish!: (value: ReturnType<typeof ok<Commit[]>>) => void;
    api.log.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = reloadLog();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const request = api.log.mock.lastCall![1].request;
    api.log.mockResolvedValue(ok([c("fresh")]));
    await reloadLog();
    expect(api.cancel).toHaveBeenCalledWith(request);
    finish(ok([c("stale")]));
    await old;
    expect(useGitLog.getState().commits.map((c) => c.id)).toEqual(["fresh"]);
  });
});

describe("commit navigation", () => {
  it("resolves references in the repositories of a standalone multi-root log", async () => {
    useVcs.setState({ root: null, repo: null, roots: [] });
    openLogTab("external", "/a", "toolWindow", ["/a", "/b"]);
    api.log.mockImplementation(async (repo: string) => ok(repo ? [c("target")] : []));
    expect(await goToRef("main")).toBe(true);
    expect(api.choose).toHaveBeenCalledWith([
      expect.objectContaining({ repo: "/a" }),
      expect.objectContaining({ repo: "/b" }),
    ]);
    expect(useGitLog.getState().selected).toBe(commitKey({ ...c("target"), repo: "/b" }));
    expect(api.log.mock.calls.every(([repo]) => repo === "/a" || repo === "/b")).toBe(true);
  });

  it("jumps to an indexed window beyond thirty pages without paging through the prefix", async () => {
    const history = Array.from({ length: PAGE * 31 + 7 }, (_, i) => c(`commit${i}`));
    const target = history.at(-1)!;
    api.log.mockImplementation(async (_repo: string, q: LogQuery) =>
      ok(q.branch === target.id || q.seek === target.id ? [target] : history.slice(q.skip, q.skip + q.limit)),
    );
    expect(await goToRef(target.id)).toBe(true);
    expect(useGitLog.getState().selected).toBe(commitKey({ ...target, repo: "/repo" }));
    expect(api.log.mock.calls.some((call) => call[1].seek === target.id)).toBe(true);
    expect(api.log.mock.calls.length).toBeLessThan(5);
  });

  it("navigates the displayed collapsed adjacency in both directions", async () => {
    const commits = [c("tip", ["middle"]), c("middle", ["base"]), c("base")];
    useGitLog.setState({ commits, done: true });
    updateLogOptions({ collapseLinear: true });
    await goToParent(commits[0]!);
    expect(useGitLog.getState().selected).toBe("base");
    await goToChild(commits[2]!);
    expect(useGitLog.getState().selected).toBe("tip");
  });

  it("expands merges in linearized mode and retains expansion across new pages", () => {
    const commits = [c("merge", ["main", "side"]), c("side", ["base"]), c("main", ["base"]), c("base")];
    useGitLog.setState({ commits });
    useLogOptions.setState({ linearizeMerges: true });
    expect(displayedLogGraph().graph[0]!.parents).toEqual(["side"]);
    updateLogOptions({ collapseLinear: false });
    expect(displayedLogGraph().graph[0]!.parents).toEqual(["main", "side"]);
    updateLogOptions({ collapseLinear: true });
    expect(displayedLogGraph().graph[0]!.parents).toEqual(["side"]);
  });

  it("keeps selections and ranges spanning repository roots", () => {
    const commits = [
      { ...c("a"), repo: "/a" },
      { ...c("b"), repo: "/b" },
    ];
    useGitLog.setState({ commits, selection: [commitKey(commits[0]!)] });
    toggleCommitSelection(commitKey(commits[1]!));
    expect(useGitLog.getState().selection).toEqual(commits.map(commitKey));
    extendCommitSelection(commitKey(commits[1]!), commits);
    expect(useGitLog.getState().selection).toEqual(commits.map(commitKey));
  });

  it("sends branches and independent ranges without dropping either", async () => {
    setLogBranches(["main", "a..b", "c..d"]);
    await reloadLog();
    expect(api.log.mock.lastCall?.[1]).toMatchObject({ branches: ["main"], range: null, ranges: ["a..b", "c..d"] });
  });

  it("offers both merge parents and selects the chosen repository-scoped commit", async () => {
    const commits = [c("merge", ["main", "side"]), c("main"), c("side")].map((c) => ({ ...c, repo: "/repo" }));
    useGitLog.setState({ commits, done: true });
    await goToParent(commits[0]!);
    expect(api.choose).toHaveBeenCalledWith(commits.slice(1));
    expect(useGitLog.getState().selected).toBe(commitKey(commits[2]!));
  });

  it("does not navigate after a reference lookup is superseded by a filter change", async () => {
    let finish!: (value: ReturnType<typeof ok<Commit[]>>) => void;
    api.log.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const navigate = goToRef("target");
    await vi.waitFor(() => expect(finish).toBeDefined());
    api.log.mockResolvedValue(ok([c("filtered")]));
    await reloadLog();
    finish(ok([c("target")]));
    expect(await navigate).toBe(false);
    expect(useGitLog.getState().selected).toBeNull();
    expect(useGitLog.getState().commits[0]!.id).toBe("filtered");
  });

  it("reveals a commit directly via seek while keeping branch filter and showDetails preference", async () => {
    const history = Array.from({ length: PAGE * 20 + 5 }, (_, i) => c(`sha-${i}`));
    const target = history.at(-1)!;
    useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS, showDetails: false });
    useGitLog.setState({ filters: { ...emptyFilters(), branches: ["HEAD"] }, branchScope: "/repo" });
    api.log.mockImplementation(async (_repo: string, q: LogQuery) => {
      if (q.seek === target.id) {
        return ok(history.slice(-50));
      }
      return ok(history.slice(q.skip, q.skip + q.limit));
    });
    await revealCommit(target.id, "/repo");
    expect(useLogOptions.getState().showDetails).toBe(false);
    expect(useGitLog.getState().filters.branches).toEqual(["HEAD"]);
    expect(useGitLog.getState().selected).toBe(commitKey({ ...target, repo: "/repo" }));
    expect(api.log).toHaveBeenCalledTimes(1);
    expect(api.log.mock.calls[0]?.[1]).toMatchObject({ seek: target.id, branches: ["HEAD"] });
  });
});
