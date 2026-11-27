import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compareWithFileRevision } from "../FileRevisionChooser";
import { hasFileHistory, trackFileHistory } from "../fileRevisions";
import { VcsDialogHost } from "../dialogs";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({ files: vi.fn(), log: vi.fn(), cancel: vi.fn(), diff: vi.fn() }));
vi.mock("../diffInput", () => ({ openVcsDiff: mocks.diff }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, vcsRevisionFiles: mocks.files, vcsLog: mocks.log, cancelRequest: mocks.cancel },
  };
});

let stopTracking: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  useVcs.setState({ roots: ["/repo"], statusLoaded: true, heads: {}, byPath: new Map() });
  mocks.files.mockResolvedValue({ status: "ok", data: ["file.txt"] });
  stopTracking = trackFileHistory();
  await waitFor(() => expect(hasFileHistory("/repo/file.txt")).toBe(true));
  mocks.cancel.mockResolvedValue({ status: "ok", data: null });
  mocks.log.mockResolvedValue({
    status: "ok",
    data: [
      {
        id: "a".repeat(40),
        shortId: "aaaaaaa",
        author: "Alice",
        timeMs: 1700000000000,
        summary: "Initial file",
        historyPath: "old.txt",
      },
      {
        id: "b".repeat(40),
        shortId: "bbbbbbb",
        author: "Bob",
        timeMs: 1700100000000,
        summary: "Rename file",
        historyPath: "file.txt",
      },
    ],
  });
});
afterEach(() => {
  stopTracking();
  const dialog = screen.queryByRole("dialog");
  if (dialog) fireEvent.keyDown(dialog, { key: "Escape" });
});

it.each(["Alice", "aaaaaaa", "Initial file"])(
  "searches by %s and compares the renamed historical path against the working copy",
  async (query) => {
    render(<VcsDialogHost />);
    compareWithFileRevision("/repo/file.txt");
    const input = await screen.findByRole("textbox", { name: "Search file revisions" });
    await waitFor(() =>
      expect(mocks.log).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({
          path: "/repo/file.txt",
          follow: true,
          limit: 0,
        }),
      ),
    );
    fireEvent.change(input, { target: { value: query } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mocks.diff).toHaveBeenCalledWith({
        path: "/repo/file.txt",
        left: { type: "rev", rev: "a".repeat(40), label: "aaaaaaa", path: "/repo/old.txt" },
        right: { type: "worktree" },
      }),
    );
  },
);

it("does not open a diff when cancelled", async () => {
  render(<VcsDialogHost />);
  compareWithFileRevision("/repo/file.txt");
  fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
  expect(mocks.diff).not.toHaveBeenCalled();
});

it("cancels a pending file-history request when closed", async () => {
  mocks.log.mockReturnValue(new Promise(() => {}));
  render(<VcsDialogHost />);
  compareWithFileRevision("/repo/file.txt");
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(mocks.log).toHaveBeenCalled());
  const request = mocks.log.mock.calls[0]![1].request;
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(request));
  expect(mocks.diff).not.toHaveBeenCalled();
});
