import { beforeEach, describe, expect, it, vi } from "vitest";

const vcsLog = vi.fn();
const fsReadText = vi.fn();
const showCommitDialog = vi.hoisted(() => vi.fn());
vi.mock("../CommitDialog", () => ({ showCommitDialog }));
const vcsConfigGet = vi.fn(async (_repo: unknown, _key: string) => ({ status: "ok", data: null as string | null }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
      vcsConfigGet: (repo: unknown, key: string) => vcsConfigGet(repo, key),
      fsReadText: (path: string) => fsReadText(path),
    },
  };
});

import type { FileStatus, Settings } from "@/bindings";
import { useProject } from "@/platform/project";
import { commitChangelist, commitFiles } from "../changelistsUi";
import { initialChangelists, useChangelists } from "../changelists";
import { gitTabs, shownTab, stashTabOf, stashTabs } from "../gitTabs";
import { commitFromContext, pushDialogNeeded } from "../commitUi";
import {
  installPreparedMessage,
  keepMessageAfterCommit,
  messageAfterCommit,
  templatePath,
  useCommit,
} from "../commitStore";
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

describe("commit template", () => {
  beforeEach(() => {
    fsReadText.mockReset();
    vcsConfigGet.mockImplementation(async (_repo, key) => ({
      status: "ok",
      data: key === "commit.template" ? ".gitmessage" : null,
    }));
    useCommit.setState({ message: "" });
  });

  it("resolves the configured path as git does", () => {
    expect(templatePath("~/.gitmessage", "/p", "/home/me/")).toBe("/home/me/.gitmessage");
    expect(templatePath("/etc/msg", "/p", "")).toBe("/etc/msg");
    expect(templatePath("C:\\msg.txt", "/p", "")).toBe("C:\\msg.txt");
    expect(templatePath(".gitmessage", "/p", "")).toBe("/p/.gitmessage");
  });

  it("fills the empty message field, and again after a commit clears it", async () => {
    fsReadText.mockResolvedValue({ status: "ok", data: "feat: \n\n# Why:\nRefs: \n" });
    useVcs.setState({ root: "/p", branch: null });
    const dispose = installPreparedMessage();
    await vi.waitFor(() => expect(useCommit.getState().message).toBe("feat: \n\nRefs:"));
    expect(fsReadText).toHaveBeenCalledWith("/p/.gitmessage");

    keepMessageAfterCommit("feat: x", true);
    await vi.waitFor(() => expect(useCommit.getState().message).toBe("feat: \n\nRefs:"));
    // A kept message stays; a typed one is never replaced.
    keepMessageAfterCommit("feat: x", false);
    useCommit.setState({ message: "typed" });
    useVcs.setState({ root: "/q" });
    useCommit.setState({ message: "typed" });
    await Promise.resolve();
    expect(useCommit.getState().message).toBe("typed");
    dispose();
  });
});

describe("Commit File… and the modal commit interface", () => {
  const status: FileStatus[] = [
    { path: "/p/src/a.ts", relPath: "src/a.ts", staged: null, unstaged: "modified", renamedFrom: null },
    { path: "/p/src/b.ts", relPath: "src/b.ts", staged: null, unstaged: "modified", renamedFrom: null },
  ];

  beforeEach(() => {
    showCommitDialog.mockClear();
    useProject.setState({ settings: null });
    useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status });
    useCommit.setState({ checks: new Map(), message: "" });
  });

  it("opens the Commit dialog with just the file included", async () => {
    useProject.setState({ settings: { vcs: { commit: { nonModal: false } } } as Settings });
    commitFiles(["/p/src/a.ts"]);
    await vi.waitFor(() => expect(showCommitDialog).toHaveBeenCalled());
    expect(useCommit.getState().checks.get("/p/src/a.ts")).toBe("all");
    expect(useCommit.getState().checks.get("/p/src/b.ts")).toBe("none");
  });

  it("keeps the message in the Commit tool window without the modal interface", () => {
    const tick = useCommit.getState().focusTick;
    commitFiles(["/p/src/a.ts"]);
    expect(showCommitDialog).not.toHaveBeenCalled();
    expect(useCommit.getState().focusTick).toBe(tick + 1);
    expect(useCommit.getState().checks.get("/p/src/a.ts")).toBe("all");
    expect(useCommit.getState().checks.get("/p/src/b.ts")).toBe("none");
  });

  it("opens the Commit dialog for Commit… on a change list too", async () => {
    useProject.setState({ settings: { vcs: { commit: { nonModal: false } } } as Settings });
    const lists = initialChangelists();
    lists.lists.push({ id: "other", name: "Other", comment: "" });
    lists.files = { "src/a.ts": "other" };
    useChangelists.setState({ state: lists });
    commitChangelist("other");
    await vi.waitFor(() => expect(showCommitDialog).toHaveBeenCalled());
    expect(useCommit.getState().checks.get("/p/src/a.ts")).toBe("all");
    expect(useCommit.getState().checks.get("/p/src/b.ts")).toBe("none");
  });
});

describe("Commit… from Local Changes with the modal interface", () => {
  const status: FileStatus[] = [
    { path: "/p/src/a.ts", relPath: "src/a.ts", staged: null, unstaged: "modified", renamedFrom: null },
    { path: "/p/src/b.ts", relPath: "src/b.ts", staged: null, unstaged: "modified", renamedFrom: null },
    { path: "/p/new.txt", relPath: "new.txt", staged: null, unstaged: "untracked", renamedFrom: null },
  ];
  const tree = document.createElement("div");
  tree.dataset.changesTree = "local";
  const row = document.createElement("button");
  tree.append(row);

  beforeEach(() => {
    showCommitDialog.mockClear();
    document.body.append(tree);
    useProject.setState({ settings: { vcs: { commit: { nonModal: false } } } as Settings });
    useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status });
    useCommit.setState({ checks: new Map(), selection: ["/p/src/b.ts", "/p/new.txt"] });
  });

  it("includes just the files selected there", async () => {
    row.focus();
    commitFromContext();
    await vi.waitFor(() => expect(showCommitDialog).toHaveBeenCalled());
    const checks = useCommit.getState().checks;
    expect([checks.get("/p/src/a.ts"), checks.get("/p/src/b.ts"), checks.get("/p/new.txt")]).toEqual([
      "none",
      "all",
      "all",
    ]);
  });

  it("falls back to the default inclusion when invoked elsewhere", async () => {
    useCommit.setState({ checks: new Map([["/p/src/a.ts", "none"]]) });
    row.blur();
    commitFromContext();
    await vi.waitFor(() => expect(showCommitDialog).toHaveBeenCalled());
    expect(useCommit.getState().checks.size).toBe(0);
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
