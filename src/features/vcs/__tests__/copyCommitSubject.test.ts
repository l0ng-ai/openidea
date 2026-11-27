import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import { executeAction, getAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { IDEA_ACTIONS } from "@/platform/ideaActions";
import { useGitLog } from "../logStore";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({ writeClipboardText: vi.fn(), notify: vi.fn() }));

vi.mock("@/platform/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/clipboard")>()),
  writeClipboardText: mocks.writeClipboardText,
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify }),
}));

import { registerHistoryActions } from "../historyActions";

const commit = (id: string, summary: string, message = summary): Commit => ({
  id: id.repeat(40),
  shortId: id.repeat(8),
  parents: [],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary,
  message,
  refs: [],
});

const newer = commit("b", "Fix the parser", "Fix the parser\n\nThe body is not copied.");
const older = commit("a", "Add a parser");

const originalLog = useGitLog.getState();
const originalVcs = useVcs.getState();
let unregister: (() => void) | undefined;

beforeEach(() => {
  mocks.writeClipboardText.mockReset();
  mocks.notify.mockReset();
  useGitLog.setState({ commits: [newer, older], selected: null, selection: [], shownLog: "log", logTabs: [] });
  useVcs.setState({ root: "/repo", repo: "/repo", roots: ["/repo"], branchesLoaded: true });
  setContext("vcsAvailable", true);
  unregister = registerHistoryActions();
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
  useGitLog.setState(originalLog);
  useVcs.setState(originalVcs);
  setContext("vcsAvailable", false);
});

describe("Copy Commit Subject", () => {
  it("is a Git Log action that IDEA's Vcs.CopyCommitSubjectAction maps to", () => {
    expect(getAction("vcs.log.copyCommitSubject")).toMatchObject({
      title: "Copy Commit Subject",
      category: "Git Log",
    });
    expect(IDEA_ACTIONS["Vcs.CopyCommitSubjectAction"]).toBe("vcs.log.copyCommitSubject");
  });

  it("copies the subjects of the selected commits, one per line, newest first", async () => {
    useGitLog.setState({ selected: older.id, selection: [older.id, newer.id] });
    await executeAction("vcs.log.copyCommitSubject");
    await vi.waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledOnce());
    expect(mocks.writeClipboardText).toHaveBeenCalledWith("Fix the parser\nAdd a parser");
  });

  it("copies the subject, not the message body", async () => {
    useGitLog.setState({ selected: newer.id, selection: [newer.id] });
    await executeAction("vcs.log.copyCommitSubject");
    await vi.waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith("Fix the parser"));
  });

  it("copies the commit it is given and works on read-only commits", async () => {
    await executeAction("vcs.log.copyCommitSubject", { ...older, readOnly: true });
    await vi.waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith("Add a parser"));
  });

  it("copies nothing without a selected commit", async () => {
    await executeAction("vcs.log.copyCommitSubject");
    expect(mocks.writeClipboardText).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Select a commit in the Git log" }));
  });
});
