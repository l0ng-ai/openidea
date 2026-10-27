import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DirectoryHistory, HistoryEntry } from "@/bindings";

const historyListDir = vi.fn();
const historyRestore = vi.fn();
const historyPutLabel = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      historyListDir: (p: string) => historyListDir(p),
      historyRestore: (p: string, id: string) => historyRestore(p, id),
      historyPutLabel: (l: string) => historyPutLabel(l),
    },
  };
});
vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { data: { left: { label?: string }; right: { label?: string } } } }) => (
    <div data-testid="diff">
      {input.data.left.label} | {input.data.right.label}
    </div>
  ),
}));

import { useProject } from "@/platform/project";
import { LocalHistoryEditor, localHistoryInput, revisionRange, snapshotsBefore } from "../LocalHistory";
import { putLabel } from "../localHistoryActions";
import { VcsDialogHost } from "../dialogs";
import { MessagesHost } from "@/workbench/messages";

const id = (c: string) => c.repeat(64);
const snap = (path: string, t: number, label: string, c: string): HistoryEntry => ({
  id: id(c),
  path,
  timestampMs: t,
  label,
  size: 3,
  kind: "snapshot",
});
const label = (t: number, name: string): HistoryEntry => ({
  id: "",
  path: "/p",
  timestampMs: t,
  label: name,
  size: 0,
  kind: "label",
});

beforeEach(() => {
  historyListDir.mockReset();
  historyRestore.mockReset().mockResolvedValue({ status: "ok", data: null });
  historyPutLabel.mockReset().mockResolvedValue({ status: "ok", data: null });
  useProject.setState({ project: { root: "/p", name: "p" } as never });
});

describe("Local History", () => {
  it("finds each file's revision at a label", () => {
    const entries = [
      snap("/p/a", 1, "Saved", "a"),
      snap("/p/a", 3, "Saved", "b"),
      snap("/p/b", 2, "Saved", "c"),
      label(4, "L"),
    ];
    const at = snapshotsBefore(entries, 2.5);
    expect([...at.keys()].sort()).toEqual(["/p/a", "/p/b"]);
    expect(at.get("/p/a")!.id).toBe(id("a"));
  });

  it("shows a folder's history with deleted files and reverts to a label", async () => {
    const data: DirectoryHistory = {
      entries: [
        label(50, "Before Git checkout"),
        snap("/p/src/gone.ts", 40, "Deleted", "d"),
        snap("/p/src/a.ts", 30, "External change", "e"),
        snap("/p/src/a.ts", 10, "Saved", "f"),
      ],
      deleted: ["/p/src/gone.ts"],
    };
    historyListDir.mockResolvedValue({ status: "ok", data });
    render(
      <>
        <LocalHistoryEditor input={localHistoryInput("/p/src")} />
        <VcsDialogHost />
        <MessagesHost />
      </>,
    );
    const list = await screen.findByRole("listbox", { name: "Revisions" });
    expect(historyListDir).toHaveBeenCalledWith("/p/src");
    expect(list).toHaveTextContent("Before Git checkout");
    expect(list).toHaveTextContent("src/gone.ts");
    expect(screen.getByText(/Label 'Before Git checkout' · 2 files recorded before it/)).toBeInTheDocument();

    // Revert at the label restores every file's last revision before it.
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    const confirm = await screen.findByRole("dialog", { name: "Revert" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(historyRestore).toHaveBeenCalledTimes(2));
    expect(historyRestore.mock.calls.map((c) => c.join(" ")).sort()).toEqual([
      `/p/src/a.ts ${id("e")}`,
      `/p/src/gone.ts ${id("d")}`,
    ]);

    // A deleted file's row offers Restore.
    fireEvent.click(within(list).getAllByRole("option")[1]!);
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByTestId("diff")).toBeInTheDocument();
  });

  it("picks the oldest and newest of several selected revisions of one file", () => {
    const entries = [snap("/p/a", 3, "C", "c"), label(2, "L"), snap("/p/a", 1, "B", "b"), snap("/p/b", 0, "X", "x")];
    expect(revisionRange(entries, [2, 0, 1])).toMatchObject({ newer: { label: "C" }, older: { label: "B" } });
    expect(revisionRange(entries, [0])).toBeNull();
    expect(revisionRange(entries, [0, 1])).toBeNull();
    // Revisions of different files have nothing to diff.
    expect(revisionRange(entries, [0, 3])).toBeNull();
  });

  it("diffs two revisions selected with Shift- or Cmd-click", async () => {
    const data: DirectoryHistory = {
      entries: [
        snap("/p/a.ts", 30, "Third", "c"),
        snap("/p/a.ts", 20, "Second", "b"),
        snap("/p/a.ts", 10, "First", "a"),
      ],
      deleted: [],
    };
    historyListDir.mockResolvedValue({ status: "ok", data });
    render(<LocalHistoryEditor input={localHistoryInput("/p/a.ts")} />);
    const list = await screen.findByRole("listbox", { name: "Revisions" });
    const rows = () => within(list).getAllByRole("option");
    const click = (i: number, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) => {
      fireEvent.mouseDown(rows()[i]!, { button: 0, ...mods });
      fireEvent.click(rows()[i]!, mods);
    };
    expect(screen.getByTestId("diff")).toHaveTextContent(/Third \| Current/);

    click(2, { shiftKey: true });
    expect(rows().filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(3);
    expect(screen.getByTestId("diff")).toHaveTextContent(/First \| .*Third/);

    click(1);
    click(0, { metaKey: true });
    expect(screen.getByTestId("diff")).toHaveTextContent(/Second \| .*Third/);

    // Keyboard navigation goes back to a single revision.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByTestId("diff")).toHaveTextContent(/Second \| Current/);
  });

  it("puts a label", async () => {
    render(<VcsDialogHost />);
    const done = putLabel();
    const dialog = await screen.findByRole("dialog", { name: "Put Label" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Before refactoring" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(await done).toBe(true);
    expect(historyPutLabel).toHaveBeenCalledWith("Before refactoring");
  });
});
