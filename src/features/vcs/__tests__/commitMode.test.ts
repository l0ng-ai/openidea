import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { CommitMessages, FileStatus, Settings } from "@/bindings";

const vcsLog = vi.fn();
const watchCommitMessages =
  vi.fn<(repo: string, request: number, channel: Channel<CommitMessages>) => Promise<never>>();
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
      vcsWatchCommitMessages: (repo: string, request: number, channel: Channel<CommitMessages>) =>
        watchCommitMessages(repo, request, channel),
    },
  };
});

import { useProject } from "@/platform/project";
import { commitChangelist, commitFiles } from "../changelistsUi";
import { checksForList, initialChangelists, useChangelists } from "../changelists";
import { gitTabs, shownTab, stashTabOf, stashTabs } from "../gitTabs";
import { commitFromContext, pushDialogNeeded } from "../commitUi";
import {
  installCommitMessages,
  keepMessageAfterCommit,
  messageAfterCommit,
  flushDraft,
  savedDraft,
  setAmend,
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
  it("keeps the committed message unless Clear initial commit message is on", () => {
    expect(messageAfterCommit("  fix: thing \n", false)).toBe("fix: thing");
    expect(messageAfterCommit("fix: thing", true)).toBe("");
  });
});

describe("Git commit message suggestions", () => {
  let dispose: () => void;
  let cancelled: number[];

  beforeEach(() => {
    vcsLog.mockResolvedValue({ status: "ok", data: [{ id: "head", message: "Last commit" }] });
    watchCommitMessages.mockReset().mockImplementation(() => new Promise(() => {}));
    cancelled = [];
    mockIPC((cmd, args) => {
      if (cmd === "cancel_request") cancelled.push((args as { id: number }).id);
    });
    localStorage.clear();
    useVcs.setState({ root: "/p", repo: "/p", roots: ["/p"], branch: null, status: [], statusLoaded: true });
    useChangelists.setState({ loaded: false, root: null, state: initialChangelists() });
    useCommit.setState({ message: "", amend: false, checks: new Map() });
    dispose = installCommitMessages();
  });
  afterEach(() => {
    dispose();
    useProject.setState({ settings: null });
    clearMocks();
  });

  const messageChannel = () => watchCommitMessages.mock.calls.at(-1)![2];
  const send = (template: string | null, prepared: string | null = null) =>
    messageChannel().onmessage({ template, prepared });
  const message = () => useCommit.getState().message;

  it("refreshes or clears its own text and keeps the typed draft", () => {
    send("First template");
    expect(message()).toBe("First template");
    send("Edited template");
    expect(message()).toBe("Edited template");
    send(null);
    expect(message()).toBe("");

    send("Another template");
    useCommit.setState({ message: "My draft" });
    send("New template");
    expect(message()).toBe("My draft");
    flushDraft();
    expect(savedDraft("/p")).toBe("My draft");

    keepMessageAfterCommit("My draft", false);
    send("Latest template");
    expect(message()).toBe("My draft");
    keepMessageAfterCommit("My draft", true);
    expect(message()).toBe("Latest template");
    expect(savedDraft("/p")).toBe("");
  });

  it("defers updates while amending and refreshes the restored template", async () => {
    send("First template");
    await setAmend(true);
    expect(message()).toBe("Last commit");
    send("Updated template");
    expect(message()).toBe("Last commit");
    flushDraft();
    expect(savedDraft("/p")).toBe("");
    await setAmend(false);
    expect(message()).toBe("Updated template");
  });

  it("scopes the watch to the selected repository and ignores stopped streams", () => {
    const [, first, oldChannel] = watchCommitMessages.mock.calls[0]!;
    oldChannel.onmessage({ template: "First template", prepared: "Old merge" });
    useVcs.setState({ repo: "/p/nested", roots: ["/p", "/p/nested"] });
    expect(cancelled).toContain(first);
    expect(watchCommitMessages.mock.calls.at(-1)?.[0]).toBe("/p/nested");
    send("Nested template");
    oldChannel.onmessage({ template: "Stale template", prepared: "Stale merge" });
    expect(message()).toBe("Nested template");
  });

  it("updates Git's prepared message in place and restores the current template when it disappears", () => {
    send("First template");
    send("First template", "Merge branch 'x'");
    expect(message()).toBe("Merge branch 'x'");
    send("Updated template", "Updated merge message");
    expect(message()).toBe("Updated merge message");
    flushDraft();
    expect(savedDraft("/p")).toBe("");
    send("Updated template");
    expect(message()).toBe("Updated template");
  });

  it("restores a previous commit message and preserves a draft edited during the operation", () => {
    keepMessageAfterCommit("Last commit", false);
    send("Template", "Merge branch 'x'");
    expect(message()).toBe("Merge branch 'x'");
    send("Template");
    expect(message()).toBe("Last commit");

    send("Template", "Cherry-picked message");
    useCommit.setState({ message: "My own message" });
    send("Template", "Changed prepared message");
    expect(message()).toBe("My own message");
    send("Template");
    expect(message()).toBe("My own message");
    flushDraft();
    expect(savedDraft("/p")).toBe("My own message");
  });

  it("clears the completed operation's message while its removal is still being observed", () => {
    send("Template", "Revert a commit");
    keepMessageAfterCommit("Revert a commit", true);
    expect(message()).toBe("Template");
    expect(savedDraft("/p")).toBe("");
  });

  it.each(["cherry-pick", "revert"] as const)("keeps a stopped %s in its own list", (kind) => {
    const local: FileStatus = {
      path: "/p/local.txt",
      relPath: "local.txt",
      staged: null,
      unstaged: "modified",
      renamedFrom: null,
    };
    const staged: FileStatus = {
      ...local,
      path: "/p/applied.txt",
      relPath: "applied.txt",
      staged: "added",
      unstaged: null,
    };
    const conflict: FileStatus = {
      ...staged,
      path: "/p/conflict.txt",
      relPath: "conflict.txt",
      staged: "conflicted",
    };
    const pending = {
      source: {
        kind,
        repo: "/p",
        commit: "source",
        base: "base",
        author: kind === "cherry-pick" ? "Incoming Author <incoming@example.invalid>" : null,
        authorDate: kind === "cherry-pick" ? "2022-06-04T13:20:21+05:30" : null,
      },
      paths: [staged.path, conflict.path],
    };
    const status = [local, staged, conflict];
    const state = initialChangelists();
    state.lists.push({ id: "feature", name: "Incoming fix", comment: "Local feature" });
    state.files = { [local.relPath]: "default" };
    useChangelists.setState({ loaded: true, root: "/p", state });
    useCommit.setState({ message: "My local draft" });
    useVcs.setState({ status: [local] });
    const sendApply = () =>
      messageChannel().onmessage({
        template: "Commit template",
        prepared: "Incoming fix\n\nDetails",
        pendingApply: pending,
      });
    sendApply();
    useVcs.setState({ status });
    expect(useChangelists.getState().state).toBe(state);
    expect(message()).toBe("My local draft");

    useProject.setState({ settings: { vcs: { createChangelistsAutomatically: true } } as Settings });
    const lists = useChangelists.getState().state;
    const picked = lists.lists.find((list) => list.appliedCommit)!;
    expect(picked.name).toBe("Incoming fix-1");
    expect(lists.active).toBe("default");
    expect(lists.files).toEqual({ "local.txt": "default", "applied.txt": picked.id, "conflict.txt": picked.id });
    expect(message()).toBe("My local draft");
    sendApply();
    expect(useChangelists.getState().state).toBe(lists);
    useCommit.setState({ checks: checksForList(status, "/p", lists, picked.id) });
    expect(message()).toBe("Incoming fix\n\nDetails");
    expect(useCommit.getState()).toMatchObject({
      author: pending.source.author ?? "",
      authorDate: pending.source.authorDate,
    });
    useCommit.setState({ checks: checksForList(status, "/p", lists, "default") });
    expect(message()).toBe("My local draft");
    expect(useCommit.getState()).toMatchObject({ author: "", authorDate: null });
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
