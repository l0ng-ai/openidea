import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "@/bindings";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

import {
  emptyFilters,
  initLogBranchFilter,
  rememberedLogBranches,
  resolveLogBranches,
  setLogBranches,
  useGitLog,
} from "../logStore";
import { useVcs } from "../store";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const remember = (repo: string, branches: string[]) =>
  localStorage.setItem(`openidea.vcs.logBranches:${repo}`, JSON.stringify(branches));

/** A project and its selected repository with the given branches. */
function project(root: string, repo = root, branches: readonly Branch[] = [b("main", { current: true })]) {
  useVcs.setState({ root, roots: [repo], repo, branches: [...branches], branchesLoaded: true });
  useGitLog.setState({ filters: emptyFilters(), branchScope: null, shownLog: "log", commits: [] });
}

beforeEach(() => localStorage.clear());

describe("resolveLogBranches", () => {
  it("defaults to HEAD (the current branch) when nothing was remembered", () => {
    expect(resolveLogBranches(undefined, ["main", "feature"])).toEqual(["HEAD"]);
  });

  it("keeps a remembered local or remote branch", () => {
    expect(resolveLogBranches(["feature"], ["main", "feature"])).toEqual(["feature"]);
    expect(resolveLogBranches(["origin/es"], ["main", "origin/es"])).toEqual(["origin/es"]);
  });

  it("falls back to HEAD when every remembered branch is gone", () => {
    expect(resolveLogBranches(["deleted"], ["main"])).toEqual(["HEAD"]);
  });

  it("keeps the remembered branches that still exist", () => {
    expect(resolveLogBranches(["deleted", "feature"], ["main", "feature"])).toEqual(["feature"]);
  });

  it("keeps an empty list as all branches, and HEAD", () => {
    expect(resolveLogBranches([], ["main"])).toEqual([]);
    expect(resolveLogBranches(["HEAD"], ["main"])).toEqual(["HEAD"]);
  });
});

describe("Git Log branch filter memory", () => {
  it("shows the current branch on first open", () => {
    project("/mem-first");
    expect(initLogBranchFilter()).toBe(true);
    expect(useGitLog.getState().filters.branches).toEqual(["HEAD"]);
    expect(initLogBranchFilter()).toBe(false);
  });

  it("restores the remembered branch, dropping a deleted one", () => {
    remember("/mem-restore", ["origin/es", "deleted"]);
    project("/mem-restore", "/mem-restore", [b("main", { current: true }), b("origin/es", { remote: true })]);
    initLogBranchFilter();
    expect(useGitLog.getState().filters.branches).toEqual(["origin/es"]);
  });

  it("remembers a choice in the main Log, including all branches", () => {
    project("/mem-save");
    initLogBranchFilter();
    setLogBranches(["feature"]);
    expect(useGitLog.getState().filters.branches).toEqual(["feature"]);
    expect(rememberedLogBranches("/mem-save")).toEqual(["feature"]);
    setLogBranches([]);
    expect(rememberedLogBranches("/mem-save")).toEqual([]);
  });

  it("does not remember a choice in another log tab", () => {
    project("/mem-tab");
    useGitLog.setState({ shownLog: "tab-1" });
    setLogBranches(["feature"]);
    expect(rememberedLogBranches("/mem-tab")).toBeUndefined();
  });

  it("keeps a separate choice for every repository", () => {
    remember("/mem-multi", ["main"]);
    remember("/mem-multi/backend", ["dev"]);
    project("/mem-multi", "/mem-multi/backend", [b("dev", { current: true }), b("main")]);
    initLogBranchFilter();
    expect(useGitLog.getState().filters.branches).toEqual(["dev"]);
    expect(useGitLog.getState().branchScope).toBe("/mem-multi/backend");
  });
});
