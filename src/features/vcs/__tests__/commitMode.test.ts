import { beforeEach, describe, expect, it, vi } from "vitest";

const vcsLog = vi.fn();
const fsReadText = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
      vcsConfigGet: async () => ({ status: "ok", data: null }),
      fsReadText: (path: string) => fsReadText(path),
    },
  };
});

import { gitTabs, shownTab, stashTabOf, stashTabs } from "../gitTabs";
import { pushDialogNeeded } from "../commitUi";
import { installPreparedMessage, keepMessageAfterCommit, messageAfterCommit, useCommit } from "../commitStore";
import { closeLogTab, emptyFilters, openLogTab, selectGitTab, setLogFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);

describe("Git and Commit tool window tabs", () => {
  const base = { combine: false, shelfCount: 0, stashCount: 0, tab: "log", logTabs: [] };

  it("puts Local Changes, Shelf and Stash into the Git window only with the modal commit interface", () => {
    expect(ids(gitTabs({ ...base, modal: false }))).toEqual(["log", "console", "worktrees"]);
    expect(ids(gitTabs({ ...base, modal: true }))).toEqual(["changes", "stashes", "log", "console", "worktrees"]);
    expect(ids(gitTabs({ ...base, modal: true, shelfCount: 2 }))).toEqual([
      "changes",
      "shelf",
      "stashes",
      "log",
      "console",
      "worktrees",
    ]);
  });

  it("combines stashes and shelves into one tab", () => {
    expect(stashTabs({ ...base, combine: true, shelfCount: 2, stashCount: 1 })).toEqual([
      { id: "stashes", label: "Stashes and Shelves", count: 3 },
    ]);
    expect(stashTabOf("shelf", true)).toBe("stashes");
    expect(stashTabOf("shelf", false)).toBe("shelf");
  });

  it("lists log tabs as closable after the main Log, and falls back to the Log for a missing tab", () => {
    const logTabs = [{ id: "history:1", kind: "history" as const, target: "/p/src/a.ts" }];
    const tabs = gitTabs({ ...base, modal: false, logTabs });
    expect(tabs.find((t) => t.id === "history:1")).toEqual({ id: "history:1", label: "History: a.ts", closable: true });
    expect(shownTab("changes", tabs, false)).toBe("log");
    expect(shownTab("history:1", tabs, false)).toBe("history:1");
  });
});

describe("Commit and Push… push dialog", () => {
  const git = { showPushDialog: true, pushDialogOnlyProtected: false, protectedBranches: "master;main" };

  it("shows the dialog unless turned off, or only for protected branches", () => {
    expect(pushDialogNeeded(git, "feature")).toBe(true);
    expect(pushDialogNeeded({ ...git, showPushDialog: false }, "main")).toBe(false);
    expect(pushDialogNeeded({ ...git, pushDialogOnlyProtected: true }, "feature")).toBe(false);
    expect(pushDialogNeeded({ ...git, pushDialogOnlyProtected: true }, "main")).toBe(true);
    // Nothing to tell the target from (detached HEAD): always the dialog.
    expect(pushDialogNeeded({ ...git, showPushDialog: false }, null)).toBe(true);
  });
});

describe("commit message after a commit", () => {
  beforeEach(() => fsReadText.mockReset());

  it("keeps the committed message unless Clear initial commit message is on", () => {
    expect(messageAfterCommit("  fix: thing \n", false)).toBe("fix: thing");
    expect(messageAfterCommit("fix: thing", true)).toBe("");
  });

  it("lets a prepared merge message replace a kept one, but not a typed one", async () => {
    useVcs.setState({ root: "/p", branch: null });
    const dispose = installPreparedMessage();
    keepMessageAfterCommit("fix: thing", false);
    fsReadText.mockResolvedValue({ status: "ok", data: "Merge branch 'x'\n# Conflicts:\n" });
    useVcs.setState({ branch: { operation: "merge" } as never });
    await vi.waitFor(() => expect(useCommit.getState().message).toBe("Merge branch 'x'"));
    useVcs.setState({ branch: null });

    useCommit.setState({ message: "typed" });
    useVcs.setState({ branch: { operation: "merge" } as never });
    await Promise.resolve();
    expect(useCommit.getState().message).toBe("typed");
    dispose();
  });
});

describe("log tabs of their own", () => {
  beforeEach(() => {
    vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [] });
    useVcs.setState({ root: "/p", repo: "/p", roots: ["/p"] });
    useGitLog.setState({ tab: "log", logTabs: [], shownLog: "log", filters: emptyFilters() });
  });

  it("opens Show History in a closable tab and leaves the main Log's filters alone", () => {
    setLogFilters({ authors: ["bob"] });
    const id = openLogTab("history", "/p/src/a.ts");
    expect(useGitLog.getState()).toMatchObject({ tab: id, shownLog: id });
    expect(useGitLog.getState().filters).toMatchObject({ path: "/p/src/a.ts", authors: [] });
    // The same file again: the same tab.
    selectGitTab("log");
    expect(useGitLog.getState().filters.authors).toEqual(["bob"]);
    expect(openLogTab("history", "/p/src/a.ts")).toBe(id);
    expect(useGitLog.getState().logTabs).toHaveLength(1);

    closeLogTab(id);
    expect(useGitLog.getState()).toMatchObject({ tab: "log", shownLog: "log", logTabs: [] });
    expect(useGitLog.getState().filters).toMatchObject({ authors: ["bob"], path: null });
  });

  it("keeps a log tab's view while another content tab is shown", () => {
    const id = openLogTab("branch", "feature");
    selectGitTab("console");
    expect(useGitLog.getState()).toMatchObject({ tab: "console", shownLog: id });
    selectGitTab(id);
    expect(useGitLog.getState().filters.branches).toEqual(["feature"]);
    closeLogTab(id);
  });
});
