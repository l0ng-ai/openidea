import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

const vcsLog = vi.fn();
const vcsCommitFiles = vi.fn();
const vcsConfigGet = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
      vcsCommitFiles: (repo: unknown, head: unknown) => vcsCommitFiles(repo, head),
      vcsConfigGet: (repo: unknown, key: string) => vcsConfigGet(repo, key),
      fsReadText: async () => ({ status: "error", error: { kind: "notFound", message: "" } }),
    },
  };
});

import {
  captureCommitDraft,
  flushDraft,
  installCommitMessages,
  keepMessageAfterCommit,
  savedDraft,
  setAmend,
  setChangelistDraft,
  setCommitAuthor,
  useCommit,
} from "../commitStore";
import { checksForList, DEFAULT_LIST_ID, initialChangelists, useChangelists } from "../changelists";
import { useVcs } from "../store";

describe("commit message draft (#4423)", () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [{ id: "head", message: "last commit\n" }] });
    vcsCommitFiles.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vcsConfigGet.mockReset().mockResolvedValue({ status: "ok", data: null });
    useVcs.setState({ root: "/a", repo: null, roots: ["/a"], branch: null, status: [] });
    useChangelists.setState({ root: null, loaded: false, state: initialChangelists() });
    useCommit.setState({
      message: "",
      messageChangelist: DEFAULT_LIST_ID,
      checks: new Map(),
      amend: false,
      amendPreview: null,
      author: "",
    });
    dispose = installCommitMessages();
  });
  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  const type = (message: string) => useCommit.setState({ message });
  const message = () => useCommit.getState().message;
  const loadLists = (active = DEFAULT_LIST_ID) => {
    const root = "/a";
    const state = initialChangelists();
    state.active = active;
    state.lists.push({ id: "feature", name: "New feature", comment: "Start from the changelist notes" });
    state.files = { "default.txt": DEFAULT_LIST_ID, "feature.txt": "feature" };
    const status: FileStatus[] = Object.keys(state.files).map((relPath) => ({
      relPath,
      path: `${root}/${relPath}`,
      staged: null,
      unstaged: "modified",
      renamedFrom: null,
    }));
    useVcs.setState({ status });
    useChangelists.setState({ root, loaded: true, state });
    return (id: string) => useCommit.setState({ checks: checksForList(status, root, state, id) });
  };

  it("is saved per project after a pause, not on every keystroke", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    type("f");
    type("fi");
    type("fix: draft");
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(savedDraft("/a")).toBe("fix: draft");
    setItem.mockRestore();
  });

  it("is restored when the project opens again (restart)", () => {
    type("wip");
    window.dispatchEvent(new Event("pagehide"));
    expect(savedDraft("/a")).toBe("wip");
    dispose();
    useCommit.setState({ message: "" });
    dispose = installCommitMessages();
    expect(useCommit.getState().message).toBe("wip");
  });

  it("stays with its project when the window switches to another one", () => {
    type("for a");
    useVcs.setState({ root: "/b", roots: ["/b"] });
    expect(savedDraft("/a")).toBe("for a");
    expect(useCommit.getState().message).toBe("");
    type("for b");
    useVcs.setState({ root: "/a", roots: ["/a"] });
    expect(useCommit.getState().message).toBe("for a");
    expect(savedDraft("/b")).toBe("for b");
  });

  it("is cleared by a successful commit, whether or not the message stays in the field", () => {
    type("feat: x");
    flushDraft();
    keepMessageAfterCommit("feat: x", false);
    flushDraft();
    expect(savedDraft("/a")).toBe("");
    type("feat: y");
    flushDraft();
    keepMessageAfterCommit("feat: y", true);
    flushDraft();
    expect(savedDraft("/a")).toBe("");
  });

  it("switches drafts with the included changes and remembers when a suggestion was cleared", () => {
    const include = loadLists();
    type("Default draft");
    include("feature");
    expect(message()).toBe("Start from the changelist notes");
    expect(savedDraft("/a")).toBe("Default draft");
    type("Feature draft");
    include(DEFAULT_LIST_ID);
    expect(message()).toBe("Default draft");
    include("feature");
    expect(message()).toBe("Feature draft");
    type("");
    include(DEFAULT_LIST_ID);
    include("feature");
    expect(message()).toBe("");
    expect(useChangelists.getState().state.lists[1]?.comment).toBe("Start from the changelist notes");
  });

  it("restores the legacy draft to the default list when a named list loads as active", () => {
    dispose();
    localStorage.setItem("openidea.vcs.commitDraft:/a", "Legacy draft");
    const include = loadLists("feature");
    dispose = installCommitMessages();
    expect(message()).toBe("Start from the changelist notes");
    include(DEFAULT_LIST_ID);
    expect(message()).toBe("Legacy draft");
  });

  it("clears the completed list's draft even if another list is selected while Git runs", () => {
    const include = loadLists();
    type("Default draft");
    include("feature");
    type("Feature commit");
    const pending = captureCommitDraft();
    include(DEFAULT_LIST_ID);
    keepMessageAfterCommit("Feature commit", false, pending);
    expect(message()).toBe("Default draft");
    expect(savedDraft("/a", "feature")).toBe("");
  });

  it("keeps a newer draft written while the commit was running", () => {
    const include = loadLists();
    include("feature");
    type("Feature commit");
    const pending = captureCommitDraft();
    type("Newer draft");
    keepMessageAfterCommit("Feature commit", true, pending);
    expect(message()).toBe("Newer draft");
    expect(savedDraft("/a", "feature")).toBe("Newer draft");
  });

  it("saves an undone commit's message with the list receiving its changes", () => {
    const include = loadLists();
    type("Default draft");
    setChangelistDraft("feature", "Undone commit");
    expect(message()).toBe("Default draft");
    include("feature");
    expect(message()).toBe("Undone commit");
  });

  it("keeps author and author date with the changelist across a reload", () => {
    const include = loadLists();
    const base = { author: "Base <base@example.test>", authorDate: "2021-05-03T08:30:00+02:00" };
    const feature = { author: "Feature <feature@example.test>", authorDate: "2022-06-04T13:20:21-04:00" };
    setCommitAuthor(base);
    include("feature");
    expect(useCommit.getState()).toMatchObject({ author: "", authorDate: null });
    setCommitAuthor(feature);
    include(DEFAULT_LIST_ID);
    expect(useCommit.getState()).toMatchObject(base);

    dispose();
    useCommit.setState({ author: "", authorDate: null });
    dispose = installCommitMessages();
    expect(useCommit.getState()).toMatchObject(base);
    include("feature");
    expect(useCommit.getState()).toMatchObject(feature);
  });

  it("uses a temporary date override for Amend with the existing author-edit workflow", async () => {
    const scoped = { author: "Draft Author <draft@example.test>", authorDate: "2021-05-03T08:30:00+02:00" };
    setCommitAuthor(scoped);
    await setAmend(true);
    expect(useCommit.getState().authorDate).toBeNull();
    setCommitAuthor({ author: "Amend Author <amend@example.test>", authorDate: "2022-06-04T13:20:21-04:00" });
    await setAmend(false);
    expect(useCommit.getState()).toMatchObject({
      author: "Amend Author <amend@example.test>",
      authorDate: scoped.authorDate,
    });

    await setAmend(true);
    setCommitAuthor({ authorDate: "2024-07-05T14:21:00-05:00" });
    keepMessageAfterCommit("last commit", false);
    expect(useCommit.getState()).toMatchObject({ author: "", authorDate: scoped.authorDate, amend: false });
  });

  it("keeps the typed draft, not the amended commit's message, while Amend is on", async () => {
    type("my draft");
    flushDraft();
    await setAmend(true);
    expect(useCommit.getState().message).toBe("last commit");
    flushDraft();
    expect(savedDraft("/a")).toBe("my draft");
    await setAmend(false);
    expect(useCommit.getState().message).toBe("my draft");
    flushDraft();
    expect(savedDraft("/a")).toBe("my draft");
  });

  it("discards original commit files from an Amend mode that ended during the request", async () => {
    let complete!: (result: { status: string; data: { path: string }[] }) => void;
    vcsCommitFiles.mockImplementation(() => new Promise((resolve) => (complete = resolve)));
    const pending = setAmend(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(vcsCommitFiles).toHaveBeenCalledWith("/a", "head");
    await setAmend(false);
    vcsLog.mockResolvedValue({ status: "ok", data: [{ id: "new-head", message: "new commit" }] });
    vcsCommitFiles.mockResolvedValue({ status: "ok", data: [{ path: "current.txt" }] });
    await setAmend(true);
    complete({ status: "ok", data: [{ path: "outdated.txt" }] });
    await pending;
    expect(useCommit.getState()).toMatchObject({
      amend: true,
      message: "new commit",
      amendPreview: { status: "ready", head: { id: "new-head" }, files: [{ path: "current.txt" }] },
    });
  });

  it("recognizes author name variants independently of the original committer", async () => {
    vcsConfigGet.mockImplementation(async (_, key) => ({
      status: "ok",
      data: key === "user.name" ? "Ada Lovelace" : key === "user.email" ? "ada@example.test" : null,
    }));
    vcsLog.mockResolvedValue({
      status: "ok",
      data: [
        {
          id: "head",
          message: "last commit",
          author: "ADA.LOVELACE",
          email: "work@example.test",
          committer: "Maintainer",
          committerEmail: "maintainer@example.test",
        },
      ],
    });
    await setAmend(true);
    expect(useCommit.getState()).toMatchObject({ author: "", amendPreview: { differentCommitter: true } });
    await setAmend(false);
  });
});
