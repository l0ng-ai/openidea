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

const COLORS = {
  withRemote: "var(--git-master-with-remote, var(--accent))",
  withoutRemote: "var(--git-master-without-remote, var(--accent))",
  tracking: "var(--git-tracking-branch, var(--accent))",
  local: "var(--git-local-branch, var(--accent))",
  changed: "var(--git-branch-changed, var(--accent))",
  headTags: "var(--git-head-tags, var(--accent))",
};

/** The font style / effect channels every suffix segment now carries. */
const styleOf = (attr: string) => ({
  fontWeight: `var(--git-${attr}-bold, inherit)`,
  fontStyle: `var(--git-${attr}-italic, inherit)`,
  textDecoration: `var(--git-${attr}-effect, none)`,
});

describe("rootSyncSuffix", () => {
  it("strikes out zero when the branch matches its upstream", () => {
    expect(rootSyncSuffix(info("main", "origin/main"))).toEqual([
      { text: "main", color: COLORS.withRemote, ...styleOf("master-with-remote") },
      { text: "/", color: COLORS.headTags, ...styleOf("head-tags") },
      {
        text: "0",
        strike: true,
        label: "Up to date with origin/main",
        color: COLORS.headTags,
        ...styleOf("head-tags"),
      },
    ]);
  });

  it("shows outgoing then incoming commits with their icons", () => {
    expect(rootSyncSuffix(info("main", "origin/main", 1, 3))).toEqual([
      { text: "main", color: COLORS.withRemote, ...styleOf("master-with-remote") },
      { text: "/", color: COLORS.headTags, ...styleOf("head-tags") },
      {
        text: "1",
        icon: "vcs-outgoing",
        label: "1 outgoing commits",
        color: COLORS.changed,
        ...styleOf("branch-changed"),
      },
      {
        text: "3",
        icon: "vcs-incoming",
        label: "3 incoming commits",
        color: COLORS.changed,
        ...styleOf("branch-changed"),
      },
    ]);
    expect(rootSyncSuffix(info("main", "origin/main", 0, 2))).toEqual([
      { text: "main", color: COLORS.withRemote, ...styleOf("master-with-remote") },
      { text: "/", color: COLORS.headTags, ...styleOf("head-tags") },
      {
        text: "2",
        icon: "vcs-incoming",
        label: "2 incoming commits",
        color: COLORS.changed,
        ...styleOf("branch-changed"),
      },
    ]);
  });

  it("shows only the branch without an upstream", () => {
    expect(rootSyncSuffix(info("feature", null))).toEqual([
      { text: "feature", color: COLORS.local, ...styleOf("local-branch") },
    ]);
  });

  it("uses the tracking and master-without-remote colours", () => {
    expect(rootSyncSuffix(info("dev", "origin/dev"))![0]?.color).toBe(COLORS.tracking);
    expect(rootSyncSuffix(info("master", null))![0]?.color).toBe(COLORS.withoutRemote);
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
    useVcs.setState({ available: true, roots: ["/p", "/p/lib"], status: [] });
  });

  afterEach(() => {
    dispose?.();
    useProject.setState({ settings: null });
  });

  it("decorates every repository root when the setting is on", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix?.[2]?.text).toBe("1"));
    expect(getFileDecoration("/p/lib")?.suffix).toEqual([
      { text: "dev", color: COLORS.local, ...styleOf("local-branch") },
    ]);
    expect(getFileDecoration("/p")?.suffixColor).toBe("var(--git-local-branch, var(--accent))");
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

  it("counts the changed files of each repository and follows the status without asking git", async () => {
    enable(true);
    dispose = installRootSync();
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledTimes(2));
    const file = (path: string, unstaged: string) =>
      ({ path, relPath: path, staged: null, unstaged, renamedFrom: null }) as never;
    useVcs.setState({
      status: [
        file("/p/a.ts", "modified"),
        file("/p/b.ts", "untracked"),
        file("/p/lib/c.ts", "added"),
        file("/p/d.log", "ignored"),
      ],
    });
    await vi.waitFor(() =>
      expect(getFileDecoration("/p")?.suffix?.at(-1)).toEqual({
        text: "2",
        icon: "edit",
        label: "2 changed files",
        color: "var(--vcs-modified)",
      }),
    );
    expect(getFileDecoration("/p/lib")?.suffix?.map((s) => s.text)).toEqual(["dev", "1"]);
    useVcs.setState({ status: [] });
    await vi.waitFor(() => expect(getFileDecoration("/p")?.suffix?.map((s) => s.text)).toEqual(["main", "/", "1"]));
    expect(ipc.branchInfo).toHaveBeenCalledTimes(2);
  });

  it("queries again when a HEAD moves or a fetch / pull / push finishes, without a .git event", async () => {
    enable(true);
    useVcs.setState({ heads: { "/p": { head: "main", headCommit: "a" } }, remoteBusy: null });
    dispose = installRootSync();
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledTimes(2));
    useVcs.setState({ remoteBusy: "Fetching…" });
    await settle();
    expect(ipc.branchInfo).toHaveBeenCalledTimes(2);
    useVcs.setState({ remoteBusy: null });
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledTimes(4));
    useVcs.setState({ heads: { "/p": { head: "main", headCommit: "a" } } });
    await settle();
    expect(ipc.branchInfo).toHaveBeenCalledTimes(4);
    useVcs.setState({ heads: { "/p": { head: "main", headCommit: "b" } } });
    await vi.waitFor(() => expect(ipc.branchInfo).toHaveBeenCalledTimes(6));
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
    await vi.waitFor(() =>
      expect(getFileDecoration("/p/lib")?.suffix).toEqual([
        { text: "dev", color: COLORS.local, ...styleOf("local-branch") },
      ]),
    );
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
    await vi.waitFor(() =>
      expect(getFileDecoration("/p")?.suffix).toEqual([
        { text: "main", color: COLORS.withoutRemote, ...styleOf("master-without-remote") },
      ]),
    );
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
