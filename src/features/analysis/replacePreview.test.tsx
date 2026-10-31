import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StructuralFile, WorkspaceEdit } from "@/platform/ipc";
import { provideNotificationService } from "@/workbench/contributions";
import { AnalysisDialogHost } from "./dialogs";
import { showReplacePreview } from "./AnalysisDialogs";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), apply: vi.fn(), synced: vi.fn(), notify: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, prepareWorkspaceEdit: mocks.prepare, applyWorkspaceEdit: mocks.apply },
  };
});
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  whenAllSynced: mocks.synced,
}));
const files: StructuralFile[] = ["a.ts", "b.ts"].map((name) => ({
  path: `/p/${name}`,
  relPath: name,
  matches: [
    {
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 3 } },
      text: "old",
      lineText: "old",
      replacement: "new",
    },
  ],
}));
const preconditions = files.map((f) => ({ path: f.path, hash: `preview:${f.path}` }));
beforeEach(() => {
  mocks.prepare
    .mockReset()
    .mockImplementation(async (edit: WorkspaceEdit) => ({ status: "ok", data: { ...edit, preconditions } }));
  mocks.apply.mockReset().mockResolvedValue({ status: "ok", data: null });
  mocks.synced.mockReset().mockResolvedValue(undefined);
  mocks.notify.mockReset();
  provideNotificationService({ notify: mocks.notify });
});
afterEach(() => {
  if (screen.queryByRole("button", { name: "Cancel" })) fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  cleanup();
});

it("captures guards before preview and preserves them when the user excludes a file", async () => {
  render(<AnalysisDialogHost />);
  await act(() => showReplacePreview(files));
  expect(mocks.prepare).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("checkbox", { name: "Replace in b.ts:1" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledOnce());
  expect(mocks.apply.mock.calls[0]![0]).toEqual({
    files: [{ kind: "edit", path: "/p/a.ts", edits: [{ range: files[0]!.matches[0]!.range, new_text: "new" }] }],
    preconditions,
  });
  expect(mocks.synced).toHaveBeenCalledOnce();
});

it("reports a stale preview without refreshing guards or retrying the edits", async () => {
  mocks.apply.mockResolvedValue({
    status: "error",
    error: { kind: "outOfSync", message: "a.ts changed; request again" },
  });
  render(<AnalysisDialogHost />);
  await act(() => showReplacePreview(files));
  fireEvent.click(screen.getByRole("button", { name: "Replace" }));
  await waitFor(() =>
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Replace Structurally", body: "a.ts changed; request again" }),
    ),
  );
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.apply).toHaveBeenCalledOnce();
});
