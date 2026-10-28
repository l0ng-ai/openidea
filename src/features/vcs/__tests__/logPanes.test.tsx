import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Branch, Commit } from "@/bindings";

const vcsCommitFiles = vi.fn();
const vcsTags = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsCommitFiles: (repo: unknown, id: string) => vcsCommitFiles(repo, id),
      vcsTags: (repo: unknown) => vcsTags(repo),
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

import { buildBranchTree, filterBranchTree } from "../branches";
import { buildFileTree } from "../fileTree";
import { filesUnder, filterPatch, flatFileNodes, toLogChanges, useLogChanges } from "../logChanges";
import { canDeleteBranch, canUpdateBranch, useBranchesPane } from "../logPaneActions";
import { BranchesPanel, CommitDetails, changesMenu, graphOptionsMenu } from "../GitLog";
import { LogSettingsPage } from "../LogSettingsPage";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { emptyFilters, useGitLog } from "../logStore";
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

const commit: Commit = {
  id: "c".repeat(40),
  shortId: "c".repeat(8),
  parents: ["p".repeat(40)],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary: "Change",
  message: "Change",
  refs: [],
};

beforeEach(() => {
  vcsTags.mockResolvedValue({ status: "ok", data: [] });
});

afterEach(() => {
  useGitLog.setState({ commits: [], selection: [], selected: null, filters: emptyFilters() });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  vcsCommitFiles.mockReset();
  vcsTags.mockReset();
});

describe("changed files model", () => {
  it("keeps the revisions before and after each file's change", () => {
    const [mod, add, del] = toLogChanges(
      [
        { path: "a.ts", kind: "modified", oldPath: null },
        { path: "b.ts", kind: "added", oldPath: null },
        { path: "c.ts", kind: "deleted", oldPath: null },
      ],
      commit,
    );
    expect([mod!.before, mod!.after]).toEqual([commit.parents[0], commit.id]);
    expect([add!.before, add!.after]).toEqual([null, commit.id]);
    expect([del!.before, del!.after]).toEqual([commit.parents[0], null]);
  });

  it("lists files without directories by name, and the files under selected directories", () => {
    const files = ["src/b.ts", "lib/a.ts", "src/x/a.ts"];
    expect(flatFileNodes(files, (f) => f).map((n) => n.key)).toEqual(["f:lib/a.ts", "f:src/x/a.ts", "f:src/b.ts"]);
    const tree = buildFileTree(files, (f) => f);
    expect(filesUnder(tree)).toEqual(["lib/a.ts", "src/x/a.ts", "src/b.ts"]);
    expect(filesUnder(tree, new Set(["d:src"]))).toEqual(["src/x/a.ts", "src/b.ts"]);
    expect(filesUnder(tree, new Set(["d:src", "f:src/b.ts"]))).toEqual(["src/x/a.ts", "src/b.ts"]);
  });

  it("keeps only the patch sections of the given files, renames by either name", () => {
    const section = (a: string, bb: string) =>
      `diff --git a/${a} b/${bb}\nindex 1..2\n--- a/${a}\n+++ b/${bb}\n@@ -1 +1 @@\n-x\n+y\n`;
    const patch = section("a.ts", "a.ts") + section("old.ts", "new.ts") + section("c.ts", "c.ts");
    expect(filterPatch(patch, new Set(["a.ts"]))).toBe(section("a.ts", "a.ts"));
    expect(filterPatch(patch, new Set(["new.ts", "c.ts"]))).toBe(section("old.ts", "new.ts") + section("c.ts", "c.ts"));
    expect(filterPatch(patch, new Set(["zzz"]))).toBe("");
  });

  it("offers Compare with Local only for a file that still exists after the change", () => {
    const [del] = toLogChanges([{ path: "c.ts", kind: "deleted", oldPath: null }], commit);
    const item = changesMenu([del!]).find((i) => "action" in i && i.action === "vcs.log.changes.compareWithLocal");
    expect(item).toMatchObject({ disabled: true });
  });
});

describe("changed files pane", () => {
  it("shows the files flat or by directory and shares the selection with its actions", async () => {
    vcsCommitFiles.mockResolvedValue({
      status: "ok",
      data: [
        { path: "src/a.ts", kind: "modified", oldPath: null },
        { path: "src/b.ts", kind: "added", oldPath: null },
      ],
    });
    useGitLog.setState({ commits: [commit], selected: commit.id, selection: [commit.id] });
    const { unmount } = render(<CommitDetails commits={[commit]} />);
    expect(await screen.findByText("src")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("a.ts"));
    expect(useLogChanges.getState().selected.map((c) => c.path)).toEqual(["src/a.ts"]);
    expect(useLogChanges.getState().commits).toEqual([commit]);
    expect(screen.getByRole("button", { name: "Show Diff" })).toBeEnabled();

    useLogOptions.setState({ groupByDirectory: false });
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
    // Flat: each file shows its directory instead of sitting under it.
    expect(screen.getAllByText("src")).toHaveLength(2);
    unmount();
    expect(useLogChanges.getState().selected).toEqual([]);
  });
});

describe("Branches pane", () => {
  it("lists tags in their own group, newest version first, and finds them by name", () => {
    const roots = buildBranchTree([b("main", { current: true })], null, ["v1.2", "v1.10", "v1.9"]);
    const tags = roots.find((n) => n.key === "g:tags");
    expect(tags?.children?.map((n) => n.label)).toEqual(["v1.10", "v1.9", "v1.2"]);
    expect(filterBranchTree(roots, "1.9").map((n) => n.key)).toEqual(["g:tags"]);
    expect(buildBranchTree([b("main")], null).some((n) => n.key === "g:tags")).toBe(false);
  });

  it("enables Update and Delete for the branches they apply to", () => {
    const current = b("main", { current: true });
    const tracked = b("feature", { upstream: "origin/feature" });
    expect(canDeleteBranch({ ref: "main", branch: current })).toBe(false);
    expect(canDeleteBranch({ ref: "feature", branch: tracked })).toBe(true);
    expect(canDeleteBranch({ ref: "v1" })).toBe(false);
    expect(canUpdateBranch({ ref: "feature", branch: tracked })).toBe(true);
    expect(canUpdateBranch({ ref: "x", branch: b("x") })).toBe(false);
    expect(canUpdateBranch({ ref: "origin/x", branch: b("origin/x", { remote: true }) })).toBe(false);
  });

  it("has a vertical toolbar acting on the selected branch, and shows tags", async () => {
    vcsTags.mockResolvedValue({ status: "ok", data: ["v1"] });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      branchesLoaded: true,
      branches: [b("main", { current: true }), b("feature")],
      branch: { head: "main", headCommit: "1", upstream: null, ahead: 0, behind: 0, operation: null },
    });
    render(<BranchesPanel />);
    expect(screen.getByRole("toolbar", { name: "Branches" })).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getByPlaceholderText("Branch or tag")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Branch" })).toBeDisabled();
    fireEvent.mouseDown(screen.getByText("feature"));
    expect(useBranchesPane.getState().selected.map((t) => t.ref)).toEqual(["feature"]);
    expect(screen.getByRole("button", { name: "Delete Branch" })).toBeEnabled();
    expect(await screen.findByText("Tags")).toBeInTheDocument();
  });
});

describe("Graph Options", () => {
  it("offers Collapse and Expand Linear Branches as two actions", () => {
    for (const collapseLinear of [false, true]) {
      const items = graphOptionsMenu({ ...DEFAULT_LOG_OPTIONS, collapseLinear });
      const actions = items.filter((i) => "action" in i).map((i) => ("action" in i ? [i.action, i.disabled] : []));
      expect(actions).toEqual([
        ["vcs.log.collapseLinear", undefined],
        ["vcs.log.expandLinear", undefined],
      ]);
    }
  });
});

describe("Settings › Version Control › Log", () => {
  it("edits the log's display options", () => {
    render(<LogSettingsPage />);
    fireEvent.click(screen.getByLabelText("Show tag names"));
    expect(useLogOptions.getState().tagNames).toBe(!DEFAULT_LOG_OPTIONS.tagNames);
    fireEvent.click(screen.getByLabelText("Hash"));
    expect(useLogOptions.getState().showHash).toBe(!DEFAULT_LOG_OPTIONS.showHash);
  });
});
