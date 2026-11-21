import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DirectoryCompareEntry } from "@/bindings";

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  cancel: vi.fn(),
  copy: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsCompareDirectories: mocks.compare,
      fsCopyMerge: mocks.copy,
      fsDelete: mocks.remove,
      cancelRequest: mocks.cancel,
    },
  };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: unknown }) => <div data-testid="diff">{JSON.stringify(input)}</div>,
}));
vi.mock("../dialogs", () => ({ confirmDialog: mocks.confirm, openDialog: vi.fn(), promptText: vi.fn() }));
vi.mock("../diffInput", async (original) => ({
  ...(await original<typeof import("../diffInput")>()),
  openDiff: mocks.open,
  openVcsDiff: mocks.open,
}));
import { DirectoryCompare, directoryDiff, directoryRows } from "../DirectoryCompare";
import { directoryCompareTitle } from "../directoryCompareKind";

const row = (
  path: string,
  status: DirectoryCompareEntry["status"],
  leftKind: DirectoryCompareEntry["leftKind"] = "file",
  rightKind: DirectoryCompareEntry["rightKind"] = "file",
): DirectoryCompareEntry => ({ path, status, leftKind, rightKind });
const rows = [
  row("nested", "different", "dir", "dir"),
  row("nested/中文.txt", "different"),
  row("only-left.txt", "leftOnly", "file", null),
  row("only-right.txt", "rightOnly", null, "file"),
  row("same.txt", "equal"),
  row("empty", "leftOnly", "dir", null),
];
const ok = (data: unknown = null) => ({ status: "ok", data });
const setup = () => render(<DirectoryCompare left="/p/left" right="/p/right" />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.compare.mockResolvedValue(ok(rows));
  mocks.copy.mockResolvedValue(ok());
  mocks.remove.mockResolvedValue(ok());
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe("disk directory comparison", () => {
  it("lays both sides out in columns, filters by status and name", async () => {
    mocks.compare.mockResolvedValue(
      ok([...rows.slice(0, 2), { ...rows[2]!, leftSize: 2048, leftModified: Date.UTC(2026, 0, 2) }, ...rows.slice(3)]),
    );
    setup();
    expect(await screen.findAllByText("中文.txt")).toHaveLength(2);
    expect(screen.getAllByRole("columnheader", { name: "Size" })).toHaveLength(2);
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Only on left")).toHaveLength(2);
    expect(screen.getByLabelText("Only on right")).toBeInTheDocument();
    expect(screen.queryByText("same.txt")).toBeNull();
    const identical = screen.getByRole("button", { name: "Show identical files" });
    expect(identical).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(identical);
    expect(screen.getAllByText("same.txt")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show files only on left" }));
    expect(screen.queryByText("only-left.txt")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter by name" }), { target: { value: "中文" } });
    expect(screen.queryByText("same.txt")).toBeNull();
    expect(screen.getAllByText("nested")).toHaveLength(2);
    fireEvent.mouseDown(screen.getAllByText("nested")[0]!, { button: 0 });
    expect(screen.getByRole("button", { name: "Copy to Right" })).toBeEnabled();
  });

  it("groups files under their folder and keeps one-sided folders whole", () => {
    const all = new Set(["leftOnly", "rightOnly", "different", "equal"] as const);
    const entries = [
      row("a.txt", "different"),
      row("dir", "different", "dir", "dir"),
      row("dir/b.txt", "different"),
      row("dir/sub", "different", "dir", "dir"),
      row("dir/sub/c.txt", "rightOnly", null, "file"),
      row("gone", "leftOnly", "dir", null),
      row("gone/inside.txt", "leftOnly", "file", null),
      row("z.txt", "equal"),
    ];
    const label = (r: ReturnType<typeof directoryRows>[number]) =>
      "section" in r ? `[${r.section}]` : r.folder ? `<${r.entry.path}>` : r.entry.path;
    expect(directoryRows(entries, all, "").map(label)).toEqual([
      "a.txt",
      "gone",
      "z.txt",
      "<dir>",
      "dir/b.txt",
      "<dir/sub>",
      "dir/sub/c.txt",
    ]);
    expect(directoryRows(entries, all, "inside").map(label)).toEqual(["gone"]);
    // A match nested deeper inside a one-sided folder still shows that folder's row (#4085).
    const nested = [
      row("only-left", "leftOnly", "dir", null),
      row("only-left/sub", "leftOnly", "dir", null),
      row("only-left/sub/nested.txt", "leftOnly", "file", null),
    ];
    expect(directoryRows(nested, new Set(["leftOnly"]), "nested.txt").map(label)).toEqual(["only-left"]);
    expect(directoryRows(entries, new Set(["rightOnly"]), "").map(label)).toEqual(["<dir/sub>", "dir/sub/c.txt"]);
  });

  it("names the tab after both folders, with their parents when the names are equal", () => {
    expect(directoryCompareTitle({ left: "/p/left", right: "/p/right/" })).toBe("left ↔ right");
    expect(directoryCompareTitle({ left: "/x/project-a/config", right: "/x/project-b/config" })).toBe(
      "project-a/config ↔ project-b/config",
    );
  });

  it("previews the selection below the table and opens the diff on double click, including missing sides", async () => {
    setup();
    fireEvent.mouseDown((await screen.findAllByText("中文.txt"))[0]!, { button: 0 });
    expect(await screen.findByTestId("diff")).toHaveTextContent("/p/left/nested/中文.txt");
    fireEvent.doubleClick(screen.getAllByText("中文.txt")[0]!);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ path: "/p/right/nested/中文.txt" }));
    expect(directoryDiff("/l", "/r", rows[2]!)?.right.type).toBe("text");
    expect(directoryDiff("/l", "/r", rows[3]!)?.left.type).toBe("text");
    expect(directoryDiff("/l", "/r", row("type", "different", "file", "dir"))).toBeNull();
    expect(
      directoryDiff("/l", "/r", {
        ...row("link", "different", "symlink", "symlink"),
        leftLink: "one",
        rightLink: "two",
      }),
    ).toMatchObject({
      left: { type: "text", text: "one" },
      right: { type: "text", text: "two" },
    });
  });

  it.each(["Copy to Left", "Copy to Right"])(
    "confirms before overwriting, refreshes and restores selection after %s",
    async (label) => {
      mocks.copy
        .mockResolvedValueOnce({ status: "error", error: { kind: "alreadyExists", message: "exists" } })
        .mockResolvedValueOnce(ok());
      setup();
      fireEvent.mouseDown((await screen.findAllByText("中文.txt"))[0]!, { button: 0 });
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() =>
        expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Overwrite files?" })),
      );
      await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
      expect(mocks.copy.mock.calls[0]![3]).toBe(false);
      expect(mocks.copy.mock.calls[1]![3]).toBe(true);
      expect(mocks.copy.mock.calls[0]!.slice(0, 3)).toEqual(
        label === "Copy to Left"
          ? ["/p/right", "/p/left", "nested/中文.txt"]
          : ["/p/left", "/p/right", "nested/中文.txt"],
      );
      expect(await screen.findByTestId("diff")).toBeInTheDocument();
    },
  );

  it("does not overwrite when confirmation is declined and reports operation errors", async () => {
    mocks.copy.mockResolvedValue({ status: "error", error: { kind: "alreadyExists", message: "exists" } });
    mocks.confirm.mockResolvedValue(false);
    setup();
    fireEvent.mouseDown((await screen.findAllByText("中文.txt"))[0]!, { button: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Copy to Right" }));
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    mocks.copy.mockResolvedValue({ status: "error", error: { kind: "permissionDenied", message: "Cannot write" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy to Right" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot write");
  });

  it("copies empty and nonempty subdirectories and confirms deletion only for one-sided entries", async () => {
    setup();
    fireEvent.mouseDown((await screen.findAllByText("nested"))[0]!, { button: 0 });
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy to Right" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith("/p/left", "/p/right", "nested", false));
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
    fireEvent.mouseDown(screen.getByText("empty"), { button: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Copy to Right" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith("/p/left", "/p/right", "empty", false));
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(3));
    fireEvent.mouseDown(screen.getByText("only-left.txt"), { button: 0 });
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("/p/left/only-left.txt"));
  });

  it("compares by the chosen mode, recomparing and remembering it", async () => {
    localStorage.removeItem("openidea.directoryCompare.mode");
    const view = setup();
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(1));
    expect(mocks.compare.mock.calls[0]![2]).toBe("content");
    fireEvent.click(screen.getByRole("button", { name: "Compare by" }));
    fireEvent.click(await screen.findByRole("option", { name: "Size and timestamp" }));
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2));
    expect(mocks.compare.mock.calls[1]![2]).toBe("sizeAndTimestamp");
    view.unmount();
    setup();
    await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(3));
    expect(mocks.compare.mock.calls[2]![2]).toBe("sizeAndTimestamp");
    localStorage.removeItem("openidea.directoryCompare.mode");
  });

  it("streams progress, cancels on demand and on close, and ignores stale results after refresh", async () => {
    let resolve!: (value: unknown) => void;
    mocks.compare.mockImplementationOnce((_l, _r, _mode, _request, channel) => {
      channel.onmessage({ scanned: 20, compared: 5, total: 10, bytesRead: 100, path: "big" });
      return new Promise((r) => {
        resolve = r;
      });
    });
    const view = setup();
    expect(await screen.findByText("Compared 5 of 10 entries")).toBeInTheDocument();
    const request = mocks.compare.mock.calls[0]![3];
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.cancel).toHaveBeenCalledWith(request);
    view.unmount();
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    resolve(ok(rows));
  });
});
