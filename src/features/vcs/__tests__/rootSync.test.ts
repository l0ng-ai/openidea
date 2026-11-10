import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchInfo } from "@/bindings";

const ipc = vi.hoisted(() => ({ branchInfo: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsBranchInfo: ipc.branchInfo } };
});

import { emitLocalIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { getFileDecoration } from "@/workbench/contributions";
import { installRootSync, rootSyncSuffix } from "../rootSync";
import { useVcs } from "../store";

const info = (head: string | null, upstream: string | null, ahead = 0, behind = 0): BranchInfo => ({
  head,
  headCommit: "c1",
  upstream,
  ahead,
  behind,
  operation: null,
});

describe("rootSyncSuffix", () => {
  it("strikes out zero when the branch matches its upstream", () => {
    expect(rootSyncSuffix(info("main", "origin/main"))).toEqual([
      { text: "main" },
      { text: "/" },
      { text: "0", strike: true, label: "Up to date with origin/main" },
    ]);
  });

  it("shows outgoing then incoming commits with their icons", () => {
    expect(rootSyncSuffix(info("main", "origin/main", 1, 3))).toEqual([
      { text: "main" },
      { text: "/" },
      { text: "1", icon: "vcs-outgoing", label: "1 outgoing commits" },
      { text: "3", icon: "vcs-incoming", label: "3 incoming commits" },
    ]);
    expect(rootSyncSuffix(info("main", "origin/main", 0, 2))).toEqual([
      { text: "main" },
      { text: "/" },
      { text: "2", icon: "vcs-incoming", label: "2 incoming commits" },
    ]);
  });

  it("shows only the branch without an upstream", () => {
    expect(rootSyncSuffix(info("feature", null))).toEqual([{ text: "feature" }]);
  });

  it("shows nothing for a detached HEAD", () => {
    expect(rootSyncSuffix(info(null, null))).toBeNull();
  });
});

describe("installRootSync", () => {
  const enable = (on: boolean) =>
    useProject.setState({ settings: { vcs: { git: { showBranchInProjectView: on } } } } as never);
  const gitChanged = () => emitLocalIdeEvent({ type: "vcsChanged", root: "/p" });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
  let dispose: () => void;

  beforeEach(() => {
    ipc.branchInfo.mockReset().mockImplementation(async (root: string) => ({
      status: "ok",
      data: root === "/p" ? info("main", "origin/main", 1, 0) : info("dev", null),
    }));
    useVcs.setState({ available: true, roots: ["/p", "/p/lib"] });
  });

  afterEach(() => {
    dispose?.();
    useProject.setState({ settings: null });
  });

  it("decorates every repository root when the setting is on", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix?.[2]?.text).toBe("1"));
    expect(getFileDecoration("/p/lib")?.suffix).toEqual([{ text: "dev" }]);
    expect(getFileDecoration("/p")?.suffixColor).toBe("var(--accent)");
    expect(ipc.branchInfo).toHaveBeenCalledWith("/p");
    expect(ipc.branchInfo).toHaveBeenCalledWith("/p/lib");
  });

  it("shows nothing and queries nothing while the setting is off", async () => {
    enable(false);
    dispose = installRootSync();
    gitChanged();
    await settle();
    expect(ipc.branchInfo).not.toHaveBeenCalled();
    expect(getFileDecoration("/p")?.suffix).toBeUndefined();
  });

  it("queries again after a change inside .git, such as a fetch, push or commit", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix?.[2]?.text).toBe("1"));
    ipc.branchInfo.mockImplementation(async (root: string) => ({
      status: "ok",
      data: root === "/p" ? info("main", "origin/main", 1, 4) : info("dev", null),
    }));
    gitChanged();
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix?.[3]?.text).toBe("4"));
  });

  it("does not query git when only the status refreshes or worktree files change", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledTimes(2));
    useVcs.setState((s) => ({ version: s.version + 1 }));
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: ["/p/a.txt"], removed: [] } as never);
    await settle();
    expect(ipc.branchInfo).toHaveBeenCalledTimes(2);
  });

  it("queries the repositories again when the set of roots changes", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledTimes(2));
    useVcs.setState({ roots: ["/p", "/p/lib", "/p/web"] });
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledWith("/p/web"));
  });

  it("clears the decorations when the setting is switched off", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix).toBeDefined());
    enable(false);
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix).toBeUndefined());
  });

  it("skips a repository whose branch cannot be read", async () => {
    ipc.branchInfo.mockImplementation(async (root: string) =>
      root === "/p" ? { status: "error", error: "boom" } : { status: "ok", data: info("dev", null) },
    );
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(getFileDecoration("/p/lib")?.suffix).toEqual([{ text: "dev" }]));
    expect(getFileDecoration("/p")?.suffix).toBeUndefined();
  });

  it("keeps a repository's previous suffix when a later read fails", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix?.[2]?.text).toBe("1"));
    ipc.branchInfo.mockImplementation(async (root: string) =>
      root === "/p" ? { status: "error", error: "index.lock" } : { status: "ok", data: info("dev", "origin/dev") },
    );
    gitChanged();
    await vi.waitFor(() => expect(getFileDecoration("/p/lib")?.suffix?.[2]?.text).toBe("0"));
    expect(getFileDecoration("/p")?.suffix?.[2]?.text).toBe("1");
  });

  it("runs one query round at a time and coalesces Git changes made meanwhile", async () => {
    const pending: Array<() => void> = [];
    ipc.branchInfo.mockImplementation(
      (root: string) =>
        new Promise((resolve) =>
          pending.push(() => resolve({ status: "ok", data: info(root === "/p" ? "main" : "dev", null) })),
        ),
    );
    enable(true);
    dispose = installRootSync();
    expect(ipc.branchInfo).toHaveBeenCalledTimes(2);
    gitChanged();
    await settle();
    gitChanged();
    await settle();
    expect(ipc.branchInfo).toHaveBeenCalledTimes(2);
    pending.splice(0).forEach((done) => done());
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledTimes(4));
    pending.splice(0).forEach((done) => done());
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix).toEqual([{ text: "main" }]));
    await settle();
    expect(ipc.branchInfo).toHaveBeenCalledTimes(4);
  });

  it("does not publish results that arrive after disposal", async () => {
    let finish = () => {};
    ipc.branchInfo.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ status: "ok", data: info("main", null) }))),
    );
    useVcs.setState({ roots: ["/p"] });
    enable(true);
    dispose = installRootSync();
    dispose();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getFileDecoration("/p")?.suffix).toBeUndefined();
  });

  it("clears the decorations when the project has no repositories any more", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix).toBeDefined());
    useVcs.setState({ available: false, roots: [] });
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix).toBeUndefined());
  });
});
