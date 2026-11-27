import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FileStatus, Stash } from "@/bindings";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  expire: vi.fn(),
  executeAction: vi.fn(),
  apply: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.executeAction,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: mocks.notify, expire: mocks.expire }),
  maybeEditorService: () => null,
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: { ...real.commands, vcsStashApply: mocks.apply, vcsStashes: mocks.list },
  };
});

import { applyStash } from "../changeOps";
import { clearUnstashConflictNotices, showConflictsDialog } from "../conflictsUi";
import { VcsDialogHost } from "../dialogs";
import { useVcs } from "../store";

const stash: Stash = { index: 1, id: "stash-id", base: "base-id", message: "On main: Selected stash", timeMs: null };
const file = (relPath: string, unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/p/${relPath}`,
  relPath,
  staged: null,
  unstaged,
  renamedFrom: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ status: "ok", data: [stash] });
  mocks.apply.mockResolvedValue({
    status: "error",
    error: { kind: "io", message: "The stash cannot be applied" },
  });
  mocks.executeAction.mockImplementation(async (id: string, arg?: unknown) => {
    if (id === "vcs.resolveConflicts") showConflictsDialog(arg);
    return true;
  });
  useVcs.setState({
    root: "/p",
    repo: "/p/worker",
    roots: ["/p/app", "/p/worker"],
    heads: {},
    operations: {},
    available: false,
    status: [],
    resolvedConflicts: new Set(),
  });
});

afterEach(() => {
  const close = screen.queryByText("Close", { selector: "button" });
  if (close) fireEvent.click(close);
  clearUnstashConflictNotices();
});

it("opens a stash-specific conflict list for the repository reported by Git", async () => {
  useVcs.setState({
    status: [file("app/from-stash.txt", "conflicted"), file("worker/from-merge.txt", "conflicted")],
    resolvedConflicts: new Set(["/p/worker/already-resolved.txt"]),
  });
  mocks.list.mockResolvedValue({ status: "ok", data: [{ ...stash, index: 0 }] });
  mocks.apply.mockResolvedValue({
    status: "ok",
    data: { index: 0, outcome: { kind: "conflicts", repository: "/p/app" } },
  });
  render(createElement(VcsDialogHost));
  await act(() => applyStash(stash, true, null));

  expect(mocks.apply).toHaveBeenCalledWith(null, stash, true, false, null);
  const dialog = within(screen.getByRole("dialog", { name: "Conflicts" }));
  expect(dialog.getByText("Conflicts during unstashing stash@{0}: Selected stash")).toBeInTheDocument();
  expect(dialog.getByText("from-stash.txt")).toBeInTheDocument();
  expect(dialog.queryByText("from-merge.txt")).toBeNull();
  expect(dialog.queryByText("already-resolved.txt")).toBeNull();
  expect(mocks.notify).not.toHaveBeenCalled();

  fireEvent.click(dialog.getByText("Close", { selector: "button" }));
  const notice = mocks.notify.mock.lastCall?.[0];
  expect(notice).toMatchObject({
    title: "Unstash has unresolved conflicts",
    body: "stash@{0}: Selected stash",
    key: "vcs.unstash-conflicts:/p/app",
    sticky: true,
  });
  await act(async () => notice.actions[0].run());
  const reopened = within(screen.getByRole("dialog", { name: "Conflicts" }));
  expect(reopened.getByText("from-stash.txt")).toBeInTheDocument();
  expect(reopened.queryByText("from-merge.txt")).toBeNull();
  fireEvent.click(reopened.getByText("Close", { selector: "button" }));
  const retry = mocks.notify.mock.lastCall?.[0].actions[0];
  mocks.expire.mockClear();

  act(() => useVcs.setState({ status: [file("worker/from-merge.txt", "conflicted")] }));
  expect(mocks.expire).toHaveBeenCalledExactlyOnceWith("vcs.unstash-conflicts:/p/app");
  await act(async () => retry.run());
  expect(screen.queryByRole("dialog")).toBeNull();

  act(() => showConflictsDialog());
  const global = within(screen.getByRole("dialog", { name: "Conflicts" }));
  for (const name of ["from-merge.txt", "already-resolved.txt"]) expect(global.getByText(name)).toBeInTheDocument();
  expect(global.queryByText("from-stash.txt")).toBeNull();
});

it("reports a failed unstash even if the target and another repository already have conflicts", async () => {
  useVcs.setState({
    status: [file("app/from-merge.txt", "conflicted"), file("worker/from-merge.txt", "conflicted")],
  });
  await applyStash(stash, false, "/p/app");
  expect(mocks.executeAction).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", title: "Apply stash@{1} failed", body: "The stash cannot be applied" }),
  );
});

it("reports the selected stash disappearing without applying a replacement", async () => {
  mocks.list.mockResolvedValue({ status: "ok", data: [{ ...stash, id: "different" }] });
  mocks.apply.mockResolvedValue({
    status: "error",
    error: { kind: "invalidInput", message: "The selected stash is no longer available" },
  });
  await applyStash(stash, false, "/p/app");
  expect(mocks.apply).toHaveBeenCalledExactlyOnceWith("/p/app", stash, false, false, null);
  expect(mocks.executeAction).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", body: "The selected stash is no longer available" }),
  );
});
